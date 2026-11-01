import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkBounty, checkChain, checkCodeHashes, checkDrillCode, checkDrillVaultCode, checkFireTests, checkNoAccessKeys, checkOmens, codeHashOf, makeCrossRpc,
  missingChecks, report, validateGate, verifyAll, verifyRelease, writeGate,
} from "../src/verify.mjs";
import { productionOmens } from "../../scripts/omens.mjs";

const NEAR = 10n ** 24n;
const fc = { FunctionCall: { allowance: "1", receiver_id: "v", method_names: ["send_small"] } };
const key = (public_key, permission = "FullAccess") => ({ public_key, access_key: { nonce: 0, permission } });
const PQ = key("ml-dsa-65-hash:B");
const DAILY = key("ed25519:D", fc);

// Smallest valid wasm modules: an empty one (plus a named custom section so each file hashes
// differently), and one that exports `reset` like a drill build.
const wasm = (tag) => Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0, 2, 1, tag.charCodeAt(0)]);
const DRILL_WASM = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 3, 2, 1, 0, 7, 9, 1, 5, 0x72, 0x65, 0x73, 0x65, 0x74, 0, 0, 10, 4, 1, 2, 0, 0x0b]);

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-"));
  const wasmDir = path.join(dir, "prod");
  const drillDir = path.join(dir, "drill");
  fs.mkdirSync(wasmDir);
  fs.mkdirSync(drillDir);
  fs.writeFileSync(path.join(wasmDir, "kizashi.wasm"), wasm("k"));
  fs.writeFileSync(path.join(wasmDir, "mamori.wasm"), wasm("m"));
  fs.writeFileSync(path.join(drillDir, "kizashi.wasm"), DRILL_WASM);
  fs.writeFileSync(path.join(drillDir, "mamori.wasm"), wasm("d"));
  const dep = {
    network: "mainnet",
    kizashi: "kizashi.near",
    mamoriReference: "vault.near",
    bountyYocto: String(50n * NEAR),
    mainnet: { deployer: "deployer.near" },
    drill: { kizashi: "k.drill", vaults: ["v1.drill"] },
  };
  const omenView = productionOmens().map((o) => ({ ...o, death: null }));
  const claimTx = {
    status: { SuccessValue: "" },
    transaction: { receiver_id: "k.drill", actions: [{ FunctionCall: { method_name: "claim" } }] },
    receipts_outcome: [{ outcome: { executor_id: "k.drill", logs: ['EVENT_JSON:{"standard":"kaigen","event":"claim"}'] } }],
  };
  const tripTx = { status: { SuccessValue: "" }, transaction: { receiver_id: "v1.drill", actions: [{ FunctionCall: { method_name: "trip" } }] }, receipts_outcome: [] };
  const rpc = {
    status: async () => ({ chain_id: "mainnet", sync_info: { latest_block_height: 1000 } }),
    account: async (id) => {
      if (id === dep.kizashi) return { code_hash: codeHashOf(wasm("k")), amount: String(100n * NEAR), storage_usage: 300_000 };
      if (id === "v1.drill") return { code_hash: codeHashOf(wasm("d")) };
      if (id === dep.mamoriReference) return { code_hash: "1111", global_contract_hash: codeHashOf(wasm("m")) };
      if (id === dep.drill.kizashi) return { code_hash: codeHashOf(DRILL_WASM) };
      return null;
    },
    view: async (id, method) => (method === "bounty" ? { near: String(90n * NEAR), usdc_token: "usdc.near" } : omenView),
    accessKeys: async () => [],
    tx: async (hash) => (hash === "c" ? claimTx : tripTx),
  };
  return { dir, wasmDir, drillDir, dep, rpc, omenView, claimTx, tripTx };
}

const writeRecord = (dir, over = {}, name = "0001.json") => {
  const fires = path.join(dir, "fire-tests");
  fs.mkdirSync(fires, { recursive: true });
  fs.writeFileSync(
    path.join(fires, name),
    JSON.stringify({ seq: 1, submitter: "keeper.drill", kizashi: "k.drill", vaults: ["v1.drill"], claim_tx: "c", claim_block: 500, trip_txs: { "v1.drill": "t" }, verified_block: 555, ...over }),
  );
  return fires;
};

