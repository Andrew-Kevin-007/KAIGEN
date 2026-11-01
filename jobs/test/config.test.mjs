// The files an operator copies or reads (deployments.example.json, `mainnet help`, the Makefile) must stay in step
// with the tools that consume them: a stale example or a recipe that calls something that is gone fails here, not on
// the day of the deploy.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mainnetHelp } from "../src/help.mjs";
import { buildPlan } from "../src/mainnet.mjs";
import { checkBounty, checkIndependentHosts, checkMainnetConfig } from "../src/verify.mjs";
import { productionOmens } from "../../scripts/omens.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");
const bin = path.join(here, "..", "src", "bin.mjs");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const example = JSON.parse(read("deployments.example.json"));

// ---- deployments.example.json -------------------------------------------------------------------

test("deployments.example.json: has every setting the release gate and the mainnet tooling read", () => {
  assert.equal(example.network, "mainnet");
  for (const k of ["rpc", "rpcSecondary", "archivalRpc", "archivalRpcSecondary", "bountyYocto", "kizashi", "mamoriReference"]) assert.equal(typeof example[k], "string", k);
  for (const k of ["deployer", "kizashiInit", "drillInit", "drillKeys"]) assert.equal(typeof example.mainnet?.[k], "string", `mainnet.${k}`);
  assert.equal(typeof example.drill?.kizashi, "string");
  assert.ok(Array.isArray(example.drill?.vaults) && example.drill.vaults.length > 0);
  assert.equal(checkMainnetConfig(example).ok, true);
  // Two hosts of one operator are not two opinions: the example itself must pass the independence check it is copied for.
  assert.equal(checkIndependentHosts([example.rpc, example.rpcSecondary]).ok, true);
  assert.equal(checkIndependentHosts([example.archivalRpc, example.archivalRpcSecondary]).ok, true);
});

test("deployments.example.json: the accounts are laid out the way the plan needs, so `mainnet plan` builds from it", () => {
  const code = (name) => Buffer.from(name);
  const inputs = {
    wasm: { prod: { kizashi: code("pk"), mamori: code("pm") }, drill: { kizashi: code("dk"), mamori: code("dm") } },
    kizashiInit: { omens: productionOmens(), usdc: "usdc.example" },
    drillInit: { omens: [], usdc: null },
  };
  // buildPlan throws unless the deployer can create the drill pair and the Mamori reference (they must be its sub-accounts).
  const plan = buildPlan({ dep: example, inputs });
  assert.deepEqual(plan.stages.map((s) => s.stage), [1, 2, 3]);
});

test("deployments.example.json: copied unchanged it verifies nothing, because every placeholder is invalid on chain", async () => {
  const placeholders = [];
  const walk = (v) => (typeof v === "string" ? (v.includes("REPLACE") && placeholders.push(v)) : v && typeof v === "object" && Object.values(v).forEach(walk));
  walk(example);
  assert.ok(placeholders.length >= 5, "the accounts, the bounty and the daily key are placeholders");
  // NEAR account ids are lower case, so a node refuses every one of these; none can be mistaken for a real account.
  for (const p of placeholders) assert.match(p, /[A-Z]/, p);
  const r = await checkBounty({ rpc: { account: async () => { throw new Error("must not be reached"); } }, dep: example });
  assert.equal(r.ok, false);
  assert.match(r.detail, /bountyYocto/);
});

// ---- `mainnet help` -----------------------------------------------------------------------------

test("mainnet help: names every stage command, the key file format and every setting of the example's mainnet block", () => {
  const text = mainnetHelp();
  for (const part of [
    "mainnet gates",
    "mainnet plan",
    "mainnet execute --stage 1 --yes",
    "mainnet execute --stage 2 --yes",
    "mainnet execute --stage 3 --yes",
    "verify --release --pre-lock",
    "mainnet lock --i-understand-this-is-irreversible",
    "make verify",
    "G1",
    "KAIGEN_DEPLOYER_KEY_FILE",
    '"account_id"',
    '"private_key"',
    "own key",
  ]) assert.ok(text.includes(part), `the help does not mention ${part}`);
  for (const k of Object.keys(example.mainnet)) assert.ok(text.includes(`mainnet.${k}`), `the help does not explain mainnet.${k}`);
  for (const k of ["rpcSecondary", "archivalRpcSecondary", "bountyYocto"]) assert.ok(text.includes(k), `the help does not explain ${k}`);
  assert.ok(!/ed25519:[1-9A-HJ-NP-Za-km-z]{20,}/.test(text), "the help shows the key file's shape, never a key");
});

