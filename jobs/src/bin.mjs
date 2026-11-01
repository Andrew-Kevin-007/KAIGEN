#!/usr/bin/env node
// kaigen-jobs <command>
//   hinomi     snapshot the exposure index and append to history
//   keeper     trip every known vault if the era has risen  (--loop to repeat)
//   watch      check the omen bounty addresses for outflows
//   firetest   run the drill rehearsal and publish its record
//   verify     check the public claims against mainnet     (exit code 1 on any failure)
//              --release: the mainnet gate (two RPC hosts, one block, writes a gate file); --pre-lock before the lock
//   mainnet    help | gates | plan | execute --stage N --yes | lock --i-understand-this-is-irreversible
//              dry-run by default; nothing is sent without the confirmation flag and a key file (KAIGEN_DEPLOYER_KEY_FILE)
//
// Config: deployments.json (path in KAIGEN_DEPLOYMENTS, default ../deployments.json). Secrets only
// come from the environment or files outside the repo; nothing secret is read from deployments.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { productionOmens } from "../../scripts/omens.mjs";
import { adminCanceller, agentCaller, classicalSubmitter, loadDeployerKey, makeDrillChain, makeSendTrip } from "./chain.mjs";
import { renderDemo, runInjectionDemo } from "./demo.mjs";
import { mainnetHelp } from "./help.mjs";
import { judge, renderJudge } from "./judge.mjs";
import { provision, recycle, rehearse, renderRehearsal } from "./testnet.mjs";
import { runFireTest } from "./firetest.mjs";
import { record, snapshot } from "./hinomi.mjs";
import { NO_VAULTS, runKeeper, tripOnce } from "./keeper.mjs";
import { buildPlan, executeStage, findLatestGate, loadInputs, lockKizashi, Refused, renderPlan, runGates } from "./mainnet.mjs";
import { makeRpc } from "./rpc.mjs";
import { report, verifyAll, verifyRelease, writeGate } from "./verify.mjs";
import { predeploy, report as predeployReport } from "../../scripts/predeploy.mjs";
import { check, loadState, saveState, sources } from "./watchers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const depPath = process.env.KAIGEN_DEPLOYMENTS ?? path.join(root, "deployments.json");
const dataDir = process.env.KAIGEN_DATA ?? path.join(root, "data");

function load() {
  if (!fs.existsSync(depPath)) throw new Error(`no deployments file at ${depPath}; copy deployments.example.json`);
  const dep = JSON.parse(fs.readFileSync(depPath, "utf8"));
  const rpc = makeRpc(dep.rpc ?? "https://rpc.mainnet.near.org");
  const archival = dep.archivalRpc ? makeRpc(dep.archivalRpc) : rpc;
  return { dep, rpc, archival };
}

const need = (name) => process.env[name] ?? (() => { throw new Error(`set ${name}`); })();
const submitter = (dep) => classicalSubmitter({ network: dep.network ?? "mainnet", account: need("KEEPER_ACCOUNT"), privateKey: need("KEEPER_PRIVATE_KEY") });

