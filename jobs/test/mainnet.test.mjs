// Tests for the mainnet deploy tooling. Everything runs against an in-memory chain: the library under test has
// no way to send (it is handed a `send` per call), and the global fetch is replaced by a tripwire, so no test can
// reach any network, let alone send a transaction.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { base58 } from "@scure/base";
import { makeRpc, RpcError } from "../src/rpc.mjs";
import { buildPlan, executeStage, findLatestGate, loadInputs, lockKizashi, Refused, renderPlan, runGates } from "../src/mainnet.mjs";
import { codeHashOf, COMPLETE_CHECK, GATE_KIND, requiredChecks } from "../src/verify.mjs";
import { productionOmens } from "../../scripts/omens.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Temp dirs are removed when the file's tests finish, so the run leaves nothing behind. */
const madeDirs = [];
const mkTmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  madeDirs.push(dir);
  return dir;
};
after(() => madeDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const root = path.join(here, "..", "..");
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = () => {
    throw new Error("a mainnet test tried to use the network");
  };
});
after(() => {
  globalThis.fetch = realFetch;
});

// ---- fixtures -----------------------------------------------------------------------------------

const NEAR = 10n ** 24n;
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const PUB = "ed25519:DEPLOYERPUBLICKEY";
/** Kizashi's own key: a different key from the deployer's, as the plan requires. */
const KPUB = "ed25519:KIZASHIPUBLICKEY";
/** An access key that has signed (its nonce moved off the block_height * 1e6 it started at) and one that never has. */
const SIGNED = 222_000_000_000_001;
const UNSIGNED = 222_000_000_000_000;
const EMPTY = "11111111111111111111111111111111";
const NOW = new Date("2026-11-10T12:00:00Z");
// Fixed, made-up PUBLIC values. The tests never create or read a secret key.
const DRILL_OMENS = [
  { id: "drill-ed25519-omen", curve: "Ed25519", level: "Kaigen", public_key: "11".repeat(32) },
  { id: "drill-secp256k1-omen", curve: "Secp256k1", level: "Kaigen", public_key: "22".repeat(64) },
];

/** A valid wasm module exporting exactly these functions; different names give different code hashes. */
function wasmWith(names) {
  const bytes = (s) => [...Buffer.from(s)];
  const n = names.length;
  const section = (id, body) => [id, body.length, ...body];
  return Buffer.from([
    0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...section(1, [1, 0x60, 0, 0]),
    ...section(3, [n, ...names.map(() => 0)]),
    ...section(7, [n, ...names.flatMap((name, i) => [name.length, ...bytes(name), 0, i])]),
    ...section(10, [n, ...names.flatMap(() => [2, 0, 0x0b])]),
  ]);
}
const KIZASHI_EXPORTS = ["new", "claim", "era", "omens", "bounty"];
const WASM = {
  prod: { kizashi: wasmWith([...KIZASHI_EXPORTS, "claim_message"]), mamori: wasmWith(["init", "trip", "send_small"]) },
  drill: { kizashi: wasmWith([...KIZASHI_EXPORTS, "reset"]), mamori: wasmWith(["init", "trip", "drill_only"]) },
};
const makeInputs = () => ({
  wasm: { prod: { ...WASM.prod }, drill: { ...WASM.drill } },
  kizashiInit: { omens: productionOmens(), usdc: USDC },
  drillInit: { omens: DRILL_OMENS, usdc: null },
  drillKeys: DRILL_OMENS.map((o) => o.public_key),
});
const makeDep = (over = {}) => ({
  network: "mainnet",
  kizashi: "kizashi.near",
  mamoriReference: "mamori.deployer.near",
  drill: { kizashi: "drill-kizashi.deployer.near", vaults: ["drill-vault.deployer.near"] },
  mainnet: { deployer: "deployer.near", marginNear: "0.5" },
  ...over,
});

const acct = (over = {}) => ({ amount: 0n, storage_usage: 182, code_hash: EMPTY, keys: [], views: {}, ...over });
const fullKey = (public_key, nonce = 0) => ({ public_key, access_key: { nonce, permission: "FullAccess" } });

