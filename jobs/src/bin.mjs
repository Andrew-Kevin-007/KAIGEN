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
//   zerokey    testnet only: the rehearsal Kizashi deletes its own full-access key, then claim, reset and views are checked
//              (dry run unless --yes; needs the rehearsal that `testnet` provisioned, KAIGEN_TESTNET_DIR)
//   cage-check read-only: is the cage around a vault intact? RED or GREEN per condition of docs/v3/ARCHITECTURE.md 2.8
//              (exit 1 on any red, 3 when something could not be checked; run it with no arguments for the options)
//   counterparty <vault> <to>  read-only advisory check before an agent pays: allow, warn or block, with every reason and, per signal, its
//              data source and whether it was known or unknown (exit 0 allow, 1 block, 3 warn or mostly unknown, 2 usage)
//   counterparty-report <account> --reason <text> --evidence <url-or-tx>  append to the shared blocklist file (KAIGEN_BLOCKLIST,
//              default data/blocklist.json); the only command here that writes, and only to that file
//   globalcontract  testnet only (M6): publish Mamori as a global contract BY CODE HASH, create a vault and attach it with
//              init in the same transaction, verify over RPC (dry run unless --yes; run it with no arguments for the options)
//              `globalcontract publish --wasm <file>`: publish-only, any valid wasm, no init, prints the MEASURED cost
//   prodvault  testnet only: a PRODUCTION-build vault (24 h delay) with an ML-DSA-only admin, one agent key and one allowlisted supplier,
//              then cage-check per row (dry run unless --yes; run it with no arguments for the options). Keys go to KAIGEN_TESTNET_DIR
//   plant-key  testnet only: plant a key the cage must not have (--kind ed25519-full|null-allowance) or take it off (--remove <publickey>),
//              signed by the vault's ML-DSA admin seed; prints the cage-check command to run next (dry run unless --yes)
//   stretchdrill  testnet only: the stretch items (safe account, sweep_to_safe, policy proposals) on the DRILL rehearsal vault of
//              KAIGEN_TESTNET_DIR/state.json, signed by its ML-DSA admin seed; PASS/FAIL per step with tx hashes (dry run unless --yes)
//   inject-demo  testnet only: an accounts-payable agent reads an invoice with an injected instruction and the vault decides
//              (--model mock|anthropic|openrouter, --model-id <id>, --dry; anthropic reads ANTHROPIC_API_KEY, openrouter reads OPENROUTER_API_KEY and needs --model-id). See injectdemo.mjs
//
// Config: deployments.json (path in KAIGEN_DEPLOYMENTS, default ../deployments.json). Secrets only
// come from the environment or files outside the repo; nothing secret is read from deployments.json.
import { randomBytes } from "node:crypto";
import { signerFromPrivateKey } from "@fastnear/utils";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { productionOmens } from "../../scripts/omens.mjs";
import { CAGE_USAGE, cageCheck, CageUsage, exitCodeOf, parseCageArgs, renderCage } from "./cage.mjs";
import { adminCanceller, agentCaller, classicalSubmitter, loadDeployerKey, makeDrillChain, makeSendTrip } from "./chain.mjs";
import { addReport, assessCounterparty, COUNTERPARTY_USAGE, CounterpartyUsage, exitCodeOf as counterpartyExitCode, loadBlocklist, looksLikeEvidence, parseCounterpartyArgs, parseReportArgs, renderCounterparty } from "./counterparty.mjs";
import { renderDemo, runInjectionDemo } from "./demo.mjs";
import { runInjectCommand } from "./injectdemo.mjs";
import { mainnetHelp } from "./help.mjs";
import { judge, renderJudge } from "./judge.mjs";
import { provision, recycle, rehearse, renderRehearsal, TESTNET_RPC, zeroKey } from "./testnet.mjs";
import { renderZeroKey, runFireTest, ZeroKeyError } from "./firetest.mjs";
import { defaultSeedFile, describeWasm, GLOBAL_USAGE, GlobalUsage, parseGlobalArgs, planGlobalContract, measurePublishTx, planPublishOnly, renderMeasured, renderRun, runGlobalContract, verifyVault } from "./globalcontract.mjs";
import { adminSigner, loadFunder, makeSender, newClassicalKey } from "./globaltx.mjs";
import { record, snapshot } from "./hinomi.mjs";
import { NO_VAULTS, runKeeper, tripOnce } from "./keeper.mjs";
import { buildPlan, executeStage, findLatestGate, loadInputs, lockKizashi, Refused, renderPlan, runGates } from "./mainnet.mjs";
import { PLANT_USAGE, parsePlantArgs, planPlantKey, renderPlant, runPlantKey } from "./plantkey.mjs";
import { assertSecretsDir, parseProdVaultArgs, planProdVault, PRODVAULT_USAGE, renderRun as renderProdVault, runProdVault } from "./prodvault.mjs";
import { makeRpc } from "./rpc.mjs";
import { parseStretchArgs, planStretchDrill, renderStretch, runStretchDrill, STRETCHDRILL_USAGE } from "./stretchdrill.mjs";
import { codeHashOf, report, verifyAll, verifyRelease, writeGate } from "./verify.mjs";
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

  /**
   * Testnet only: a prompt-injected accounts-payable agent against the vault. --model anthropic or openrouter is a real model (key from
   * ANTHROPIC_API_KEY or OPENROUTER_API_KEY only); --model mock is a labelled script. Reuses the rehearsal in KAIGEN_TESTNET_DIR. See injectdemo.mjs.
   */
  async "inject-demo"() {
    const log = (e) => console.error(JSON.stringify(e));
    const r = await runInjectCommand({ argv: process.argv.slice(3), root, evidenceDir: path.join(root, "docs", "v3", "evidence"), log });
    (r.exitCode === 2 ? console.error : console.log)(r.text);
    process.exitCode = r.exitCode;
  },

  /** Returns a previous testnet run's balances to its funder so the funder can be reused. */
  async recycle() {
    await recycle({ outDir: process.env.KAIGEN_TESTNET_DIR ?? path.join(root, ".kaigen-testnet"), log: (e) => console.log(JSON.stringify(e)) });
  },

  /**
   * Zero-key Kizashi, on a rehearsal that `testnet` already provisioned. Deletes the Kizashi's own full-access key (testnet,
   * throwaway, irreversible), then checks: no keys left, views answer, the old key cannot sign, a third party's claim with a
   * drill omen works, a third party's reset works. No faucet, no new account. Dry run unless --yes.
   */
  async zerokey() {
    const outDir = process.env.KAIGEN_TESTNET_DIR ?? path.join(root, ".kaigen-testnet");
    const stateFile = path.join(outDir, "state.json");
    if (!fs.existsSync(stateFile)) throw new Error(`no provisioned rehearsal in ${outDir} (state.json is missing): run \`node jobs/src/bin.mjs testnet\` first, or set KAIGEN_TESTNET_DIR to the folder it used`);
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const log = (e) => console.log(JSON.stringify(e));
    try {
      const out = await zeroKey({ state, outDir, yes: process.argv.includes("--yes"), log });
      if (out.dryRun) {
        console.log(`zero-key Kizashi ${out.cfg.kizashi}: calm, omen ${out.cfg.omenId} alive, ${out.alreadyKeyless ? "it already has no access keys" : `its only key is its own full-access key ${out.cfg.ownKey}`}.`);
        console.log("\nDRY RUN: nothing was sent. Run it for real (irreversible for this testnet Kizashi) with:\n  node jobs/src/bin.mjs zerokey --yes");
        return;
      }
      console.log(`${renderZeroKey(out.rec)}\n\nRESULT: Kizashi has no access keys, and its views, a third party's claim and a third party's reset still work.`);
    } catch (e) {
      if (e instanceof ZeroKeyError && e.record) console.error(`${renderZeroKey(e.record)}${e.record.cleanup ? `\ncleanup after the claim: ${JSON.stringify(e.record.cleanup)}` : ""}\n`);
      throw e;
    }
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

  /** Read-only. Does not need deployments.json when --rpc or KAIGEN_RPC is given. See cage.mjs. */
  async "cage-check"() {
    let opts;
    try {
      opts = parseCageArgs(process.argv.slice(3));
    } catch (e) {
      if (!(e instanceof CageUsage)) throw e;
      console.error(`${e.message}\n${CAGE_USAGE}`);
      process.exitCode = 2;
      return;
    }
    const url = opts.rpc ?? process.env.KAIGEN_RPC ?? (fs.existsSync(depPath) ? JSON.parse(fs.readFileSync(depPath, "utf8")).rpc : undefined);
    if (!url) {
      console.error(`no RPC url: pass --rpc, set KAIGEN_RPC or set rpc in ${depPath}\n${CAGE_USAGE}`);
      process.exitCode = 2;
      return;
    }
    const result = await cageCheck({ rpc: makeRpc(url), account: opts.account, policy: opts.policy });
    console.log(opts.json ? JSON.stringify(result, null, 2) : renderCage(result));
    process.exitCode = exitCodeOf(result);
  },

  /** Read-only, advisory. Does not need deployments.json when --rpc or KAIGEN_RPC is given. See counterparty.mjs and docs/v3/COUNTERPARTY.md. */
  async counterparty() {
    let o;
    try {
      o = parseCounterpartyArgs(process.argv.slice(3));
    } catch (e) {
      if (!(e instanceof CounterpartyUsage)) throw e;
      console.error(`${e.message}\n${COUNTERPARTY_USAGE}`);
      process.exitCode = 2;
      return;
    }
    const dep = fs.existsSync(depPath) ? JSON.parse(fs.readFileSync(depPath, "utf8")) : {};
    const url = o.rpc ?? process.env.KAIGEN_RPC ?? dep.rpc ?? (dep.network === "testnet" ? TESTNET_RPC : undefined);
    if (!url) {
      console.error(`no RPC url: pass --rpc, set KAIGEN_RPC or set rpc in ${depPath}\n${COUNTERPARTY_USAGE}`);
      process.exitCode = 2;
      return;
    }
    const archivalUrl = o.archival ?? process.env.KAIGEN_ARCHIVAL_RPC ?? dep.archivalRpc;
    const rpc = makeRpc(url);
    const result = await assessCounterparty({
      rpc,
      // Fewer retries than the default: an archival node answers some old heights with a 500, which a long retry loop would only turn into a wait.
      archival: archivalUrl && archivalUrl !== url ? makeRpc(archivalUrl, { retries: 4, backoffMs: 1000 }) : rpc,
      vault: o.vault,
      to: o.to,
      history: o.history,
      blocklist: loadBlocklist(process.env.KAIGEN_BLOCKLIST ?? path.join(dataDir, "blocklist.json")),
    });
    console.log(o.json ? JSON.stringify(result, null, 2) : renderCounterparty(result, { to: o.to, vault: o.vault }));
    process.exitCode = counterpartyExitCode(result);
  },

  /** Appends one report to the shared blocklist file. The evidence is required. */
  async "counterparty-report"() {
    let o;
    try {
      o = parseReportArgs(process.argv.slice(3));
    } catch (e) {
      if (!(e instanceof CounterpartyUsage)) throw e;
      console.error(`${e.message}\n${COUNTERPARTY_USAGE}`);
      process.exitCode = 2;
      return;
    }
    const file = process.env.KAIGEN_BLOCKLIST ?? path.join(dataDir, "blocklist.json");
    let entry;
    try {
      entry = addReport({ file, ...o, reportedBy: o.reportedBy ?? process.env.KAIGEN_REPORTER });
    } catch (e) {
      if (!(e instanceof CounterpartyUsage)) throw e;
      console.error(`${e.message}\n${COUNTERPARTY_USAGE}`);
      process.exitCode = 2;
      return;
    }
    if (!looksLikeEvidence(entry.evidence)) console.error("note: the evidence is neither an http(s) URL nor a transaction hash; it was stored exactly as given");
    console.log(`reported ${entry.account} in ${file}: ${entry.reason} (evidence: ${entry.evidence}; by ${entry.reportedBy}; ${entry.reportedAt})`);
  },

  /**
   * M6, testnet only: publish the Mamori wasm as a global contract by code hash, create a vault and attach it with init in the
   * same transaction, then verify over RPC. Dry run unless --yes (no signing, reads only). See globalcontract.mjs and
   * docs/v3/GLOBAL-CONTRACT.md.
   */
  async globalcontract() {
    let o;
    try {
      o = parseGlobalArgs(process.argv.slice(3), { wasm: path.join(root, "out", "prod", "mamori.wasm"), seedFile: defaultSeedFile(root, process.env), funderFile: process.env.KAIGEN_FUNDER_FILE });
    } catch (e) {
      if (!(e instanceof GlobalUsage)) throw e;
      console.error(`${e.message}
${GLOBAL_USAGE}`);
      process.exitCode = 2;
      return;
    }
    const rpc = makeRpc(o.rpc);
    const readWasm = () => {
      try {
        return fs.readFileSync(o.wasm);
      } catch (e) {
        throw new Error(`cannot read the wasm ${o.wasm}: ${e.code ?? e.message}`);
      }
    };
    if (o.mode === "cost") {
      const r = await measurePublishTx({ rpc, txHash: o.costOf, signerId: o.signer, bytes: o.bytes });
      console.log(`publish transaction ${o.costOf} of ${o.signer}, code hash ${r.codeHash}\n${renderMeasured(r.measured).join("\n")}`);
      process.exitCode = r.measured.yoctoPerByte === null ? 1 : 0;
      return;
    }
    if (o.mode === "verify") {
      const codeHash = o.codeHash ?? describeWasm(readWasm(), o.wasm).codeHash;
      const v = await verifyVault({ rpc, vault: o.verifyVault, codeHash, adminHandle: o.admin });
      const { text, ok } = report(v.checks);
      console.log(`${text}${v.cage ? `

${renderCage(v.cage)}` : ""}`);
      process.exitCode = ok ? 0 : 1;
      return;
    }
    const funder = o.funderFile ? loadFunder(o.funderFile) : null;
    // `publish` takes any valid wasm and calls nothing on the attached account; the default run is Mamori's vault with init.
    const plan =
      o.mode === "publish"
        ? planPublishOnly({ wasm: readWasm(), wasmPath: o.wasm, funderId: funder?.accountId ?? null, account: o.vault, accountYocto: o.vaultYocto })
        : planGlobalContract({ wasm: readWasm(), wasmPath: o.wasm, funderId: funder?.accountId ?? null, vault: o.vault, kizashi: o.kizashi, dailyLimitYocto: o.dailyLimitYocto, delaySecs: o.delaySecs, vaultYocto: o.vaultYocto });
    const log = (e) => console.log(JSON.stringify({ at: new Date().toISOString(), ...e }));
    const out = await runGlobalContract({
      plan,
      rpc,
      funder,
      sender: makeSender({ rpc }),
      makeAdmin: (a) => adminSigner({ seedFile: o.seedFile, ...a }),
      yes: o.yes,
      expectedChain: o.chainId,
      log,
      recordFile: path.join(path.dirname(o.seedFile), `global-contract-${plan.vault}.json`),
    });
    console.log(`
${renderRun(out)}`);
    if (out.dryRun) {
      console.log(`
DRY RUN: nothing was signed or sent. To do it for real (this burns the cost above):
  node jobs/src/bin.mjs ${process.argv.slice(2).join(" ")}${o.funderFile ? (process.argv.includes("--funder-file") ? "" : "   (funder file from KAIGEN_FUNDER_FILE)") : " --funder-file <funded testnet account file>"} --yes`);
      process.exitCode = out.pre.ok ? 0 : 1;
      return;
    }
    console.log(`
${out.rec.ok ? "ATTACHED AND VERIFIED" : "VERIFICATION FAILED: do not announce anything, read the checks above"}; record ${path.join(path.dirname(o.seedFile), `global-contract-${plan.vault}.json`)}; the vault's ML-DSA-65 admin seed is in ${o.seedFile} (back it up: it is the only key of ${plan.vault})`);
    process.exitCode = out.rec.ok ? 0 : 1;
  },

  /**
   * Testnet only: a production-build vault with an ML-DSA-only admin, one agent daily key and one allowlisted supplier, then cage-check.
   * Dry run unless --yes (reads only). Keys go to KAIGEN_TESTNET_DIR (gitignored) and are never printed. See prodvault.mjs.
   */
  async prodvault() {
    let o;
    try {
      o = parseProdVaultArgs(process.argv.slice(3), { wasm: path.join(root, "out", "prod", "mamori.wasm"), funderFile: process.env.KAIGEN_FUNDER_FILE });
    } catch (e) {
      if (!(e instanceof GlobalUsage)) throw e;
      console.error(`${e.message}
${PRODVAULT_USAGE}`);
      process.exitCode = 2;
      return;
    }
    const dir = assertSecretsDir(process.env.KAIGEN_TESTNET_DIR ?? path.join(root, ".kaigen-testnet"), root);
    let wasm;
    try {
      wasm = fs.readFileSync(o.wasm);
    } catch (e) {
      throw new Error(`cannot read the wasm ${o.wasm}: ${e.code ?? e.message}`);
    }
    const funder = o.funderFile ? loadFunder(o.funderFile) : null;
    const rpc = makeRpc(o.rpc);
    const plan = planProdVault({ wasm, wasmPath: o.wasm, funderId: funder?.accountId ?? null, kizashi: o.kizashi, supplier: o.supplier, suffix: randomBytes(4).toString("hex") });
    const out = await runProdVault({
      plan,
      rpc,
      funder,
      sender: makeSender({ rpc }),
      newKey: newClassicalKey,
      makeAdmin: (a) => adminSigner({ seedFile: path.join(dir, "admin-seeds.json"), ...a }),
      dir,
      yes: o.yes,
      expectedChain: o.chainId,
      log: (e) => console.log(JSON.stringify({ at: new Date().toISOString(), ...e })),
    });
    console.log(`
${renderProdVault(out)}`);
    if (out.dryRun) {
      console.log(`
DRY RUN: nothing was signed or sent. To do it for real (creates and funds a vault with 4.9 NEAR of the funder's testnet balance):
  node jobs/src/bin.mjs prodvault --kizashi ${o.kizashi} --funder-file ${o.funderFile ?? "<funded testnet account file>"}${o.supplier ? ` --supplier ${o.supplier}` : ""} --yes`);
      process.exitCode = out.pre.ok ? 0 : 1;
      return;
    }
    console.log(`
record (holds the agent key, keep it private): ${out.recordFile}; the vault's ML-DSA-65 admin seed is in ${path.join(dir, "admin-seeds.json")} (back it up: it is the only key of ${plan.vault})`);
    process.exitCode = out.checks.every((c) => c.ok) ? exitCodeOf(out.cage) : 1;
  },

  /** Testnet only: plant (or remove) a key the cage must not have, signed by the vault's ML-DSA admin seed. Dry run unless --yes. See plantkey.mjs. */
  async "plant-key"() {
    const defaultDir = process.env.KAIGEN_TESTNET_DIR ?? path.join(root, ".kaigen-testnet");
    let o;
    let plan;
    try {
      o = parsePlantArgs(process.argv.slice(3), { seedFile: path.join(defaultDir, "admin-seeds.json") });
      plan = planPlantKey({ vault: o.vault, kind: o.kind, remove: o.remove, receiver: o.receiver });
    } catch (e) {
      if (!(e instanceof GlobalUsage)) throw e;
      console.error(`${e.message}
${PLANT_USAGE}`);
      process.exitCode = 2;
      return;
    }
    const dir = assertSecretsDir(path.dirname(o.seedFile), root);
    const rpc = makeRpc(o.rpc);
    const out = await runPlantKey({
      plan,
      rpc,
      sender: makeSender({ rpc }),
      newKey: newClassicalKey,
      makeAdmin: (a) => adminSigner({ seedFile: o.seedFile, ...a }),
      dir,
      yes: o.yes,
      expectedChain: o.chainId,
      rpcUrl: o.rpc,
      wasmPath: o.wasm,
      log: (e) => console.log(JSON.stringify({ at: new Date().toISOString(), ...e })),
    });
    console.log(`
${renderPlant(out)}`);
    if (out.dryRun) {
      console.log(`
DRY RUN: nothing was signed or sent. To do it for real:
  node jobs/src/bin.mjs ${process.argv.slice(2).join(" ")} --yes`);
      process.exitCode = out.pre.ok ? 0 : 1;
      return;
    }
    process.exitCode = out.confirmed ? 0 : 1;
  },

  /**
   * Testnet only: the stretch items on the DRILL rehearsal vault named by KAIGEN_TESTNET_DIR/state.json, signed by its ML-DSA admin
   * seed. Dry run unless --yes (reads only). See stretchdrill.mjs.
   */
  async stretchdrill() {
    const dir = assertSecretsDir(process.env.KAIGEN_TESTNET_DIR ?? path.join(root, ".kaigen-testnet"), root);
    const defaultFunder = process.env.KAIGEN_FUNDER_FILE ?? (fs.existsSync(path.join(dir, "funder.json")) ? path.join(dir, "funder.json") : undefined);
    let o;
    try {
      o = parseStretchArgs(process.argv.slice(3), { funderFile: defaultFunder, wasm: fs.existsSync(path.join(root, "out", "drill", "mamori.wasm")) ? path.join(root, "out", "drill", "mamori.wasm") : undefined, ftWasm: process.env.FT_MOCK_WASM ?? "D:/HACK-Projects/toolchain/w3-wasm/ft_mock.wasm" });
    } catch (e) {
      if (!(e instanceof GlobalUsage)) throw e;
      console.error(`${e.message}
${STRETCHDRILL_USAGE}`);
      process.exitCode = 2;
      return;
    }
    const stateFile = path.join(dir, "state.json");
    if (!fs.existsSync(stateFile)) throw new Error(`no provisioned rehearsal in ${dir} (state.json is missing): set KAIGEN_TESTNET_DIR to the folder \`testnet\` used`);
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const rpc = makeRpc(o.rpc);
    // The funder creates the policy, watcher and token sub-accounts; a dry run only needs its account id.
    let funder = null;
    if (o.funderFile) {
      try {
        funder = loadFunder(o.funderFile);
      } catch (e) {
        if (o.yes) throw e;
      }
    }
    // Accounts an earlier run created are named in the actors file: they are reused (and topped up), whichever funder is given now.
    const actorFile = path.join(dir, "stretchdrill-actors.json");
    const readActors = () => (fs.existsSync(actorFile) ? JSON.parse(fs.readFileSync(actorFile, "utf8")) : {});
    const existingActors = Object.fromEntries(["policy", "watcher", "token"].filter((r) => readActors()[r]?.account).map((r) => [r, readActors()[r].account]));
    const plan = planStretchDrill({ state, safe: o.safe, recipient: `stretchdrill-${randomBytes(4).toString("hex")}.testnet`, funderId: funder?.accountId ?? "no-funder-file.testnet", existingActors });
    const sender = makeSender({ rpc });
    // Own keys of the policy actor, the watcher, the token account and the added daily key: made here, saved in the gitignored folder BEFORE any NEAR moves.
    const keyCache = new Map();
    const actorKey = (role, { create = true, fresh = false } = {}) => {
      const saved = readActors();
      if (saved[role] && !fresh) {
        if (!keyCache.has(saved[role].privateKey)) keyCache.set(saved[role].privateKey, signerFromPrivateKey(saved[role].privateKey));
        return { publicKey: saved[role].publicKey, signer: keyCache.get(saved[role].privateKey) };
      }
      if (!create) return null;
      const k = newClassicalKey();
      fs.writeFileSync(actorFile, JSON.stringify({ ...saved, [role]: { account: plan.actors[role]?.id ?? null, privateKey: k.privateKey, publicKey: k.publicKey } }, null, 2), { mode: 0o600 });
      keyCache.set(k.privateKey, k.signer);
      return { publicKey: k.publicKey, signer: k.signer };
    };
    const ftWasm = o.ftWasm && fs.existsSync(o.ftWasm) ? new Uint8Array(fs.readFileSync(o.ftWasm)) : null;
    const admin = adminSigner({ seedFile: state.adminSeedsPath, vault: state.vault });
    if (!admin) throw new Error(`no admin seed for ${state.vault} in ${state.adminSeedsPath}`);
    const keeperSigner = signerFromPrivateKey(state.keeper.privateKey);
    const daily = agentCaller({ network: "testnet", vault: state.vault, privateKey: state.daily.privateKey });
    const io = {
      rpc,
      adminHandle: admin.publicKeyHandle,
      admin: (actions) => sender({ signerId: state.vault, signer: admin, receiverId: state.vault, actions }),
      keeper: (actions, receiverId) => sender({ signerId: state.keeper.id, signer: keeperSigner, receiverId: receiverId ?? state.vault, actions }),
      keeperPublicKey: keeperSigner.publicKey,
      actorKey,
      asActor: (role, receiverId, actions) => sender({ signerId: plan.actors[role].id, signer: actorKey(role).signer, receiverId, actions }),
      funderSend: o.yes && funder ? (receiverId, actions) => sender({ signerId: funder.accountId, signer: funder.signer, receiverId, actions }) : null,
      ftWasm,
      daily,
      fund: o.yes && funder ? (yocto) => sender({ signerId: funder.accountId, signer: funder.signer, receiverId: state.vault, actions: [{ type: "Transfer", yocto }] }) : null,
      nowNs: async () => BigInt((await rpc.call("block", { finality: "final" })).header.timestamp_nanosec),
      // The block the vault's receipt ran in: its time is the `now` the contract saw.
      receiptNs: async (outcome) => {
        const r = (outcome?.receipts_outcome ?? []).find((x) => x.outcome?.executor_id === state.vault);
        if (!r) return undefined;
        return BigInt((await rpc.call("block", { block_id: r.block_hash })).header.timestamp_nanosec);
      },
    };
    let out;
    try {
      out = await runStretchDrill({
        plan,
        state,
        io,
        yes: o.yes,
        expectedChain: o.chainId,
        wasmHash: o.wasm ? codeHashOf(fs.readFileSync(o.wasm)) : null,
        log: (e) => console.log(JSON.stringify({ at: new Date().toISOString(), ...e })),
      });
    } finally {
      admin.destroy?.();
    }
    console.log(`
${renderStretch(out)}`);
    if (out.dryRun) {
      console.log(`
DRY RUN: nothing was signed or sent. To do it for real (testnet, drill vault, a few cents of testnet NEAR):
  node jobs/src/bin.mjs stretchdrill${o.safe ? ` --safe ${o.safe}` : ""} --yes`);
      process.exitCode = out.pre.ok ? 0 : 1;
      return;
    }
    process.exitCode = out.ok ? 0 : 1;
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
  console.error("usage: kaigen-jobs hinomi | keeper [--loop] | watch | firetest | demo | testnet | inject-demo [--model mock|anthropic|openrouter] [--model-id <id>] [--dry] | recycle | zerokey [--yes] | judge | verify [--release [--pre-lock]] | cage-check <account> | counterparty <vault> <to> | counterparty-report <account> --reason <text> --evidence <url-or-tx> | globalcontract [publish --wasm <file>] --kizashi <account> [--yes] | prodvault --kizashi <account> --funder-file <file> [--yes] | plant-key <vault> --kind ed25519-full|null-allowance [--remove <publickey>] [--yes] | stretchdrill [--safe <account>] [--yes] | mainnet gates|plan|execute|lock");
  process.exit(2);
}
commands[cmd]().catch((e) => {
  console.error(e.message ?? e);
  // Not process.exit: on Windows that can race an open connection and crash with a libuv assertion.
  process.exitCode = 1;
});