const commands = {
  async hinomi() {
    const { dep, rpc } = load();
    const accounts = dep.hinomi?.accountsFile ? JSON.parse(fs.readFileSync(dep.hinomi.accountsFile, "utf8")) : dep.hinomi?.accounts ?? [];
    const snap = await snapshot({ rpc, accounts, vaults: dep.vaults ?? [] });
    const status = record(path.join(dataDir, "hinomi"), snap);
    console.log(`block ${snap.block_height}: exposed ${snap.exposed_yocto} yocto, post-quantum ${snap.post_quantum_yocto} yocto, ${snap.flagged_vaults.length} flagged vault(s) (${status})`);
    if (snap.errors.length > 0) {
      // Not added to history: a partial read would look like a drop in exposure.
      console.error(`${snap.errors.length} account(s) could not be read, so this snapshot was NOT recorded in history: ${snap.errors.map((e) => `${e.id} (${e.error})`).join("; ")}`);
      process.exitCode = 1;
    }
    if (snap.truncated.length > 0) console.error(`warning: ${snap.truncated.join(", ")} have more keys than were read, so their exposure is a lower bound`);
  },

  async keeper() {
    const { dep, rpc } = load();
    // Checked here too, so `--loop` fails at start instead of reporting an empty pass forever.
    if ((dep.vaults ?? []).length === 0) throw new Error(NO_VAULTS);
    const opts = { rpc, kizashi: dep.kizashi, vaults: dep.vaults, sendTrip: makeSendTrip(submitter(dep)) };
    const show = (r) => console.log(`era ${r.era}: ${r.results.map((x) => `${x.vault} ${x.action}${x.hash ? ` ${x.hash}` : ""}${x.error ? ` (${x.error})` : ""}`).join("; ") || "nothing to do"}${r.error ? ` ERROR ${r.error}` : ""}`);
    if (process.argv.includes("--loop")) await runKeeper({ ...opts, onPass: show });
    else {
      const pass = await tripOnce(opts);
      show(pass);
      // A vault that failed to trip, or whose lockdown could not be confirmed, is a failure of the run, not a footnote.
      if (pass.results.some((x) => x.action === "error" || x.action === "unconfirmed")) process.exitCode = 1;
    }
  },

  async watch() {
    const { rpc } = load();
    const file = path.join(dataDir, "watchers", "state.json");
    const { state, alerts } = await check(sources({ rpc, omens: productionOmens() }), loadState(file));
    saveState(file, state, alerts);
    for (const a of alerts) console.log(`${a.kind.toUpperCase()} ${a.id}: ${a.detail}`);
    const unreadable = alerts.filter((a) => a.kind === "unreadable").length;
    if (alerts.some((a) => a.kind === "outflow")) process.exitCode = 2;
    else if (unreadable > 0) {
      // Not being able to look is not the same as nothing happening.
      console.error(`${unreadable} bounty address(es) could not be read; no outflow seen in the rest, but this run is NOT a clean bill`);
      process.exitCode = 3;
    } else console.log(`${Object.keys(state).length} bounty address(es) checked, no outflow`);
  },

  async firetest() {
    const { dep, rpc } = load();
    const drill = dep.drill;
    if (!drill) throw new Error("deployments.json has no drill section");
    const dir = path.join(root, "fire-tests");
    fs.mkdirSync(dir, { recursive: true });
    // Failed attempts count too, so a failure is never overwritten by the next run.
    const seq = Math.max(0, ...fs.readdirSync(dir).map((f) => /^(\d+)(\.failed)?\.json$/.exec(f)?.[1]).filter(Boolean).map(Number)) + 1;
    const omenIds = ["drill-ed25519-omen", "drill-secp256k1-omen"];
    const cfg = { kizashi: drill.kizashi, vaults: drill.vaults, submitter: need("KEEPER_ACCOUNT"), omenId: omenIds[(seq - 1) % 2], seq };
    const drillOmens = (await import("../../scripts/omens.mjs")).drillOmens(need("DRILL_SECRETS"));
    const chain = makeDrillChain({ rpc, submit: submitter(dep), network: dep.network, cfg, drillSecretsPath: need("DRILL_SECRETS"), adminSeedsPath: need("DRILL_ADMIN_SEEDS"), dailyKeys: drill.dailyKeys, omens: drillOmens });
    const out = path.join(dir, `${String(seq).padStart(4, "0")}.json`);
    try {
      const rec = await runFireTest({ chain, cfg });
      fs.writeFileSync(out, JSON.stringify(rec, null, 2));
      console.log(`fire test #${seq} passed; record at ${out}`);
    } catch (e) {
      if (e.record) fs.writeFileSync(path.join(dir, `${String(seq).padStart(4, "0")}.failed.json`), JSON.stringify(e.record, null, 2));
      throw e;
    }
  },

  /** Free, reproducible: provisions throwaway testnet accounts, then runs the demo and both fire tests. */
  async testnet() {
    const outDir = process.env.KAIGEN_TESTNET_DIR ?? path.join(root, ".kaigen-testnet");
    const log = (e) => console.log(JSON.stringify(e));
    const state = await provision({ outDir, wasmDir: path.join(root, "out", "drill"), funderFile: process.env.KAIGEN_FUNDER_FILE, log });
    const out = await rehearse({ state, outDir, log });
    const { text, ok } = renderRehearsal(state, out);
    console.log(`
${text}`);
    process.exitCode = ok ? 0 : 1;
  },

  /** Returns a previous testnet run's balances to its funder so the funder can be reused. */
  async recycle() {
    await recycle({ outDir: process.env.KAIGEN_TESTNET_DIR ?? path.join(root, ".kaigen-testnet"), log: (e) => console.log(JSON.stringify(e)) });
  },

  /** The reproducibility screen: runs every offline claim and prints a structured report. */
  async judge() {
    const report = await judge({ root, withTestnet: process.argv.includes("--testnet"), log: (e) => console.error(`running ${e.running}…`) });
    fs.writeFileSync(path.join(root, "judge-report.json"), JSON.stringify(report, null, 2));
    console.log(renderJudge(report));
    process.exitCode = report.ok ? 0 : 1;
  },

  async demo() {
    const { dep, rpc } = load();
    const vault = need("DEMO_VAULT");
    const seeds = JSON.parse(fs.readFileSync(need("DEMO_ADMIN_SEEDS"), "utf8"));
    const cfg = await rpc.view(vault, "config");
    const result = await runInjectionDemo({
      vault,
      supplier: need("DEMO_SUPPLIER"),
      attacker: process.env.DEMO_ATTACKER ?? "attacker.near",
      rpc,
      agentCall: agentCaller({ network: dep.network, vault, privateKey: need("AGENT_DAILY_KEY") }),
      adminCancel: adminCanceller({ network: dep.network, vault, seedHex: seeds[vault] ?? (() => { throw new Error(`no admin seed for ${vault}`); })() }),
      payable: BigInt(process.env.DEMO_PAY ?? "1000000000000000000000"), // 0.001 NEAR
      limit: BigInt(cfg.daily_limit),
      log: (e) => console.log(JSON.stringify(e)),
    });
    console.log(`${renderDemo(result)}`);
    process.exitCode = result.ok ? 0 : 1;
  },

  async verify() {
    const wasmDir = path.join(root, "out", "prod");
    const drillWasmDir = path.join(root, "out", "drill");
    const fireTestDir = path.join(root, "fire-tests");
    if (!process.argv.includes("--release")) {
      const { dep, rpc, archival } = load();
      const results = await verifyAll({ rpc, archival, dep, wasmDir, drillWasmDir, fireTestDir });
      const { text, ok } = report(results);
      console.log(text);
      process.exitCode = ok ? 0 : 1;
      return;
    }
    // Release mode: mainnet only, two independent hosts for every read, and a gate file for `mainnet lock`.
    const { dep } = load();
    const hosts = [dep.rpc, dep.rpcSecondary ?? process.env.KAIGEN_RPC_SECONDARY];
    if (hosts.some((h) => typeof h !== "string" || !h)) throw new Error("verify --release needs two RPC hosts: set rpc and rpcSecondary in deployments.json (or KAIGEN_RPC_SECONDARY)");
    const archiveHosts = [dep.archivalRpc, dep.archivalRpcSecondary ?? process.env.KAIGEN_ARCHIVAL_RPC_SECONDARY];
    const { results, gate } = await verifyRelease({
      rpcs: hosts.map((h) => makeRpc(h)),
      hosts,
      archivals: archiveHosts.every((h) => typeof h === "string" && h) ? archiveHosts.map((h) => makeRpc(h)) : undefined,
      dep,
      wasmDir,
      drillWasmDir,
      fireTestDir,
      preLock: process.argv.includes("--pre-lock"),
    });
    const { text, ok } = report(results);
    console.log(text);
    const file = writeGate(path.join(dataDir, "gates"), gate);
    console.log(`\ngate file (${gate.stage}, ${gate.ok ? "PASSED" : "FAILED"}): ${file}`);
    process.exitCode = ok && gate.ok ? 0 : 1;
  },

  /** Mainnet deploy tooling. Dry-run by default; see mainnet.mjs. */
  async mainnet() {
    const args = process.argv.slice(3);
    const sub = args[0];
    const flag = (name) => args.includes(name);
    const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
    if (sub === "help") {
      console.log(mainnetHelp());
      return;
    }
    if (!["gates", "plan", "execute", "lock"].includes(sub)) {
      console.error("usage: kaigen-jobs mainnet gates | plan | execute --stage <1-3> --yes | lock [--gate <file>] [--i-understand-this-is-irreversible]\nrun `kaigen-jobs mainnet help` for the stage flow, the key file format and the settings");
      process.exitCode = 2;
      return;
    }
    const { dep, rpc } = load();
    const inputs = () => loadInputs({ dep, root });
    const keyFile = process.env.KAIGEN_DEPLOYER_KEY_FILE;
    // Every step is printed and appended to the phase log: ids, hashes and results, never keys or code.
    const log = (e) => {
      const line = JSON.stringify({ at: new Date().toISOString(), ...e });
      console.log(line);
      fs.mkdirSync(path.join(dataDir, "mainnet"), { recursive: true });
      fs.appendFileSync(path.join(dataDir, "mainnet", "phase.log"), `${line}\n`);
    };

    if (sub === "gates") {
      if (dep.network !== "mainnet") throw new Refused(`deployments.json says network ${JSON.stringify(dep.network)}: the mainnet tooling only runs against mainnet`);
      let loaded = null;
      try {
        loaded = inputs();
      } catch (e) {
        console.error(`inputs not loaded (${e.message}); the checks that need them will fail`);
      }
      const { text, ok } = report(await runGates({ rpc, dep, inputs: loaded }));
      console.log(text);
      process.exitCode = ok ? 0 : 1;
    } else if (sub === "plan") {
      const loaded = inputs();
      console.log(renderPlan(buildPlan({ dep, inputs: loaded })));
      // The offline half of the pre-deploy checks, so a plan that could not be sent says so.
      const checks = await predeploy({ init: loaded.kizashiInit, drillKeys: loaded.drillKeys, usdc: loaded.kizashiInit.usdc, wasm: loaded.wasm.prod.kizashi });
      const { text, ok } = predeployReport(checks);
      console.log(`\nPre-deploy checks (offline; add --rpc to scripts/predeploy.mjs for the USDC registration):\n${text}`);
      process.exitCode = ok ? 0 : 1;
    } else if (sub === "execute") {
      if (value("--stage") === undefined) throw new Refused("execute needs --stage N (1 to 3)");
      const result = await executeStage({
        stage: Number(value("--stage")),
        dep,
        getInputs: inputs,
        rpc,
        yes: flag("--yes"),
        keyFile,
        loadKey: (file) => loadDeployerKey(file, { network: "mainnet" }),
        log,
      });
      console.log(`stage ${result.stage}: sent ${result.sent.length}, skipped ${result.skipped.length}; post-check passed`);
    } else {
      const given = value("--gate");
      let found;
      if (given) {
        try {
          found = { file: given, gate: JSON.parse(fs.readFileSync(given, "utf8")) };
        } catch (e) {
          throw new Refused(`cannot read the gate file ${given}: ${e.code ?? "not valid JSON"}`);
        }
      } else found = findLatestGate(path.join(dataDir, "gates"));
      if (found) console.log(`using gate ${found.file}`);
      const out = await lockKizashi({
        dep,
        rpc,
        gate: found?.gate,
        irreversible: flag("--i-understand-this-is-irreversible"),
        keyFile,
        loadKey: (file) => loadDeployerKey(file, { network: "mainnet" }),
        log,
      });
      if (out.dryRun) console.log("\nDRY RUN: nothing was sent. The gate is valid and the key list above is what the lock would delete.");
      else if (out.nothingToDo) console.log("\nNothing to do: the account has no access keys left.");
      else {
        if (out.warning) console.error(out.warning);
        console.log(`\n${report(out.post).text}\n\n${out.ok ? "LOCKED" : "LOCK POST-CHECK FAILED: do not announce anything, read the checks above"}${out.hash ? ` (tx ${out.hash})` : ""}`);
      }
      process.exitCode = out.ok ? 0 : 1;
    }
  },
};

const cmd = process.argv[2];
if (!commands[cmd]) {
  console.error("usage: kaigen-jobs hinomi | keeper [--loop] | watch | firetest | demo | testnet | recycle | judge | verify [--release [--pre-lock]] | mainnet gates|plan|execute|lock");
  process.exit(2);
}
commands[cmd]().catch((e) => {
  console.error(e.message ?? e);
  // Not process.exit: on Windows that can race an open connection and crash with a libuv assertion.
  process.exitCode = 1;
});
