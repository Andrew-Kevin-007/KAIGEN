import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { latestFireTest, loadDeployments } from "./deployments-file.ts";
import { parseDeployments } from "./deployments.ts";

// Scratch space beside the project (on the same drive), removed when the tests end.
const CACHE = path.join(import.meta.dirname, "..", "node_modules", ".cache");
fs.mkdirSync(CACHE, { recursive: true });
const root = fs.mkdtempSync(path.join(CACHE, "kaigen-deploy-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
/** A fresh tree: <root>/N/app (the app dir) with <root>/N beside it, where deployments.json and fire-tests/ live. */
function tree(files: Record<string, unknown>): { appDir: string; base: string } {
  const base = path.join(root, String(++n));
  const appDir = path.join(base, "app");
  fs.mkdirSync(appDir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(base, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
  }
  return { appDir, base };
}

const TX = (c: string) => c.repeat(44);
const record = (seq: number, over: Record<string, unknown> = {}) => ({
  drill: true,
  seq,
  kizashi: "drill-kizashi.dep.testnet",
  omen_id: "ed25519-test",
  vaults: ["v1.dep.testnet"],
  steps: [{ step: "claim", ok: true }],
  claim_tx: TX("B"),
  claim_block: 100,
  verified_block: 120,
  trip_txs: { "v1.dep.testnet": TX("C") },
  pq_send_txs: { "v1.dep.testnet": TX("D") },
  rearm_txs: { "v1.dep.testnet": TX("E") },
  ...over,
});

const FULL = {
  network: "testnet",
  rpc: "https://rpc.testnet.near.org",
  rpcSecondary: "https://secondary.example.org",
  kizashi: "kizashi.dep.testnet",
  mamoriReference: "mamori.dep.testnet",
  bountyYocto: "1000",
  vaults: ["v1.dep.testnet"],
  mainnet: { deployer: "dep.near", kizashiInit: "data/mainnet/kizashi-init.json" },
  hinomi: { accountsFile: "secret-accounts.json", accounts: [] },
  drill: { kizashi: "drill-kizashi.dep.testnet", vaults: ["v1.dep.testnet"], dailyKeys: { "v1.dep.testnet": "ed25519:SECRETISH" } },
};

test("APP-D5: with nothing configured the build gets no setting, and the log says why", () => {
  const { appDir } = tree({});
  const r = loadDeployments({}, appDir);
  assert.equal(r.text, undefined);
  assert.match(r.source, /not configured/);
  assert.deepEqual(r.problems, []);
});

test("APP-D5: ../deployments.json is read when present, and only its public fields reach the browser bundle", () => {
  const { appDir } = tree({ "deployments.json": FULL });
  const r = loadDeployments({}, appDir);
  assert.deepEqual(r.problems, []);
  const sent = JSON.parse(r.text!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(sent).sort(), ["drill", "kizashi", "mamoriReference", "network", "rpc"]);
  assert.deepEqual(sent.drill, { kizashi: "drill-kizashi.dep.testnet" }, "the drill's vault list and daily keys stay out");
  assert.doesNotMatch(r.text!, /SECRETISH|secret-accounts|secondary\.example|bountyYocto|kizashiInit/);
  const d = parseDeployments(r.text);
  assert.equal(d.kizashi, "kizashi.dep.testnet");
  assert.equal(d.network, "testnet");
});

test("APP-D5: KAIGEN_DEPLOYMENTS names the file; a named file that is missing is a problem, not a silent fall-back", () => {
  const { appDir } = tree({ "other.json": { network: "testnet", kizashi: "k2.dep.testnet" }, "deployments.json": { network: "testnet", kizashi: "k1.dep.testnet" } });
  const named = loadDeployments({ KAIGEN_DEPLOYMENTS: "../other.json" }, appDir);
  assert.equal(parseDeployments(named.text).kizashi, "k2.dep.testnet");
  const missing = loadDeployments({ KAIGEN_DEPLOYMENTS: "../nope.json" }, appDir);
  assert.equal(missing.text, undefined);
  assert.match(missing.problems.join(" "), /does not exist/);
});

test("APP-D5: a file that is not JSON, or not an object, is a problem and ships nothing", () => {
  const bad = tree({ "deployments.json": "{oops" });
  assert.match(loadDeployments({}, bad.appDir).problems.join(" "), /could not be read as JSON/);
  assert.equal(loadDeployments({}, bad.appDir).text, undefined);
  const arr = tree({ "deployments.json": [] });
  assert.match(loadDeployments({}, arr.appDir).problems.join(" "), /must hold a JSON object/);
});

test("APP-D5: NEXT_PUBLIC_DEPLOYMENTS set directly wins over any file", () => {
  const { appDir } = tree({ "deployments.json": { network: "testnet", kizashi: "from-file.dep.testnet" } });
  const r = loadDeployments({ NEXT_PUBLIC_DEPLOYMENTS: JSON.stringify({ network: "testnet", kizashi: "direct.dep.testnet" }) }, appDir);
  assert.equal(r.source, "NEXT_PUBLIC_DEPLOYMENTS");
  assert.equal(parseDeployments(r.text).kizashi, "direct.dep.testnet");
});

test("APP-D5: a setting the app would reject is reported by the build (the production build stops on it)", () => {
  const { appDir } = tree({ "deployments.json": { network: "testnet", kizashi: "kizashi.near" } });
  const r = loadDeployments({}, appDir);
  assert.match(r.problems.join(" "), /mainnet account, but network is testnet/);
});

test("APP-D6: the newest usable fire test fills the drill record; an unusable newer one is skipped", () => {
  const { appDir, base } = tree({
    "deployments.json": { network: "testnet", kizashi: "kizashi.dep.testnet" },
    "fire-tests/0001.json": record(1),
    "fire-tests/0002.json": record(2),
    "fire-tests/0003.json": record(3, { claim_tx: "broken" }),
    "fire-tests/notes.txt": "not a record",
  });
  const found = latestFireTest(path.join(base, "fire-tests"));
  assert.equal(path.basename(found!.file), "0002.json");
  const d = parseDeployments(loadDeployments({}, appDir).text);
  assert.equal(d.drillRecord?.seq, 2);
  assert.deepEqual(d.problems, []);
  assert.equal(latestFireTest(path.join(base, "no-such-dir")), null);
});

test("APP-D6: with only fire tests and no settings, the recorded drill is shown and nothing else is invented", () => {
  const { appDir } = tree({ "fire-tests/0001.json": record(1) });
  const r = loadDeployments({}, appDir);
  assert.match(r.source, /only the recorded drill/);
  const d = parseDeployments(r.text);
  assert.equal(d.kizashi, null);
  assert.equal(d.drillRecord?.seq, 1);
});