const archiveOf = (f, keys) => ({ tx: async (h) => f.rpc.tx(h), accessKeys: async () => keys });
const failures = (rs) => rs.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`).join(" | ");

async function runFire(over = {}, { keys = [PQ], tweak = () => {}, dep: depOver } = {}) {
  const f = fixture();
  const fires = writeRecord(f.dir, over);
  tweak(f);
  return checkFireTests({ rpc: f.rpc, archival: archiveOf(f, keys), dir: fires, dep: { ...f.dep, ...(depOver ?? {}) } });
}

test("verify: a clean deployment passes checks 0 to 3", async () => {
  const { rpc, dep, wasmDir, drillDir } = fixture();
  const all = [
    await checkChain({ rpc, dep }),
    ...(await checkCodeHashes({ rpc, dep, wasmDir })),
    await checkDrillCode({ rpc, dep, drillWasmDir: drillDir }),
    await checkDrillVaultCode({ rpc, dep, drillWasmDir: drillDir }),
    await checkOmens({ rpc, dep }),
    await checkNoAccessKeys({ rpc, dep }),
  ];
  assert.equal(failures(all), "");
});

test("verify: a testnet or hostile RPC does not pass as mainnet", async () => {
  const { rpc, dep } = fixture();
  const r = await checkChain({ rpc: { ...rpc, status: async () => ({ chain_id: "testnet" }) }, dep });
  assert.equal(r.ok, false);
  assert.match(r.detail, /testnet/);
});

test("verify: changed code, a drill build shipped as production, wrong omen data and a leftover key each fail", async () => {
  const { rpc, dep, wasmDir, omenView } = fixture();
  fs.writeFileSync(path.join(wasmDir, "kizashi.wasm"), wasm("x"));
  assert.equal((await checkCodeHashes({ rpc, dep, wasmDir }))[0].ok, false);

  fs.writeFileSync(path.join(wasmDir, "kizashi.wasm"), DRILL_WASM);
  const leak = (await checkCodeHashes({ rpc, dep, wasmDir })).find((r) => r.name.includes("drill entry point"));
  assert.equal(leak.ok, false);
  assert.match(leak.detail, /reset/);

  const keyed = omenView.map((o, i) => (i === 0 ? { ...o, public_key: "00".repeat(32) } : o));
  assert.equal((await checkOmens({ rpc: { ...rpc, view: async () => keyed }, dep })).ok, false);
  assert.equal((await checkOmens({ rpc: { ...rpc, view: async () => omenView.slice(1) }, dep })).ok, false, "a missing omen fails too");
  const curve = omenView.map((o, i) => (i === 1 ? { ...o, curve: "Ed25519" } : o));
  assert.match((await checkOmens({ rpc: { ...rpc, view: async () => curve }, dep })).detail, /curve/);
  const level = omenView.map((o, i) => (i === 0 ? { ...o, level: "Warning" } : o));
  assert.match((await checkOmens({ rpc: { ...rpc, view: async () => level }, dep })).detail, /level/);

  assert.equal((await checkNoAccessKeys({ rpc: { ...rpc, accessKeys: async () => [PQ] }, dep })).ok, false);
});

test("verify: an omen that really broke is reported, not treated as a derivation failure", async () => {
  const { rpc, dep, omenView } = fixture();
  const broken = omenView.map((o, i) => (i === 0 ? { ...o, death: { block: "1", claimant: "x", signature: "00" } } : o));
  const r = await checkOmens({ rpc: { ...rpc, view: async () => broken }, dep });
  assert.equal(r.ok, true);
  assert.match(r.detail, /already broken: ed25519-omen/);
});

test("verify: a check that cannot run fails and says so", async () => {
  const { dep } = fixture();
  const down = { view: async () => { throw new Error("rpc down"); } };
  const r = await checkOmens({ rpc: down, dep });
  assert.equal(r.ok, false);
  assert.match(r.detail, /could not check: rpc down/);
});

test("verify: a genuine fire test passes", async () => {
  const rs = await runFire();
  assert.equal(failures(rs), "");
  assert.ok(rs.length >= 2); // the test itself, and recency
});

test("verify: keys still present at the recorded block fail", async () => {
  assert.match(failures(await runFire({}, { keys: [PQ, DAILY] })), /still had classical keys at block 555/);
  assert.match(failures(await runFire({}, { keys: Object.assign([PQ], { truncated: true }) })), /too many keys/);
});

test("verify: evidence must be the right transactions on the right contracts", async () => {
  // A claim that hit some other contract.
  assert.match(failures(await runFire({}, { tweak: (f) => (f.claimTx.transaction.receiver_id = "other.near") })), /not a claim on the drill Kizashi/);
  // A claim-looking log emitted by a different contract.
  assert.match(failures(await runFire({}, { tweak: (f) => (f.claimTx.receipts_outcome[0].outcome.executor_id = "evil.near") })), /emitted no claim event/);
  // A trip that was really some other method, or on some other account.
  assert.match(failures(await runFire({}, { tweak: (f) => (f.tripTx.transaction.actions[0].FunctionCall.method_name = "send_small") })), /not a trip on that vault/);
  assert.match(failures(await runFire({}, { tweak: (f) => (f.tripTx.transaction.receiver_id = "bystander.near") })), /not a trip on that vault/);
  // A failed transaction.
  assert.match(failures(await runFire({}, { tweak: (f) => (f.claimTx.status = { Failure: {} }) })), /claim tx did not succeed/);
});

test("verify: a record cannot pick its own vaults or Kizashi", async () => {
  assert.match(failures(await runFire({ vaults: ["friendly.near"] })), /not the configured drill vaults/);
  assert.match(failures(await runFire({ vaults: [] })), /not the configured drill vaults/);
  assert.match(failures(await runFire({ kizashi: "other.drill" })), /different Kizashi/);
  assert.match(failures(await runFire({ trip_txs: {} })), /no trip tx recorded/);
  assert.match(failures(await runFire({ verified_block: 100 })), /before the claim/);
});

test("verify: the drill must be configured, or there is nothing to check against", async () => {
  const rs = await runFire({}, { dep: { drill: undefined } });
  assert.equal(rs[0].ok, false);
});

test("verify: stale fire tests and a newer failed attempt both fail", async () => {
  const stale = fixture();
  const fires = writeRecord(stale.dir);
  const far = { ...stale.rpc, status: async () => ({ chain_id: "mainnet", sync_info: { latest_block_height: 555 + 2_000_000 } }) };
  const rs = await checkFireTests({ rpc: far, archival: archiveOf(stale, [PQ]), dir: fires, dep: stale.dep });
  assert.match(failures(rs), /fire tests are recent: latest verified 2,000,000 blocks ago/);

  const f = fixture();
  const dir2 = writeRecord(f.dir);
  writeRecord(f.dir, { seq: 2 }, "0002.failed.json");
  const rs2 = await checkFireTests({ rpc: f.rpc, archival: archiveOf(f, [PQ]), dir: dir2, dep: f.dep });
  assert.match(failures(rs2), /0002\.failed\.json is a failed attempt newer than the last success/);
});

test("verify: no fire tests published is a failure, not a pass", async () => {
  const { dir, rpc, dep } = fixture();
  const r = await checkFireTests({ rpc, archival: rpc, dir: path.join(dir, "fire-tests"), dep });
  assert.equal(r[0].ok, false);
});

test("verify: report counts failures and verifyAll runs every check", async () => {
  const f = fixture();
  const fires = writeRecord(f.dir);
  const results = await verifyAll({ rpc: f.rpc, archival: archiveOf(f, [PQ]), dep: f.dep, wasmDir: f.wasmDir, drillWasmDir: f.drillDir, fireTestDir: fires });
  assert.equal(failures(results), "");
  const ok = report(results);
  assert.equal(ok.ok, true);
  assert.match(ok.text, /All \d+ checks passed/);
  const bad = report([...results, { name: "x", ok: false, detail: "nope" }]);
  assert.equal(bad.ok, false);
  assert.match(bad.text, /FAIL {2}x/);
});

// ---- release mode: J-net, J-hash, J-rpc ------------------------------------------------------

const FULL_KEY = key("ed25519:K");
const DEPLOYER_FULL_KEY = key("ed25519:DEPLOYER");
const HOSTS = ["https://rpc.alpha.example", "https://rpc.beta.example"];
const KEYS_CHECK = "kizashi access keys are readable (the lock deletes them)";

/** Two nodes over the same fixture chain. Every block id they are asked to read at lands in `seen`. */
function releaseFixture({ keys = [], height = [900, 900], hash = ["BH", "BH"] } = {}) {
  const f = fixture();
  const seen = [];
  const node = (i) => ({
    ...f.rpc,
    finalBlock: async () => ({ height: height[i], hash: hash[i] }),
    status: async () => ({ chain_id: "mainnet", protocol_version: 86, sync_info: { latest_block_height: 1000 } }),
    account: async (id, b) => (seen.push(b), f.rpc.account(id)),
    view: async (id, m, a, b) => (seen.push(b), f.rpc.view(id, m)),
    // `keys` are Kizashi's. The deployer holds its own full-access key and has left none on the Mamori reference
    // (T3), as in a clean deployment; answering every account with Kizashi's keys would put one key on both.
    accessKeys: async (id, b) => (seen.push(b), id === f.dep.mainnet.deployer ? [DEPLOYER_FULL_KEY] : id === f.dep.mamoriReference ? [] : keys),
  });
  const archive = () => ({ tx: async (h) => f.rpc.tx(h), accessKeys: async () => [PQ] });
  return { ...f, a: node(0), b: node(1), seen, archivals: [archive(), archive()] };
}

const NOW = new Date("2026-11-09T12:00:00Z");
const release = (f, over = {}) =>
  verifyRelease({
    rpcs: [f.a, f.b], hosts: HOSTS, archivals: f.archivals, dep: f.dep, wasmDir: f.wasmDir, drillWasmDir: f.drillDir,
    fireTestDir: writeRecord(f.dir), preLock: true, now: () => NOW, ...over,
  });
const byName = (rs, name) => rs.find((r) => r.name === name);

test("release: a clean mainnet deployment passes, every read is pinned to one block, and a gate is produced", async () => {
  const f = releaseFixture({ keys: [FULL_KEY] });
  const { results, gate } = await release(f);
  assert.equal(failures(results), "");
  assert.equal(gate.ok, true);
  assert.equal(gate.stage, "pre-lock");
  assert.equal(gate.network, "mainnet");
  assert.deepEqual(gate.block, { height: 900, hash: "BH" });
  assert.equal(gate.kizashiCodeHash, codeHashOf(wasm("k")));
  assert.ok(f.seen.length > 0 && f.seen.every((b) => b === "BH"), `unpinned read: ${f.seen}`);
  assert.deepEqual(missingChecks(results, "pre-lock"), []);
});

test("release: reads are pinned to the older of the two final blocks, so the lagging node can answer", async () => {
  const f = releaseFixture({ keys: [FULL_KEY], height: [905, 900], hash: ["AHEAD", "BEHIND"] });
  const { results } = await release(f);
  assert.equal(failures(results), "");
  assert.ok(f.seen.every((b) => b === "BEHIND"));
});

test("release: the deployer's full-access key left on the Mamori reference fails the run, the gate and the lock's acceptance of it", async () => {
  const f = releaseFixture({ keys: [FULL_KEY] });
  for (const node of [f.a, f.b]) {
    const clean = node.accessKeys;
    node.accessKeys = async (id, b) => (id === f.dep.mamoriReference ? [DEPLOYER_FULL_KEY] : clean(id, b));
  }
  const { results, gate } = await release(f);
  assert.match(failures(results), /deployer key is not left on the mamori reference: .*ed25519:DEPLOYER/);
  assert.equal(gate.ok, false);
  const verdict = validateGate({ gate, dep: f.dep, now: NOW });
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join(" | "), /deployer key is not left on the mamori reference/);
});

test("release: a deployments file that says testnet fails, even when the node says mainnet", async () => {
  const f = releaseFixture({ keys: [FULL_KEY] });
  f.dep.network = "testnet";
  const { results, gate } = await release(f);
  assert.match(failures(results), /deployments file is mainnet/);
  assert.equal(gate.ok, false);
});

test("release: a node on another network fails (the expectation is not taken from the file under test)", async () => {
  const f = releaseFixture({ keys: [FULL_KEY] });
  const wrong = { ...f.a, status: async () => ({ chain_id: "testnet", protocol_version: 88, sync_info: {} }) };
  // A file that claims testnet no longer makes a testnet node acceptable.
  const r = await checkChain({ rpc: wrong, dep: { ...f.dep, network: "testnet" }, expected: "mainnet" });
  assert.equal(r.ok, false);
  assert.match(r.detail, /expected mainnet/);
  const g = releaseFixture({ keys: [FULL_KEY] });
  const { results } = await release(g, { rpcs: [wrong, { ...g.b, status: wrong.status }] });
  assert.match(failures(results), /rpc is on the expected network/);
  // One host on mainnet and one on testnet is a disagreement, not a pass.
  const h = releaseFixture({ keys: [FULL_KEY] });
  assert.match(failures((await release(h, { rpcs: [h.a, { ...h.b, status: wrong.status }] })).results), /rpc is on the expected network: could not check: rpc hosts disagree/);
});

test("release: two RPC hosts that disagree about any read fail the check, the gate and the pin", async () => {
  const omenView = productionOmens().map((o) => ({ ...o, death: null }));
  const viewDisagrees = releaseFixture({ keys: [FULL_KEY] });
  viewDisagrees.b.view = async (id, m) => (m === "omens" ? omenView.slice(1) : viewDisagrees.rpc.view(id, m));
  const a = await release(viewDisagrees);
  assert.match(failures(a.results), /omens re-derive from their seeds: could not check: rpc hosts disagree/);
  assert.equal(a.gate.ok, false);

  const codeDisagrees = releaseFixture({ keys: [FULL_KEY] });
  const real = codeDisagrees.b.account;
  codeDisagrees.b.account = async (id) => (id === "kizashi.near" ? { ...(await real(id)), code_hash: "EVIL" } : real(id));
  assert.match(failures((await release(codeDisagrees)).results), /code hash: kizashi: could not check: rpc hosts disagree/);

  const keysDisagree = releaseFixture({ keys: [FULL_KEY] });
  keysDisagree.b.accessKeys = async () => [];
  assert.match(failures((await release(keysDisagree)).results), /kizashi access keys.*disagree/);

  const forked = releaseFixture({ keys: [FULL_KEY] });
  forked.b.account = async () => { throw Object.assign(new Error("UNKNOWN_BLOCK"), { kind: "RPC" }); }; // the other host has never seen that block
  assert.match(failures((await release(forked)).results), /UNKNOWN_BLOCK/);

  const pinFails = releaseFixture({ keys: [FULL_KEY] });
  pinFails.b.finalBlock = async () => { throw new Error("rpc down"); };
  const p = await release(pinFails);
  assert.match(failures(p.results), /rpc hosts agree on one final block: could not check: rpc down/);
  assert.equal(p.gate.ok, false);
});

test("release: tx evidence is compared across the archival hosts too", async () => {
  const f = releaseFixture({ keys: [FULL_KEY] });
  f.archivals[1].tx = async (h) => ({ ...(await f.rpc.tx(h)), status: { Failure: {} } });
  assert.match(failures((await release(f)).results), /fire test #1.*disagree/);
  const missing = releaseFixture({ keys: [FULL_KEY] });
  assert.match(failures((await release(missing, { archivals: undefined })).results), /fire test #1.*archival/);
});

test("release: two hosts run by one operator are not independent", async () => {
  const f = releaseFixture({ keys: [FULL_KEY] });
  assert.match(failures((await release(f, { hosts: ["https://free.rpc.fastnear.com", "https://archival-rpc.mainnet.fastnear.com"] })).results), /rpc hosts are independent/);
  assert.match(failures((await release(f, { hosts: ["https://rpc.alpha.example"] })).results), /rpc hosts are independent/);
  assert.match(failures((await release(f, { hosts: undefined })).results), /rpc hosts are independent/);
});

test("release: an unfunded Kizashi fails, and so does a bounty nobody configured", async () => {
  const f = releaseFixture({ keys: [FULL_KEY] });
  const lowAccount = async (id) => (id === "kizashi.near" ? { code_hash: codeHashOf(wasm("k")), amount: String(10n * NEAR), storage_usage: 300_000 } : f.rpc.account(id));
  const lowView = async (id, m) => (m === "bounty" ? { near: String(7n * NEAR), usdc_token: "usdc.near" } : f.rpc.view(id, m));
  const low = await checkBounty({ rpc: { account: lowAccount, view: lowView }, dep: f.dep });
  assert.equal(low.ok, false);
  assert.match(low.detail, /below/);

  // Locked storage is not spendable: 100 NEAR with 99 NEAR of storage cannot pay a 50 NEAR bounty.
  const heavy = async (id) => (id === "kizashi.near" ? { code_hash: "x", amount: String(100n * NEAR), storage_usage: 9_900_000 } : null);
  assert.equal((await checkBounty({ rpc: { account: heavy, view: async () => ({ near: String(90n * NEAR) }) }, dep: f.dep })).ok, false, "the account's own storage reserve is not bounty");

  // The contract's own bounty() figure must agree it is funded.
  assert.equal((await checkBounty({ rpc: { account: f.rpc.account, view: lowView }, dep: f.dep })).ok, false);
  assert.equal((await checkBounty({ rpc: f.rpc, dep: f.dep })).ok, true);

  for (const bountyYocto of [undefined, "", "fifty", "-5", "0", 50]) {
    const none = await checkBounty({ rpc: f.rpc, dep: { ...f.dep, bountyYocto } });
    assert.equal(none.ok, false, `bountyYocto ${JSON.stringify(bountyYocto)} must fail`);
  }
  const g = releaseFixture({ keys: [FULL_KEY] });
  g.a.account = g.b.account = async (id) => (id === "kizashi.near" ? { code_hash: codeHashOf(wasm("k")), amount: "1", storage_usage: 1 } : g.rpc.account(id));
  const { results, gate } = await release(g);
  assert.match(failures(results), /kizashi balance covers the bounty/);
  assert.equal(gate.ok, false);
});

test("release: the drill vault's code is hash-checked (J-hash)", async () => {
  const f = fixture();
  assert.equal((await checkDrillVaultCode({ rpc: f.rpc, dep: f.dep, drillWasmDir: f.drillDir })).ok, true);
  const wrong = { ...f.rpc, account: async (id) => (id === "v1.drill" ? { code_hash: "SOMETHING-ELSE" } : f.rpc.account(id)) };
  const r = await checkDrillVaultCode({ rpc: wrong, dep: f.dep, drillWasmDir: f.drillDir });
  assert.equal(r.ok, false);
  assert.match(r.detail, /v1\.drill/);
  const gone = { ...f.rpc, account: async () => null };
  assert.equal((await checkDrillVaultCode({ rpc: gone, dep: f.dep, drillWasmDir: f.drillDir })).ok, false);
  assert.equal((await checkDrillVaultCode({ rpc: f.rpc, dep: { ...f.dep, drill: { ...f.dep.drill, vaults: [] } }, drillWasmDir: f.drillDir })).ok, false);
  // Global-contract vaults are compared by the hash they reference.
  const global = { ...f.rpc, account: async (id) => (id === "v1.drill" ? { code_hash: "1111", global_contract_hash: codeHashOf(wasm("d")) } : f.rpc.account(id)) };
  assert.equal((await checkDrillVaultCode({ rpc: global, dep: f.dep, drillWasmDir: f.drillDir })).ok, true);
  // The legacy single-rpc run checks it too.
  const results = await verifyAll({ rpc: wrong, archival: f.rpc, dep: f.dep, wasmDir: f.wasmDir, drillWasmDir: f.drillDir, fireTestDir: path.join(f.dir, "none") });
  assert.match(failures(results), /code hash: drill vault/);
});

test("release: before the lock the keys must be readable, after it there must be none", async () => {
  const keyed = releaseFixture({ keys: [FULL_KEY] });
  const post = await release(keyed, { preLock: false });
  assert.match(failures(post.results), /kizashi has no access keys/);
  assert.equal(post.gate.stage, "post-lock");
  assert.equal(post.gate.ok, false);

  const empty = releaseFixture({ keys: [] });
  const done = await release(empty, { preLock: false });
  assert.equal(failures(done.results), "");
  assert.equal(done.gate.stage, "post-lock");

  const pre = await release(keyed, { preLock: true });
  assert.equal(byName(pre.results, KEYS_CHECK).ok, true);
  const gone = releaseFixture({ keys: [FULL_KEY] });
  gone.a.accessKeys = gone.b.accessKeys = async () => null;
  assert.equal(byName((await release(gone, { preLock: true })).results, KEYS_CHECK).ok, false);
});

test("release: a check that is missing from the results fails the whole run (a check that did not run is not a pass)", async () => {
  const f = releaseFixture({ keys: [FULL_KEY] });
  const { results } = await release(f);
  const without = results.filter((r) => r.name !== "code hash: kizashi");
  assert.deepEqual(missingChecks(without, "pre-lock"), ["code hash: kizashi"]);
  assert.deepEqual(missingChecks(results.filter((r) => !r.name.startsWith("fire test #")), "pre-lock"), ["fire test #<n>"]);

  // verifyRelease notices on its own: with no fire test records there is no "fire test #n" result at all.
  const noFires = await release(f, { fireTestDir: path.join(f.dir, "empty") });
  assert.match(failures(noFires.results), /fire tests published/);
  assert.match(failures(noFires.results), /all required checks ran.*fire test #<n>/);
  assert.equal(noFires.gate.ok, false);
});

test("gate: only a fresh, complete, passing, pre-lock gate for this Kizashi is accepted", async () => {
  const f = releaseFixture({ keys: [FULL_KEY] });
  const { gate } = await release(f);
  const ok = (g, over = {}) => validateGate({ gate: g, dep: f.dep, now: NOW, ...over });
  assert.deepEqual(ok(gate), { ok: true, problems: [] });

  const bad = (g, re, over) => {
    const r = ok(g, over);
    assert.equal(r.ok, false, `should be rejected: ${re}`);
    assert.match(r.problems.join(" | "), re);
  };
  bad({ ...gate, createdAt: "2026-11-08T11:59:59Z" }, /older than 24 hours/);
  assert.equal(ok({ ...gate, createdAt: "2026-11-08T12:00:01Z" }).ok, true, "just inside the window");
  bad({ ...gate, createdAt: "2026-11-09T13:00:00Z" }, /in the future/);
  bad({ ...gate, createdAt: "yesterday" }, /createdAt/);
  bad({ ...gate, ok: false }, /did not pass/);
  bad({ ...gate, checks: gate.checks.map((c, i) => (i === 3 ? { ...c, ok: false } : c)) }, /failed check/);
  bad({ ...gate, checks: gate.checks.filter((c) => c.name !== "omens re-derive from their seeds") }, /missing required check.*omens re-derive/);
  bad({ ...gate, checks: [] }, /missing required check/);
  bad({ ...gate, stage: "post-lock" }, /pre-lock/);
  bad({ ...gate, network: "testnet" }, /mainnet/);
  bad({ ...gate, kizashi: "other.near" }, /other\.near/);
  bad({ ...gate, kind: "something" }, /not a KAIGEN release gate/);
  bad({ ...gate, kizashiCodeHash: undefined }, /code hash/);
  bad(null, /not a KAIGEN release gate/);
  bad(gate, /older than 24 hours/, { now: new Date("2026-11-11T00:00:00Z") });
});

test("gate: written with a timestamp in its name, and read back unchanged", async () => {
  const f = releaseFixture({ keys: [FULL_KEY] });
  const { gate } = await release(f);
  const dir = path.join(f.dir, "gates");
  const file = writeGate(dir, gate);
  assert.match(path.basename(file), /^release-gate-2026-11-09T12-00-00.*\.json$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), JSON.parse(JSON.stringify(gate)));
  // A failing gate is written too (as evidence), but can never be accepted.
  const failing = writeGate(dir, { ...gate, ok: false, createdAt: "2026-11-09T12:00:01.000Z" });
  assert.ok(fs.existsSync(failing));
  assert.notEqual(failing, file);
});

test("cross rpc: needs exactly two nodes", () => {
  assert.throws(() => makeCrossRpc([{}]), /two/);
  assert.throws(() => makeCrossRpc([{}, {}, {}]), /two/);
});