test("cli: `mainnet help` prints it with no deployments file, no key and no network, and a bad command points to it", () => {
  const env = { ...process.env, KAIGEN_DEPLOYMENTS: path.join(os.tmpdir(), "kaigen-no-such-deployments.json") };
  delete env.KAIGEN_DEPLOYER_KEY_FILE;
  const r = spawnSync(process.execPath, [bin, "mainnet", "help"], { encoding: "utf8", env, timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), mainnetHelp().trim());
  const bad = spawnSync(process.execPath, [bin, "mainnet", "frobnicate"], { encoding: "utf8", env, timeout: 30_000 });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /mainnet help/);
});

// ---- the Makefile -------------------------------------------------------------------------------
// `make` is not installed on the machine this was written on, so the Makefile is checked as text, and the guard line
// of each recipe is run through `sh` exactly as make would run it.

const makefile = read("Makefile");

/** { target: { prereqs, recipe: [lines without the leading tab] } } */
function rules(text) {
  const out = {};
  let current = null;
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z][\w-]*):(.*)$/.exec(line);
    if (m) current = out[m[1]] = { prereqs: m[2].trim(), recipe: [] };
    else if (line.startsWith("\t") && current) current.recipe.push(line.slice(1));
  }
  return out;
}

test("Makefile: LF line endings only (GNU make hands a trailing CR to the shell, which breaks every recipe line on Linux)", () => {
  assert.ok(!makefile.includes("\r"));
});

test("Makefile: every phony target has a rule, and the scripts, tests and commands its recipes call exist", () => {
  const r = rules(makefile);
  const phony = (/^\.PHONY:(.*)$/m.exec(makefile)?.[1] ?? "").trim().split(/\s+/);
  assert.deepEqual([...phony].sort(), Object.keys(r).sort(), ".PHONY and the rules disagree");
  const binSource = fs.readFileSync(bin, "utf8");
  for (const [name, { recipe }] of Object.entries(r)) {
    for (const line of recipe) {
      for (const [, file] of line.matchAll(/\bnode (?!--)(\S+\.mjs)/g)) assert.ok(fs.existsSync(path.join(root, file)), `${name}: ${file} does not exist`);
      for (const [, cmd] of line.matchAll(/jobs\/src\/bin\.mjs (\w+)/g)) assert.match(binSource, new RegExp(`async ${cmd}\\(\\)`), `${name}: bin.mjs has no ${cmd} command`);
      const tests = /^cd (\w+) && node --test (.+)$/.exec(line);
      if (tests) for (const f of tests[2].split(/\s+/)) assert.ok(f.includes("*") || fs.existsSync(path.join(root, tests[1], f)), `${name}: ${tests[1]}/${f} does not exist`);
    }
  }
});

const sh = spawnSync("sh", ["-c", "exit 0"]);
const guard = (target, vars = {}) => {
  const line = rules(makefile)[target].recipe[0].replace(/^@/, "").replace(/\$\(([A-Z_]+)\)/g, (_, v) => vars[v] ?? "");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "make-guard-"));
  try {
    return spawnSync("sh", ["-c", line], { cwd, encoding: "utf8" });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
};

test("Makefile: verify and verify-prelock refuse, saying that nothing was verified, when deployments.json is missing", { skip: Boolean(sh.error) && "no sh on this machine" }, () => {
  for (const target of ["verify", "verify-prelock"]) {
    const r = guard(target);
    assert.equal(r.status, 1, target);
    assert.match(r.stdout, /NOTHING was verified/);
  }
});

test("Makefile: predeploy checks its arguments before it builds anything, and accepts a full set", { skip: Boolean(sh.error) && "no sh on this machine" }, () => {
  assert.equal(rules(makefile).predeploy.prereqs, "", "a prerequisite would run the whole wasm build before the usage error");
  const missing = guard("predeploy");
  assert.equal(missing.status, 2);
  assert.match(missing.stdout + missing.stderr, /usage: make predeploy/);
  const given = guard("predeploy", { INIT: "init.json", DRILL_KEYS: "keys.json", USDC: "usdc.example" });
  assert.equal(given.status, 0, given.stdout + given.stderr);
  assert.ok(rules(makefile).predeploy.recipe.some((l) => l.includes("$(MAKE) build")), "it still builds before it checks the wasm");
});