/** An in-memory chain: reads for the library, and a `send` that applies actions the way the protocol would. */
function sim({ chainId = "mainnet", protocol = 86, latest = 88, accounts = {}, mldsa = true, intents = true, ignoreDeletes = false } = {}) {
  const registered = new Set(["kizashi.near"]);
  const world = {
    "deployer.near": acct({ amount: 100n * NEAR, keys: [PUB] }),
    [USDC]: acct({ code_hash: "usdc-code", views: { storage_balance_of: ({ account_id }) => (registered.has(account_id) ? { total: "1", available: "0" } : null) } }),
    ...accounts,
  };
  if (intents) world["intents.near"] = acct({ code_hash: "intents-code", code: wasmWith(["ft_deposit", "execute_intents"]) });
  const calls = [];
  const sent = [];
  const rpc = {
    status: async () => ({ chain_id: chainId, protocol_version: protocol, latest_protocol_version: latest }),
    account: async (id) => (world[id] ? { amount: String(world[id].amount), storage_usage: world[id].storage_usage, code_hash: world[id].code_hash } : null),
    accessKeys: async (id) => (world[id] ? world[id].keys.map((k) => fullKey(k, world[id].nonces?.[k])) : null),
    view: async (id, method, args = {}) => {
      const v = world[id]?.views[method];
      if (!v) throw new Error(`no view ${method} on ${id}`);
      return v(args);
    },
    call: async (method, params) => {
      calls.push([method, params.request_type]);
      if (params.request_type === "view_access_key") {
        // Real nodes (mainnet 86 and testnet 88, 30 Oct 2026) parse `ml-dsa-65:` keys of 1952 bytes and no other ML-DSA spelling.
        const [type, body = ""] = params.public_key.split(":");
        if (!mldsa || type !== "ml-dsa-65") throw new RpcError(`Failed parsing args: unknown key type '${type}'`, { kind: "RPC" });
        const bytes = base58.decode(body).length;
        if (bytes !== 1952) throw new RpcError(`Failed parsing args: invalid key length: expected the input of 1952 bytes, but ${bytes} was given`, { kind: "RPC" });
        throw new RpcError(`access key ${params.public_key} does not exist while viewing`, { kind: "UNKNOWN_ACCESS_KEY" });
      }
      if (params.request_type === "view_code") {
        const code = world[params.account_id]?.code;
        if (!code) throw new RpcError(`account ${params.account_id} has no contract code`, { kind: "RPC" });
        return { code_base64: code.toString("base64"), hash: "intents-code" };
      }
      throw new Error(`unexpected rpc call ${method} ${params.request_type}`);
    },
  };
  const apply = (tx) => {
    let target = world[tx.receiverId];
    for (const a of tx.actions) {
      if (a.type === "CreateAccount") {
        if (world[tx.receiverId]) throw new Error("AccountAlreadyExists");
        target = world[tx.receiverId] = acct();
      } else if (!target) throw new Error(`AccountDoesNotExist ${tx.receiverId}`);
      else if (a.type === "Transfer") target.amount += BigInt(a.yocto);
      else if (a.type === "AddKey") target.keys.push(a.publicKey);
      else if (a.type === "DeleteKey") {
        if (!ignoreDeletes) target.keys = target.keys.filter((k) => k !== a.publicKey);
      }
      else if (a.type === "DeployContract") {
        const code = Buffer.from(a.codeBase64, "base64");
        target.code_hash = codeHashOf(code);
        target.storage_usage += code.length;
      } else if (a.type === "FunctionCall" && a.method === "new") {
        target.views.era = () => "Calm";
        target.views.omens = () => a.args.omens.map((o) => ({ ...o, death: null }));
        target.views.bounty = () => ({ near: String(target.amount), usdc_token: a.args.usdc ?? null });
      } else if (a.type === "FunctionCall" && a.method === "init") target.views.era = () => "Calm";
    }
  };
  /** What a key file would give: a sender that signs as `accountId` and fails when the chain does not know that key. */
  const makeLoadKey = (accountId, { failOn, publicKey = accountId === "kizashi.near" ? KPUB : PUB } = {}) => {
    const loaded = [];
    const loadKey = (file) => {
      loaded.push(file);
      return {
        accountId,
        publicKey,
        send: async (tx) => {
          if (!world[tx.signerId]?.keys.includes(publicKey)) throw new Error(`signature invalid for ${tx.signerId}`);
          if (failOn?.(tx, sent.length)) throw new Error("rpc exploded");
          apply(tx);
          sent.push(tx);
          return `HASH${sent.length}`;
        },
      };
    };
    return { loadKey, loaded };
  };
  return { world, rpc, sent, calls, registered, makeLoadKey, apply };
}

const events = () => {
  const log = [];
  return Object.assign((e) => log.push(e), { log });
};

/** Runs one stage with the usual arguments; `over` replaces any of them. */
async function run(stage, s, { accountId = stage === 3 ? "kizashi.near" : "deployer.near", dep = makeDep(), inputs = makeInputs(), loader, ...over } = {}) {
  const key = loader ?? s.makeLoadKey(accountId);
  const log = events();
  const out = await executeStage({ stage, dep, getInputs: () => inputs, rpc: s.rpc, yes: true, keyFile: "key.json", loadKey: key.loadKey, log, ...over });
  return { out, log, key };
}
const refused = async (promise, re) => assert.rejects(promise, (e) => e instanceof Refused && re.test(e.message), `expected a refusal matching ${re}`);
const failures = (rs) => rs.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`).join(" | ");

// ---- the plan -----------------------------------------------------------------------------------

test("plan: stages 1 to 3 list every transaction with signer, receiver, actions and deposits", () => {
  const plan = buildPlan({ dep: makeDep(), inputs: makeInputs(), publicKey: PUB });
  assert.deepEqual(plan.stages.map((s) => s.stage), [1, 2, 3]);
  const ids = plan.stages.flatMap((s) => s.txs.map((t) => t.id));
  assert.deepEqual(ids, ["1.1", "1.2", "1.3", "1.4", "2.1", "2.2", "3.1"]);

  const [s1, s2, s3] = plan.stages;
  assert.equal(s1.keyAccount, "deployer.near");
  assert.equal(s3.keyAccount, "kizashi.near", "the Kizashi key is its own, never the deployer's");
  const by = Object.fromEntries(plan.stages.flatMap((s) => s.txs).map((t) => [t.id, t]));
  // The drill pair: accounts created by the deployer, then deploy + init in ONE transaction signed by the account itself.
  assert.deepEqual([by["1.1"].signer, by["1.1"].receiver], ["deployer.near", "drill-kizashi.deployer.near"]);
  assert.deepEqual(by["1.1"].actions.map((a) => a.type), ["CreateAccount", "Transfer", "AddKey"]);
  assert.equal(by["1.1"].actions[2].publicKey, PUB);
  assert.deepEqual([by["1.2"].signer, by["1.2"].receiver], ["drill-kizashi.deployer.near", "drill-kizashi.deployer.near"]);
  assert.deepEqual(by["1.2"].actions.map((a) => a.type), ["DeployContract", "FunctionCall"]);
  assert.equal(by["1.2"].actions[0].codeBase64, WASM.drill.kizashi.toString("base64"), "the drill build");
  assert.deepEqual(by["1.2"].actions[1].args, { omens: DRILL_OMENS, usdc: null });
  assert.equal(by["1.4"].actions[0].codeBase64, WASM.drill.mamori.toString("base64"));
  assert.deepEqual(by["1.4"].actions[1].args, { kizashi: "drill-kizashi.deployer.near", daily_limit: String(NEAR), delay_secs: 300 });
  // Production Mamori reference, then production Kizashi in a single deploy + init transaction.
  assert.equal(by["2.2"].actions[0].codeBase64, WASM.prod.mamori.toString("base64"));
  assert.equal(s2.txs.length, 2);
  assert.equal(s3.txs.length, 1);
  assert.deepEqual([by["3.1"].signer, by["3.1"].receiver], ["kizashi.near", "kizashi.near"]);
  assert.deepEqual(by["3.1"].actions.map((a) => a.type), ["DeployContract", "FunctionCall"]);
  assert.equal(by["3.1"].actions[0].codeBase64, WASM.prod.kizashi.toString("base64"), "the production build");
  assert.deepEqual(by["3.1"].actions[1].args, { omens: productionOmens(), usdc: USDC });
  assert.equal(by["3.1"].depositYocto, 0n);
  // Estimated deposits are the transfers into the new accounts: storage plus the margin.
  assert.ok(by["1.1"].depositYocto > BigInt(WASM.drill.kizashi.length) * 10n ** 19n + 5n * 10n ** 23n - 1n);
  assert.equal(by["1.1"].depositYocto, by["1.1"].actions[1].yocto);
});

test("plan: stages 1 to 3 can never delete a key or an account (that is the lock's job alone)", () => {
  const plan = buildPlan({ dep: makeDep(), inputs: makeInputs(), publicKey: PUB });
  for (const t of plan.stages.flatMap((s) => s.txs)) {
    for (const a of t.actions) assert.ok(!/Delete/.test(a.type), `${t.id} contains ${a.type}`);
    if (t.actions.some((a) => a.type === "Transfer")) assert.ok(t.actions.some((a) => a.type === "CreateAccount"), `${t.id} moves funds to an account it did not create`);
  }
});

test("plan: accounts the deployer cannot create, a missing deployer, and a missing init are refused", () => {
  const inputs = makeInputs();
  const alien = makeDep({ drill: { kizashi: "drill-kizashi.other.near", vaults: ["v.deployer.near"] } });
  assert.throws(() => buildPlan({ dep: alien, inputs, publicKey: PUB }), /not a sub-account of deployer\.near/);
  assert.throws(() => buildPlan({ dep: makeDep({ mainnet: {} }), inputs, publicKey: PUB }), /mainnet\.deployer/);
  assert.throws(() => buildPlan({ dep: makeDep({ mamoriReference: "mamori.elsewhere.near" }), inputs, publicKey: PUB }), /not a sub-account/);
  assert.throws(() => buildPlan({ dep: makeDep({ kizashi: undefined }), inputs, publicKey: PUB }), /kizashi/);
});

test("plan: printing it shows everything that would be sent, sends nothing, and never prints the code itself", () => {
  const plan = buildPlan({ dep: makeDep(), inputs: makeInputs() });
  const text = renderPlan(plan);
  assert.match(text, /Nothing is sent/);
  for (const id of ["1.1", "1.4", "2.2", "3.1"]) assert.ok(text.includes(id), id);
  assert.ok(text.includes("drill-kizashi.deployer.near"));
  assert.ok(text.includes(codeHashOf(WASM.prod.kizashi)), "shows the code hash of the production build");
  assert.match(text, /DeployContract/);
  assert.match(text, /FunctionCall new/);
  assert.match(text, /~\d+(\.\d+)? NEAR/);
  assert.ok(!text.includes(WASM.prod.kizashi.toString("base64")), "the wasm is not dumped");
  assert.match(text, /public key of the key file/, "without a key file the AddKey key is a placeholder, never a guess");
});

// ---- stage 0: read-only gates -------------------------------------------------------------------

test("gates: a healthy mainnet reads clean, and every call is a read-only query", async () => {
  const s = sim({ accounts: { "kizashi.near": acct({ amount: 10n * NEAR }) } });
  const rs = await runGates({ rpc: s.rpc, dep: makeDep(), inputs: makeInputs() });
  assert.equal(failures(rs), "");
  const names = rs.map((r) => r.name);
  for (const n of ["rpc is on mainnet", "protocol version", "ML-DSA key types are parsed by the node (necessary, not sufficient)", "intents.near methods", "deployer account", "kizashi account", "Kizashi is registered with the USDC token"]) {
    assert.ok(names.includes(n), n);
  }
  assert.match(rs.find((r) => r.name === "intents.near methods").detail, /ft_deposit.*execute_intents/);
  const protocol = rs.find((r) => r.name === "protocol version").detail;
  assert.match(protocol, /protocol 86.*minimum 86/);
  assert.match(protocol, /supports up to 88/, "the node's own newest protocol is shown, so a pending upgrade is visible");
  assert.match(protocol, /proven on testnet protocol 88/, "a pass is not evidence that ML-DSA works on mainnet");
  assert.ok(s.calls.every(([method]) => method === "query"));
  assert.equal(s.sent.length, 0);
});

test("gates: a wrong chain, an old protocol, a node that cannot parse ML-DSA keys and an unregistered Kizashi each fail", async () => {
  const dep = makeDep();
  const ready = { "kizashi.near": acct({ amount: 10n * NEAR }) };
  assert.match(failures(await runGates({ rpc: sim({ chainId: "testnet", accounts: ready }).rpc, dep, inputs: makeInputs() })), /rpc is on mainnet/);
  assert.match(failures(await runGates({ rpc: sim({ protocol: 80, accounts: ready }).rpc, dep, inputs: makeInputs() })), /protocol version/);
  assert.match(failures(await runGates({ rpc: sim({ mldsa: false, accounts: ready }).rpc, dep, inputs: makeInputs() })), /ML-DSA key types/);
  const s = sim({ accounts: ready });
  s.registered.delete("kizashi.near");
  assert.match(failures(await runGates({ rpc: s.rpc, dep, inputs: makeInputs() })), /Kizashi is registered with the USDC token/);
});

const PROBE = "ML-DSA key types are parsed by the node (necessary, not sufficient)";

/** A node that answers view_access_key like the real ones did on 30 Oct 2026 (the bodies are copied from mainnet and testnet). */
const nodeFetch = ({ knowsMlDsa }) => async (_, init) => {
  const { params } = JSON.parse(init.body);
  const [type, body = ""] = params.public_key.split(":");
  const reply = (json) => ({ status: 200, ok: true, json: async () => json });
  const parseError = (data) => reply({ error: { name: "REQUEST_VALIDATION_ERROR", cause: { name: "PARSE_ERROR", info: { error_message: data } }, code: -32700, message: "Parse error", data } });
  if (type === "ed25519") return reply({ result: { block_hash: "H", block_height: 1, error: `access key ${params.public_key} does not exist while viewing`, logs: [] } });
  if (type !== "ml-dsa-65" || !knowsMlDsa) return parseError(`Failed parsing args: unknown key type '${type}'`);
  const bytes = base58.decode(body).length;
  if (bytes !== 1952) return parseError(`Failed parsing args: invalid key length: expected the input of 1952 bytes, but ${bytes} was given`);
  return reply({ result: { block_hash: "H", block_height: 1, error: `access key ${params.public_key} does not exist while viewing`, logs: [] } });
};

test("gates: the ML-DSA probe is a key the real nodes parse (ml-dsa-65, 1952 bytes), and a node that does not know the type fails it", async () => {
  const s = sim({ accounts: { "kizashi.near": acct({ amount: 10n * NEAR }) } });
  // Everything but the key query comes from the in-memory chain; the key query goes through the real client.
  const throughRealClient = (knowsMlDsa) => {
    const real = makeRpc("http://node", { fetchImpl: nodeFetch({ knowsMlDsa }), backoffMs: 1 });
    return { ...s.rpc, call: (method, params) => (params.request_type === "view_access_key" ? real.call(method, params) : s.rpc.call(method, params)) };
  };
  const probe = async (knowsMlDsa) => (await runGates({ rpc: throughRealClient(knowsMlDsa), dep: makeDep(), inputs: makeInputs() })).find((r) => r.name === PROBE);
  const yes = await probe(true);
  assert.equal(yes.ok, true, yes.detail);
  const no = await probe(false);
  assert.equal(no.ok, false);
  assert.match(no.detail, /unknown key type 'ml-dsa-65'/, "the node's own words reach the operator");
});

test("gates: an unreadable intents.near is reported as skipped, but an rpc that throws elsewhere is a failure, not a pass", async () => {
  const dep = makeDep();
  const rs = await runGates({ rpc: sim({ intents: false, accounts: { "kizashi.near": acct({ amount: 10n * NEAR }) } }).rpc, dep, inputs: makeInputs() });
  const intents = rs.find((r) => r.name === "intents.near methods");
  assert.equal(intents.skipped, true);
  assert.match(intents.detail, /could not discover/);
  assert.equal(failures(rs), "");

  const s = sim();
  const broken = { ...s.rpc, status: async () => { throw new Error("rpc down"); } };
  assert.match(failures(await runGates({ rpc: broken, dep, inputs: makeInputs() })), /could not check: rpc down/);
  // Missing inputs cannot be skipped over silently.
  assert.match(failures(await runGates({ rpc: s.rpc, dep, inputs: null })), /deployer account.*could not check/);
});

test("gates: balance and state checks (deployer funded, Kizashi untouched or already deployed, no foreign code)", async () => {
  const dep = makeDep();
  const poor = sim({ accounts: { "deployer.near": acct({ amount: 1n * NEAR, keys: [PUB] }) } });
  assert.match(failures(await runGates({ rpc: poor.rpc, dep, inputs: makeInputs() })), /deployer account.*needs about/);
  const missing = await runGates({ rpc: sim().rpc, dep, inputs: makeInputs() });
  assert.equal(missing.find((r) => r.name === "kizashi account").skipped, true, "not created yet is a SKIP, not a failure, at stage 0");
  const foreign = sim({ accounts: { "kizashi.near": acct({ amount: 10n * NEAR, code_hash: "somebody-elses-contract" }) } });
  assert.match(failures(await runGates({ rpc: foreign.rpc, dep, inputs: makeInputs() })), /kizashi account.*other code/);
  const done = sim({ accounts: { "kizashi.near": acct({ amount: 10n * NEAR, code_hash: codeHashOf(WASM.prod.kizashi) }) } });
  assert.match((await runGates({ rpc: done.rpc, dep, inputs: makeInputs() })).find((r) => r.name === "kizashi account").detail, /already runs the production build/);
});

// ---- execute: refusals --------------------------------------------------------------------------

test("execute: only stages 1 to 3 can be executed", async () => {
  for (const stage of [0, 4, 5, 6, "1", undefined, NaN]) {
    const s = sim();
    await refused(run(stage, s), /stages 1 to 3 only/);
    assert.equal(s.sent.length, 0);
  }
});

test("execute: without --yes it refuses before it reads the key file or the inputs, and sends nothing", async () => {
  const s = sim();
  const key = s.makeLoadKey("deployer.near");
  let inputsRead = false;
  await refused(
    executeStage({ stage: 1, dep: makeDep(), getInputs: () => ((inputsRead = true), makeInputs()), rpc: s.rpc, yes: false, keyFile: "key.json", loadKey: key.loadKey, log: () => {} }),
    /--yes/,
  );
  assert.deepEqual([s.sent.length, key.loaded.length, inputsRead], [0, 0, false]);
  for (const yes of [undefined, "yes", 1]) await refused(run(1, s, { yes }), /--yes/);
  assert.equal(s.sent.length, 0);
});

test("execute: without a deployer key file path it refuses, and sends nothing", async () => {
  const s = sim();
  const key = s.makeLoadKey("deployer.near");
  for (const keyFile of [undefined, "", null]) await refused(run(1, s, { loader: key, keyFile }), /KAIGEN_DEPLOYER_KEY_FILE/);
  assert.deepEqual([s.sent.length, key.loaded.length], [0, 0]);
});

test("execute: refuses a non-mainnet config, a non-mainnet chain, a key file for the wrong account and an underfunded deployer", async () => {
  const a = sim();
  await refused(run(1, a, { dep: makeDep({ network: "testnet" }) }), /mainnet/);
  const b = sim({ chainId: "testnet" });
  await refused(run(1, b), /chain_id testnet/);
  const c = sim();
  await refused(run(1, c, { accountId: "kizashi.near" }), /key file is for kizashi\.near.*deployer\.near/);
  const d = sim({ accounts: { "deployer.near": acct({ amount: NEAR / 10n, keys: [PUB] }) } });
  await refused(run(1, d), /deployer\.near holds/);
  for (const s of [a, b, c, d]) assert.equal(s.sent.length, 0);
});

// ---- execute: the stages ------------------------------------------------------------------------

test("stage 1: creates the drill pair in order, signs every transaction with the one key, and post-checks the code", async () => {
  const s = sim();
  const { out, log, key } = await run(1, s);
  assert.deepEqual(s.sent.map((t) => `${t.signerId}>${t.receiverId}`), [
    "deployer.near>drill-kizashi.deployer.near",
    "drill-kizashi.deployer.near>drill-kizashi.deployer.near",
    "deployer.near>drill-vault.deployer.near",
    "drill-vault.deployer.near>drill-vault.deployer.near",
  ]);
  assert.deepEqual(out.sent.map((x) => x.id), ["1.1", "1.2", "1.3", "1.4"]);
  assert.equal(out.sent[0].hash, "HASH1");
  assert.equal(s.world["drill-kizashi.deployer.near"].code_hash, codeHashOf(WASM.drill.kizashi));
  assert.equal(s.world["drill-vault.deployer.near"].code_hash, codeHashOf(WASM.drill.mamori));
  assert.equal(failures(out.checks), "");
  assert.equal(key.loaded.length, 1);
  // Each transaction is logged before it is sent, and the log carries hashes, never code or keys.
  const order = log.log.map((e) => e.event);
  assert.ok(order.indexOf("tx") < order.indexOf("sent"));
  assert.ok(!JSON.stringify(log.log).includes(WASM.drill.kizashi.toString("base64")));
});

test("stage 1: running it again sends nothing, and a half-finished run resumes at the first missing step", async () => {
  const s = sim();
  await run(1, s);
  const before = s.sent.length;
  const again = await run(1, s);
  assert.equal(s.sent.length, before);
  assert.deepEqual(again.out.skipped, ["1.1", "1.2", "1.3", "1.4"]);

  const half = sim();
  half.world["drill-kizashi.deployer.near"] = acct({ amount: NEAR, keys: [PUB] }); // created by an earlier, interrupted run
  const r = await run(1, half);
  assert.deepEqual(r.out.skipped, ["1.1"]);
  assert.deepEqual(half.sent.map((t) => t.receiverId), ["drill-kizashi.deployer.near", "drill-vault.deployer.near", "drill-vault.deployer.near"]);
});

test("stage 1: an account that already exists without our key, or with someone else's code, stops the stage before anything is sent for it", async () => {
  const squatted = sim();
  squatted.world["drill-kizashi.deployer.near"] = acct({ amount: NEAR, keys: ["ed25519:SOMEONEELSE"] });
  await refused(run(1, squatted), /drill-kizashi\.deployer\.near already exists.*not the key file's key/);
  assert.equal(squatted.sent.length, 0);

  const foreign = sim();
  foreign.world["drill-kizashi.deployer.near"] = acct({ amount: NEAR, keys: [PUB], code_hash: "somebody-elses-contract" });
  await refused(run(1, foreign), /already runs other code/);
  assert.equal(foreign.sent.length, 0);
});

test("stage 1: the stage stops at the first failing transaction and says what was and was not sent", async () => {
  const s = sim();
  const loader = s.makeLoadKey("deployer.near", { failOn: (tx, n) => n === 1 });
  await assert.rejects(run(1, s, { loader }), (e) => /1\.2/.test(e.message) && /rpc exploded/.test(e.message) && /nothing after it was sent/.test(e.message));
  assert.equal(s.sent.length, 1);
});

/** Stage 1 done, and the drill vault now has only a post-quantum full-access key (gate G1 evidenced on chain). */
async function afterStage1(over = {}) {
  const s = sim(over);
  await run(1, s);
  s.world["drill-vault.deployer.near"].keys = ["ml-dsa-65-hash:DRILLVAULTADMIN"];
  s.world["drill-vault.deployer.near"].nonces = { "ml-dsa-65-hash:DRILLVAULTADMIN": SIGNED };
  return s;
}

test("stage 2: refused until the drill pair exists and G1 is evidenced on chain, then deploys the Mamori reference", async () => {
  const fresh = sim();
  await refused(run(2, fresh), /drill/);
  assert.equal(fresh.sent.length, 0);

  const noG1 = sim();
  await run(1, noG1);
  await refused(run(2, noG1), /G1.*drill-vault\.deployer\.near/);
  const before = noG1.sent.length;
  assert.equal(noG1.sent.length, before);

  const classicalLeft = await afterStage1();
  classicalLeft.world["drill-vault.deployer.near"].keys.push(PUB);
  await refused(run(2, classicalLeft), /G1/);

  // The right keys are not enough: the classical key could have deleted itself, and then mainnet never checked an ML-DSA signature.
  const neverSigned = await afterStage1();
  neverSigned.world["drill-vault.deployer.near"].nonces = { "ml-dsa-65-hash:DRILLVAULTADMIN": UNSIGNED };
  await refused(run(2, neverSigned), /G1.*signed a transaction yet/);
  assert.ok(!neverSigned.sent.some((t) => t.receiverId === "mamori.deployer.near"), "nothing was sent for the Mamori reference");

  const s = await afterStage1();
  const from = s.sent.length;
  const { out } = await run(2, s);
  assert.deepEqual(s.sent.slice(from).map((t) => `${t.signerId}>${t.receiverId}`), ["deployer.near>mamori.deployer.near", "mamori.deployer.near>mamori.deployer.near"]);
  assert.equal(s.world["mamori.deployer.near"].code_hash, codeHashOf(WASM.prod.mamori));
  assert.equal(failures(out.checks), "");
  // The reference holds code only: stage 2 never initialises it.
  assert.ok(!s.sent.slice(from).some((t) => t.actions.some((a) => a.type === "FunctionCall")));
});

async function afterStage2() {
  const s = await afterStage1({ accounts: { "kizashi.near": acct({ amount: 10n * NEAR, keys: [KPUB] }) } });
  await run(2, s);
  return s;
}

test("stage 3: Kizashi is deployed and initialised in ONE transaction, signed by Kizashi, with its keys left alone", async () => {
  const s = await afterStage2();
  const from = s.sent.length;
  const { out } = await run(3, s);
  assert.equal(s.sent.length - from, 1);
  const tx = s.sent.at(-1);
  assert.deepEqual([tx.signerId, tx.receiverId], ["kizashi.near", "kizashi.near"]);
  assert.deepEqual(tx.actions.map((a) => a.type), ["DeployContract", "FunctionCall"]);
  assert.equal(tx.actions[1].method, "new");
  assert.equal(s.world["kizashi.near"].code_hash, codeHashOf(WASM.prod.kizashi));
  assert.deepEqual(s.world["kizashi.near"].keys, [KPUB], "stage 3 never deletes a key");
  assert.equal(failures(out.checks), "");
  assert.match(out.checks.map((c) => c.name).join("|"), /era is Calm/);
  // Done once: a second run changes nothing.
  const again = await run(3, s);
  assert.deepEqual(again.out.skipped, ["3.1"]);
  assert.equal(s.sent.length - from, 1);
});

test("stage 3: refused until stage 2 exists, until Kizashi exists and is funded, and unless every pre-deploy check passes", async () => {
  const fresh = await afterStage1({ accounts: { "kizashi.near": acct({ amount: 10n * NEAR, keys: [KPUB] }) } });
  await refused(run(3, fresh), /Mamori reference/);

  const noAccount = await afterStage1();
  await run(2, noAccount);
  await refused(run(3, noAccount), /kizashi\.near does not exist/);

  const poor = await afterStage1({ accounts: { "kizashi.near": acct({ amount: NEAR / 10n, keys: [KPUB] }) } });
  await run(2, poor);
  await refused(run(3, poor), /kizashi\.near holds/);

  const unregistered = await afterStage2();
  unregistered.registered.delete("kizashi.near");
  await refused(run(3, unregistered), /pre-deploy checks failed.*Kizashi is registered with the USDC token/);

  const extraOmen = await afterStage2();
  const inputs = makeInputs();
  inputs.kizashiInit.omens.push(DRILL_OMENS[0]);
  await refused(run(3, extraOmen, { inputs }), /pre-deploy checks failed.*omens equal the ones re-derived/);

  const drillBuild = await afterStage2();
  const bad = makeInputs();
  bad.wasm.prod.kizashi = WASM.drill.kizashi;
  await refused(run(3, drillBuild, { inputs: bad }), /pre-deploy checks failed.*wasm exports no reset/);

  const wrongKey = await afterStage2();
  await refused(run(3, wrongKey, { accountId: "deployer.near" }), /key file is for deployer\.near.*kizashi\.near/);
  // None of the refusals sent anything to Kizashi: production Kizashi was never initialised.
  for (const x of [fresh, noAccount, poor, unregistered, extraOmen, drillBuild, wrongKey]) {
    assert.ok(!x.sent.some((t) => t.receiverId === "kizashi.near"), "a refused stage 3 sent nothing to kizashi.near");
  }
});

test("stage 3 and the lock refuse a Kizashi key that is also a key of the deployer, the Mamori reference or the drill Kizashi", async () => {
  // The Kizashi key exists to be deleted at the lock. Reused on another account it ties the bounty's admin key to a secret that outlives the lock.
  for (const other of ["deployer.near", "mamori.deployer.near", "drill-kizashi.deployer.near"]) {
    const s = await afterStage2();
    s.world[other].keys.push(KPUB);
    const from = s.sent.length;
    await refused(run(3, s), new RegExp(`also an access key of ${other.replaceAll(".", "\\.")}`));
    assert.equal(s.sent.length, from, `stage 3 sent nothing (${other})`);

    const locked = sim({ accounts: { "kizashi.near": kizashiAccount() } });
    locked.world["deployer.near"].keys.push(KPUB);
    await refused(lock(locked), /also an access key of deployer\.near/);
    assert.equal(locked.sent.length, 0, "the lock sent nothing");
  }
});

// ---- the lock -----------------------------------------------------------------------------------

const KEYS = [KPUB, "ed25519:SECONDKEY", "ed25519:THIRDKEY"];
const kizashiAccount = (over = {}) =>
  acct({
    amount: 10n * NEAR,
    code_hash: codeHashOf(WASM.prod.kizashi),
    keys: [...KEYS],
    views: {
      era: () => "Calm",
      omens: () => productionOmens().map((o) => ({ ...o, death: null })),
      bounty: () => ({ near: String(5n * NEAR), usdc_token: USDC }),
    },
    ...over,
  });
const goodGate = (over = {}) => ({
  kind: GATE_KIND,
  version: 1,
  createdAt: new Date(NOW.getTime() - 3600_000).toISOString(),
  network: "mainnet",
  stage: "pre-lock",
  kizashi: "kizashi.near",
  kizashiCodeHash: codeHashOf(WASM.prod.kizashi),
  block: { height: 9, hash: "BH" },
  ok: true,
  checks: [...requiredChecks("pre-lock"), "fire test #1", COMPLETE_CHECK].map((name) => ({ name, ok: true, detail: "" })),
  ...over,
});

async function lock(s, { gate = goodGate(), accountId = "kizashi.near", keyFile = "key.json", loader, dep = makeDep(), ...over } = {}) {
  const key = loader ?? s.makeLoadKey(accountId);
  const log = events();
  const result = await lockKizashi({ dep, rpc: s.rpc, gate, irreversible: true, keyFile, loadKey: key.loadKey, now: NOW, log, sleep: async () => {}, attempts: 3, ...over });
  return { result, log, key };
}

test("lock: it refuses without a gate, and with a gate that is stale, failing, incomplete, for another stage or another Kizashi", async () => {
  const bad = [
    [null, /no release gate/],
    [goodGate({ createdAt: new Date(NOW.getTime() - 25 * 3600_000).toISOString() }), /older than 24 hours/],
    [goodGate({ ok: false }), /did not pass/],
    [goodGate({ checks: goodGate().checks.filter((c) => c.name !== "kizashi balance covers the bounty") }), /missing required check.*balance/],
    [goodGate({ checks: goodGate().checks.map((c, i) => (i === 2 ? { ...c, ok: false } : c)) }), /failed check/],
    [goodGate({ stage: "post-lock" }), /pre-lock/],
    [goodGate({ kizashi: "other.near" }), /other\.near/],
    [goodGate({ network: "testnet" }), /mainnet/],
  ];
  for (const [gate, re] of bad) {
    const s = sim({ accounts: { "kizashi.near": kizashiAccount() } });
    const key = s.makeLoadKey("kizashi.near");
    await refused(lock(s, { gate, loader: key }), re);
    assert.deepEqual([s.sent.length, key.loaded.length, s.world["kizashi.near"].keys.length], [0, 0, 3]);
  }
});

test("lock: without --i-understand-this-is-irreversible it is a dry run: it re-reads and prints the keys and sends nothing", async () => {
  const s = sim({ accounts: { "kizashi.near": kizashiAccount() } });
  const { result, log, key } = await lock(s, { irreversible: false });
  assert.equal(result.sent, false);
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.keys, KEYS);
  const printed = log.log.find((e) => e.event === "keys");
  assert.deepEqual(printed.keys, KEYS);
  assert.deepEqual([s.sent.length, key.loaded.length], [0, 0], "the key file is not even read");
  for (const irreversible of [undefined, "yes", 1, "true"]) {
    const t = sim({ accounts: { "kizashi.near": kizashiAccount() } });
    assert.equal((await lock(t, { irreversible })).result.sent, false);
    assert.equal(t.sent.length, 0);
  }
});

test("lock: one atomic transaction deletes every key, after the key list was re-read and printed, then the post-check runs", async () => {
  const s = sim({ accounts: { "kizashi.near": kizashiAccount() } });
  const { result, log } = await lock(s);
  assert.equal(s.sent.length, 1, "exactly one transaction");
  const tx = s.sent[0];
  assert.deepEqual([tx.signerId, tx.receiverId], ["kizashi.near", "kizashi.near"]);
  assert.deepEqual(tx.actions.map((a) => a.type), ["DeleteKey", "DeleteKey", "DeleteKey"]);
  assert.deepEqual(tx.actions.map((a) => a.publicKey).sort(), [...KEYS].sort());
  const order = log.log.map((e) => e.event);
  assert.ok(order.indexOf("keys") < order.indexOf("sending"), "keys printed before anything is sent");
  assert.ok(order.indexOf("sending") < order.indexOf("post-check"));
  assert.equal(result.sent, true);
  assert.equal(result.ok, true);
  assert.equal(result.hash, "HASH1");
  assert.deepEqual(s.world["kizashi.near"].keys, []);
  assert.deepEqual(result.post.map((r) => r.name), ["kizashi has no access keys", "era() answers", "omens() answers", "bounty() answers"]);
  assert.equal(failures(result.post), "");
});

test("lock: a post-check that fails (keys remain, a view stops answering, omens changed) is reported as failed, not as done", async () => {
  const stuck = sim({ ignoreDeletes: true, accounts: { "kizashi.near": kizashiAccount() } });
  const a = await lock(stuck);
  assert.equal(a.result.ok, false);
  assert.match(failures(a.result.post), /kizashi has no access keys.*3 key/);

  const noEra = sim({ accounts: { "kizashi.near": kizashiAccount() } });
  noEra.world["kizashi.near"].views.era = () => { throw new Error("method not found"); };
  const b = await lock(noEra);
  assert.equal(b.result.ok, false);
  assert.match(failures(b.result.post), /era\(\) answers.*method not found/);

  const odd = sim({ accounts: { "kizashi.near": kizashiAccount() } });
  odd.world["kizashi.near"].views.era = () => "Quantum";
  odd.world["kizashi.near"].views.omens = () => productionOmens().slice(1).map((o) => ({ ...o, death: null }));
  const c = await lock(odd);
  assert.equal(c.result.ok, false);
  assert.match(failures(c.result.post), /era\(\) answers.*Quantum/);
  assert.match(failures(c.result.post), /omens\(\) answers/);
});

test("lock: refuses a key file for another account, a key that is not on the account, a changed code hash, too many keys, or an unreadable list", async () => {
  const mk = (over) => sim({ accounts: { "kizashi.near": kizashiAccount(over) } });
  const wrongAccount = mk();
  await refused(lock(wrongAccount, { accountId: "deployer.near" }), /key file is for deployer\.near.*kizashi\.near/);
  const notOnAccount = mk({ keys: ["ed25519:SECONDKEY", "ed25519:THIRDKEY"] });
  await refused(lock(notOnAccount), /not one of the keys on kizashi\.near/);
  const changed = mk({ code_hash: "SOMETHING-ELSE" });
  await refused(lock(changed), /code hash.*changed since the gate/);
  const many = mk({ keys: [KPUB, ...Array.from({ length: 100 }, (_, i) => `ed25519:K${i}`)] });
  await refused(lock(many), /more than 100 keys/);
  const gone = sim();
  await refused(lock(gone), /kizashi\.near does not exist/);
  const truncated = mk();
  truncated.rpc.accessKeys = async () => Object.assign([fullKey(KPUB)], { truncated: true });
  await refused(lock(truncated), /too many keys to read/);
  for (const s of [wrongAccount, notOnAccount, changed, many, gone, truncated]) assert.equal(s.sent.length, 0);
  const testnet = sim({ chainId: "testnet", accounts: { "kizashi.near": kizashiAccount() } });
  await refused(lock(testnet), /chain_id testnet/);
  await refused(lock(mk(), { dep: makeDep({ network: "testnet" }) }), /mainnet/);
});

test("lock: with the confirmation flag but no key file it refuses, after printing the keys", async () => {
  const s = sim({ accounts: { "kizashi.near": kizashiAccount() } });
  const log = events();
  await refused(lockKizashi({ dep: makeDep(), rpc: s.rpc, gate: goodGate(), irreversible: true, keyFile: undefined, loadKey: s.makeLoadKey("kizashi.near").loadKey, now: NOW, log }), /KAIGEN_DEPLOYER_KEY_FILE/);
  assert.equal(s.sent.length, 0);
  assert.ok(log.log.some((e) => e.event === "keys"));
});

test("lock: an account with no keys left has nothing to lock, and nothing is sent", async () => {
  const s = sim({ accounts: { "kizashi.near": kizashiAccount({ keys: [] }) } });
  const { result } = await lock(s);
  assert.deepEqual([result.sent, result.nothingToDo, result.ok], [false, true, true]);
  assert.equal(s.sent.length, 0);
});

test("lock: when the send call throws, the chain is re-read instead of assuming either outcome", async () => {
  const landed = sim({ accounts: { "kizashi.near": kizashiAccount() } });
  const timeout = { loaded: [], loadKey: () => ({ accountId: "kizashi.near", publicKey: KPUB, send: async (tx) => { landed.apply(tx); landed.sent.push(tx); throw new Error("socket hang up"); } }) };
  const a = await lock(landed, { loader: timeout });
  assert.equal(a.result.sent, "unknown");
  assert.equal(a.result.ok, true);
  assert.match(a.result.warning, /socket hang up/);

  const lost = sim({ accounts: { "kizashi.near": kizashiAccount() } });
  const refusedByChain = lost.makeLoadKey("kizashi.near", { failOn: () => true });
  const b = await lock(lost, { loader: refusedByChain });
  assert.equal(b.result.ok, false);
  assert.match(b.result.warning, /rpc exploded/);
  assert.equal(lost.world["kizashi.near"].keys.length, 3);
});

// ---- gate files and the source ------------------------------------------------------------------

test("findLatestGate: picks the newest gate by its own timestamp, skips files that are not gates, returns null when there is none", () => {
  const dir = mkTmp("gates-");
  assert.equal(findLatestGate(dir), null);
  assert.equal(findLatestGate(path.join(dir, "missing")), null);
  const put = (name, v) => fs.writeFileSync(path.join(dir, name), typeof v === "string" ? v : JSON.stringify(v));
  put("release-gate-a.json", goodGate({ createdAt: "2026-11-09T10:00:00.000Z" }));
  put("release-gate-b.json", goodGate({ createdAt: "2026-11-09T11:00:00.000Z" }));
  put("release-gate-c.json", "not json");
  put("notes.txt", "hello");
  const found = findLatestGate(dir);
  assert.equal(path.basename(found.file), "release-gate-b.json");
  assert.equal(found.gate.createdAt, "2026-11-09T11:00:00.000Z");
});

test("loadInputs: reads the wasm, the init files and the PUBLIC drill keys, and says which setting is missing", () => {
  const dir = mkTmp("inputs-");
  for (const sub of ["prod", "drill"]) {
    fs.mkdirSync(path.join(dir, "out", sub), { recursive: true });
    fs.writeFileSync(path.join(dir, "out", sub, "kizashi.wasm"), WASM[sub].kizashi);
    fs.writeFileSync(path.join(dir, "out", sub, "mamori.wasm"), WASM[sub].mamori);
  }
  const w = (name, v) => fs.writeFileSync(path.join(dir, name), JSON.stringify(v));
  w("init.json", { omens: productionOmens(), usdc: USDC });
  w("drill-init.json", { omens: DRILL_OMENS, usdc: null });
  w("drill-keys.json", DRILL_OMENS.map((o) => o.public_key));
  const dep = makeDep({ mainnet: { deployer: "deployer.near", kizashiInit: "init.json", drillInit: "drill-init.json", drillKeys: "drill-keys.json" } });
  const inputs = loadInputs({ dep, root: dir });
  assert.deepEqual(inputs.kizashiInit.usdc, USDC);
  assert.ok(inputs.wasm.prod.kizashi.equals(WASM.prod.kizashi));
  assert.deepEqual(inputs.drillKeys, DRILL_OMENS.map((o) => o.public_key));
  assert.throws(() => loadInputs({ dep: makeDep({ mainnet: { deployer: "deployer.near" } }), root: dir }), /mainnet\.kizashiInit/);
  w("secrets.json", { "drill-ed25519-omen": "ab".repeat(32) });
  assert.throws(() => loadInputs({ dep: makeDep({ mainnet: { ...dep.mainnet, drillKeys: "secrets.json" } }), root: dir }), /never a secrets file/);
});

test("the planner cannot send: it imports neither the signing library nor the chain adapters", () => {
  const src = fs.readFileSync(path.join(here, "..", "src", "mainnet.mjs"), "utf8");
  const imports = src.match(/^import .*$/gm) ?? [];
  assert.ok(imports.length > 0);
  assert.deepEqual(imports.filter((l) => /@fastnear|chain\.mjs|node:(http|https|net|child_process)/.test(l)), [], "no signing or network import");
  assert.ok(!/\bsendTx\b/.test(src));
  assert.ok(!/\bfetch\s*\(/.test(src), "no direct network access: reads go through the injected rpc");
});

// ---- the command line ---------------------------------------------------------------------------

const cli = (args, { dep, env = {} } = {}) => {
  const dir = mkTmp("cli-");
  const depFile = path.join(dir, "deployments.json");
  fs.writeFileSync(depFile, JSON.stringify({ rpc: "http://127.0.0.1:9", ...makeDep(), ...(dep ?? {}) }));
  const clean = { ...process.env, KAIGEN_DEPLOYMENTS: depFile, KAIGEN_DATA: path.join(dir, "data"), ...env };
  delete clean.KAIGEN_DEPLOYER_KEY_FILE;
  return { dir, ...spawnSync(process.execPath, [path.join(here, "..", "src", "bin.mjs"), "mainnet", ...args], { encoding: "utf8", env: { ...clean, ...env }, timeout: 60_000 }) };
};

test("cli: execute and lock refuse by default, with a clear message and a non-zero exit, and never reach the network", () => {
  const noYes = cli(["execute", "--stage", "1"]);
  assert.equal(noYes.status, 1);
  assert.match(noYes.stderr, /--yes/);
  const noKey = cli(["execute", "--stage", "1", "--yes"]);
  assert.equal(noKey.status, 1);
  assert.match(noKey.stderr, /KAIGEN_DEPLOYER_KEY_FILE/);
  assert.match(cli(["execute", "--stage", "5", "--yes"]).stderr, /stages 1 to 3 only/);
  assert.match(cli(["execute", "--yes"]).stderr, /--stage/);
  const noGate = cli(["lock", "--i-understand-this-is-irreversible"]);
  assert.equal(noGate.status, 1);
  assert.match(noGate.stderr, /no release gate/);
  assert.match(cli(["lock"]).stderr, /no release gate/);
  assert.equal(cli(["frobnicate"]).status, 2);
  assert.equal(cli([]).status, 2);
  assert.equal(cli(["execute", "--stage", "1", "--yes"], { dep: { network: "testnet" } }).status, 1);
});

test("cli: plan prints every transaction, sends nothing and needs no key", { skip: !fs.existsSync(path.join(root, "out", "prod", "kizashi.wasm")) }, () => {
  const dir = mkTmp("plan-");
  const w = (name, v) => fs.writeFileSync(path.join(dir, name), JSON.stringify(v));
  w("init.json", { omens: productionOmens(), usdc: USDC });
  w("drill-init.json", { omens: DRILL_OMENS, usdc: null });
  w("drill-keys.json", DRILL_OMENS.map((o) => o.public_key));
  const mainnet = { deployer: "deployer.near", kizashiInit: path.join(dir, "init.json"), drillInit: path.join(dir, "drill-init.json"), drillKeys: path.join(dir, "drill-keys.json") };
  const r = cli(["plan"], { dep: { mainnet } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Nothing is sent/);
  assert.match(r.stdout, /3\.1/);
});
