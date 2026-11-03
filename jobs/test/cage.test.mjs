// cage-check (docs/v3/ARCHITECTURE.md 2.8): one test per red condition going red, one for a clean cage staying green.
// The node is faked at the fetch level, so the real rpc.mjs (block pinning, paging, error kinds) runs under every test.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  CageUsage, DEFAULT_MAX_ALLOWANCE_YOCTO, IDS, cageCheck, crossCheckAttest, evaluateCage, exitCodeOf, normalizeCodeHash, parseCageArgs, readAttest, renderCage,
} from "../src/cage.mjs";
import { makeRpc } from "../src/rpc.mjs";
import { codeHashOf } from "../src/verify.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "bin.mjs");
const VAULT = "vault.test";
const ADMIN = "ml-dsa-65-hash:ADMIN";
const MAX = DEFAULT_MAX_ALLOWANCE_YOCTO.toString(); // 0.25 NEAR
const WASM = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
const PIN = codeHashOf(WASM);
const NO_METHOD = "wasm execution failed with error: FunctionCallError(MethodResolveError(MethodNotFound))";

const key = (public_key, permission = "FullAccess") => ({ public_key, access_key: { nonce: 0, permission } });
const fc = (over = {}) => ({ FunctionCall: { allowance: MAX, receiver_id: VAULT, method_names: ["send_small", "request_withdraw"], ...over } });
const D1 = key("ed25519:D1", fc());
const D2 = key("ed25519:D2", fc());

/** A clean cage: the ML-DSA admin, two recorded daily keys, no intents key, the pinned code. Views are values or Errors. */
const cleanWorld = (over = {}) => ({
  height: 100,
  acc: { amount: "1", code_hash: PIN },
  keys: [key(ADMIN), D1, D2],
  views: { daily_keys: ["ed25519:D1", "ed25519:D2"], intents_keys: [], revoked_keys: [], config: { era: "Calm", delay_secs: 86_400 } },
  ...over,
});
const policy = (over = {}) => ({ pinnedCodeHash: PIN, ...over });

/** JSON-RPC answers for a world, recording every request so a test can see what was asked. */
function fakeNode(w) {
  const calls = [];
  const handle = (req) => {
    calls.push(req);
    const ok = (result) => ({ jsonrpc: "2.0", id: req.id, result });
    if (req.method === "block") return ok({ header: { height: w.height, hash: `H${w.height}` } });
    if (req.method === "status") return ok({ chain_id: "sandbox" });
    if (req.method !== "query") return { jsonrpc: "2.0", id: req.id, error: { name: "METHOD_NOT_FOUND", message: req.method } };
    const p = req.params;
    if (p.request_type === "view_account") return w.acc ? ok(w.acc) : ok({ error: `account ${p.account_id} does not exist while viewing` });
    if (p.request_type === "view_access_key_list") return ok({ keys: w.keys });
    if (p.request_type === "call_function") {
      const v = w.views[p.method_name];
      if (v === undefined) return ok({ error: NO_METHOD });
      if (v instanceof Error) return ok({ error: v.message });
      return ok({ result: [...Buffer.from(JSON.stringify(v))] });
    }
    return ok({ error: `unsupported request_type ${p.request_type}` });
  };
  return { calls, handle };
}
const rpcOf = (w) => {
  const node = fakeNode(w);
  const rpc = makeRpc("http://fake.invalid", { retries: 0, fetchImpl: async (_url, init) => ({ status: 200, json: async () => node.handle(JSON.parse(init.body)) }) });
  return Object.assign(rpc, { calls: node.calls });
};
const run = (over, pol) => cageCheck({ rpc: rpcOf(cleanWorld(over)), account: VAULT, policy: policy(pol) });
const status = (r, id) => r.conditions.find((c) => c.id === id).status;
/** The ids in each state; a test names exactly which conditions it expects to be red, so a stray red is a failure. */
const states = (r) => ({
  red: r.conditions.filter((c) => c.status === "RED").map((c) => c.id),
  unknown: r.conditions.filter((c) => c.status === "UNKNOWN").map((c) => c.id),
});

// ---- the clean cage ------------------------------------------------------------------------------------------------

test("cage-check: a clean cage is GREEN on all eight conditions, in doc order, and exits 0", async () => {
  const r = await run();
  assert.deepEqual(r.conditions.map((c) => [c.id, c.status]), Object.values(IDS).map((id) => [id, "GREEN"]));
  assert.equal(Object.values(IDS).length, 8, "ARCHITECTURE.md 2.8 lists eight conditions");
  assert.equal(r.verdict, "GREEN");
  assert.equal(exitCodeOf(r), 0);
  assert.equal(r.mode, "production");
  assert.deepEqual(r.block, { height: 100, hash: "H100" });
  assert.deepEqual([r.info.era, r.info.delay_secs], ["Calm", 86_400]);
});

test("cage-check: an account with only the admin key (no daily keys yet) is GREEN", async () => {
  const r = await run({ keys: [key(ADMIN)], views: { daily_keys: [], intents_keys: [], revoked_keys: [] } });
  assert.equal(r.verdict, "GREEN");
});

// ---- one test per red condition -----------------------------------------------------------------------------------

test("cage-check ARCH-2.8-1: a planted ed25519 full-access key is RED (and only that row)", async () => {
  const r = await run({ keys: [key(ADMIN), D1, D2, key("ed25519:PLANTED")] });
  assert.deepEqual(states(r), { red: [IDS.classicalFullAccess], unknown: [] });
  assert.deepEqual(r.conditions[0].offenders, ["ed25519:PLANTED"]);
  assert.equal(exitCodeOf(r), 1);
});

test("cage-check ARCH-2.8-1: a secp256k1 full-access key is RED too", async () => {
  const r = await run({ keys: [key(ADMIN), key("secp256k1:PLANTED"), D1, D2] });
  assert.deepEqual(states(r).red, [IDS.classicalFullAccess]);
});

test("cage-check ARCH-2.8-2: zero ML-DSA full-access keys is RED (a classical admin alone fails rows 1 and 2)", async () => {
  const r = await run({ keys: [key("ed25519:ONLYADMIN"), D1, D2] });
  assert.deepEqual(states(r).red, [IDS.classicalFullAccess, IDS.oneMlDsaAdmin]);
  const none = await run({ keys: [D1, D2] });
  assert.deepEqual(states(none).red, [IDS.oneMlDsaAdmin], "an account with no full-access key at all is not exactly one ML-DSA key");
});

test("cage-check ARCH-2.8-2: two ML-DSA full-access keys is RED (only that row)", async () => {
  const r = await run({ keys: [key(ADMIN), key("ml-dsa-65-hash:SECOND"), D1, D2] });
  assert.deepEqual(states(r).red, [IDS.oneMlDsaAdmin]);
});

test("cage-check ARCH-2.8-2: with --admin the one ML-DSA key must be that key; another ML-DSA key is RED", async () => {
  assert.equal((await run({}, { admin: ADMIN })).verdict, "GREEN");
  const swapped = await run({}, { admin: "ml-dsa-65-hash:SOMEONEELSE" });
  assert.deepEqual(states(swapped).red, [IDS.oneMlDsaAdmin]);
  assert.match(swapped.conditions[1].detail, /not the expected ml-dsa-65-hash:SOMEONEELSE/);
});

test("cage-check ARCH-2.8-2: a full ml-dsa-65 public key cannot be compared with the on-chain hash, so it is UNKNOWN, never a false red or green", async () => {
  const r = await run({}, { admin: "ml-dsa-65:FULLPUBLICKEY" });
  assert.deepEqual(states(r), { red: [], unknown: [IDS.oneMlDsaAdmin] });
  assert.equal(exitCodeOf(r), 3);
});

test("cage-check ARCH-2.8-3: a function-call key with null allowance (unlimited) is RED", async () => {
  const r = await run({ keys: [key(ADMIN), D1, key("ed25519:D2", fc({ allowance: null }))] });
  assert.deepEqual(states(r).red, [IDS.allowance]);
  assert.match(r.conditions[2].detail, /ed25519:D2 \(null = unlimited\)/);
});

test("cage-check ARCH-2.8-3: an omitted allowance is the same as null", async () => {
  const noAllowance = { FunctionCall: { receiver_id: VAULT, method_names: ["send_small"] } };
  assert.deepEqual(states(await run({ keys: [key(ADMIN), key("ed25519:D1", noAllowance)] })).red, [IDS.allowance]);
});

test("cage-check ARCH-2.8-3: an allowance above the maximum is RED, exactly the maximum is not, and the maximum is configurable", async () => {
  const over = (BigInt(MAX) + 1n).toString();
  const keys = (allowance) => [key(ADMIN), key("ed25519:D1", fc({ allowance })), D2];
  assert.deepEqual(states(await run({ keys: keys(over) })).red, [IDS.allowance]);
  assert.equal(status(await run({ keys: keys(MAX) }), IDS.allowance), "GREEN");
  assert.equal(status(await run({ keys: keys(over) }, { maxAllowanceYocto: BigInt(over) }), IDS.allowance), "GREEN", "raising the configured maximum accepts it");
  assert.equal(status(await run({ keys: keys("1000000000000000000000000") }, { maxAllowanceYocto: BigInt(MAX) }), IDS.allowance), "RED");
});

test("cage-check ARCH-2.8-3: a zero allowance signs nothing and is NOT red (the doc says so)", async () => {
  const r = await run({ keys: [key(ADMIN), key("ed25519:D1", fc({ allowance: "0" })), D2] });
  assert.equal(r.verdict, "GREEN");
});

test("cage-check ARCH-2.8-3: an allowance that is not a number is RED, not skipped", async () => {
  assert.deepEqual(states(await run({ keys: [key(ADMIN), key("ed25519:D1", fc({ allowance: "lots" })), D2] })).red, [IDS.allowance]);
});

test("cage-check ARCH-2.8-4: empty method_names is RED, and so is an omitted list (both mean any method)", async () => {
  const empty = await run({ keys: [key(ADMIN), D1, key("ed25519:D2", fc({ method_names: [] }))] });
  assert.deepEqual(states(empty).red, [IDS.methodNames]);
  const omitted = await run({ keys: [key(ADMIN), D1, key("ed25519:D2", { FunctionCall: { allowance: MAX, receiver_id: VAULT } })] });
  assert.deepEqual(states(omitted).red, [IDS.methodNames]);
});

test("cage-check ARCH-2.8-5: a receiver other than the account is RED (only that row)", async () => {
  const r = await run({ keys: [key(ADMIN), D1, key("ed25519:D2", fc({ receiver_id: "evil.test" }))] });
  assert.deepEqual(states(r).red, [IDS.scope]);
  assert.match(r.conditions[4].detail, /receiver evil\.test/);
});

test("cage-check ARCH-2.8-5: a method beyond the two daily methods is RED; a subset is fine; --allow-method widens the list", async () => {
  const withExtra = { keys: [key(ADMIN), D1, key("ed25519:D2", fc({ method_names: ["send_small", "cancel_all"] }))] };
  const r = await run(withExtra);
  assert.deepEqual(states(r).red, [IDS.scope]);
  assert.match(r.conditions[4].detail, /methods cancel_all/);
  assert.equal((await run({ keys: [key(ADMIN), D1, key("ed25519:D2", fc({ method_names: ["send_small"] }))] })).verdict, "GREEN");
  assert.equal((await run(withExtra, { extraMethods: ["cancel_all"] })).verdict, "GREEN");
});

test("cage-check ARCH-2.8-5: a key with a permission this check does not know is RED, never read as harmless", async () => {
  const r = await run({ keys: [key(ADMIN), D1, D2, key("ed25519:ODD", { GasKey: {} })] });
  assert.deepEqual(states(r).red, [IDS.scope]);
});

test("cage-check ARCH-2.8-6: a function-call key the vault does not record is RED (only that row)", async () => {
  const r = await run({ keys: [key(ADMIN), D1, D2, key("ed25519:STRANGER", fc())] });
  assert.deepEqual(states(r).red, [IDS.unrecorded]);
  assert.deepEqual(r.conditions[5].offenders, ["ed25519:STRANGER"]);
});

test("cage-check ARCH-2.8-6: a revoked key still on the account is RED, and says its DeleteKey has not landed", async () => {
  const r = await run({ keys: [key(ADMIN), D1, D2, key("ed25519:BURNED", fc())], views: { daily_keys: ["ed25519:D1", "ed25519:D2"], intents_keys: [], revoked_keys: ["ed25519:BURNED"] } });
  assert.deepEqual(states(r).red, [IDS.unrecorded]);
  assert.match(r.conditions[5].detail, /ed25519:BURNED \(in revoked_keys: its DeleteKey has not landed\)/);
  assert.deepEqual(r.info.revoked_keys, ["ed25519:BURNED"]);
});

test("cage-check ARCH-2.8-6: a recorded key that is not on the account is not red (it can sign nothing)", async () => {
  const r = await run({ keys: [key(ADMIN), D1], views: { daily_keys: ["ed25519:D1", "ed25519:D2"], intents_keys: [] } });
  assert.equal(r.verdict, "GREEN");
});

test("cage-check ARCH-2.8-6: when daily_keys() cannot be read the row is UNKNOWN (exit 3), not green", async () => {
  const r = await run({ views: { intents_keys: [], config: { era: "Calm", delay_secs: 86_400 } } });
  assert.deepEqual(states(r), { red: [], unknown: [IDS.unrecorded] });
  assert.equal(exitCodeOf(r), 3);
  assert.match(r.conditions[5].detail, /daily_keys\(\) could not be read/);
});

test("cage-check ARCH-2.8-7: a recorded intents key is RED (only that row)", async () => {
  const r = await run({ views: { daily_keys: ["ed25519:D1", "ed25519:D2"], intents_keys: ["ed25519:INTENTS"], revoked_keys: [] } });
  assert.deepEqual(states(r).red, [IDS.intentsKey]);
  assert.deepEqual(r.conditions[6].offenders, ["ed25519:INTENTS"]);
});

test("cage-check ARCH-2.8-7: when intents_keys() cannot be read the row is UNKNOWN, not green", async () => {
  const r = await run({ views: { daily_keys: ["ed25519:D1", "ed25519:D2"] } });
  assert.deepEqual(states(r), { red: [], unknown: [IDS.intentsKey] });
});

test("cage-check ARCH-2.8-8: a code hash that differs from the pinned hash is RED (only that row)", async () => {
  const r = await run({ acc: { amount: "1", code_hash: codeHashOf(Buffer.from("something else")) } });
  assert.deepEqual(states(r).red, [IDS.codeHash]);
  assert.equal(exitCodeOf(r), 1);
});

test("cage-check ARCH-2.8-8: an account with no code at all is RED against a pin", async () => {
  const r = await run({ acc: { amount: "1", code_hash: "11111111111111111111111111111111" } });
  assert.deepEqual(states(r).red, [IDS.codeHash]);
  assert.match(r.conditions[7].detail, /no code/);
});

test("cage-check ARCH-2.8-8: a global contract is compared by its hash; one referenced by publisher account is RED", async () => {
  assert.equal(status(await run({ acc: { amount: "1", code_hash: "11111111111111111111111111111111", global_contract_hash: PIN } }), IDS.codeHash), "GREEN");
  assert.equal(status(await run({ acc: { amount: "1", code_hash: PIN, global_contract_hash: codeHashOf(Buffer.from("x")) } }), IDS.codeHash), "RED", "the global hash wins over code_hash");
  const byPublisher = await run({ acc: { amount: "1", code_hash: PIN, global_contract_account_id: "publisher.test" } });
  assert.deepEqual(states(byPublisher).red, [IDS.codeHash]);
  assert.match(byPublisher.conditions[7].detail, /publisher\.test/);
});

test("cage-check ARCH-2.8-8: with no pinned hash the row is UNKNOWN (exit 3): an unpinned run is not a clean bill", async () => {
  const r = await run({}, { pinnedCodeHash: undefined });
  assert.deepEqual(states(r), { red: [], unknown: [IDS.codeHash] });
  assert.equal(exitCodeOf(r), 3);
  assert.match(r.conditions[7].detail, /no pinned hash/);
});

// ---- several at once, the planted-key scenario (docs/v3/ARCHITECTURE.md attack 8), and the stand-in admin --------------

test("cage-check: attack 8, an ed25519 full-access key and a null-allowance key planted together, is RED on exactly rows 1, 3 and 6", async () => {
  const r = await run({ keys: [key(ADMIN), D1, D2, key("ed25519:PLANTED"), key("ed25519:NULLKEY", fc({ allowance: null }))] });
  assert.deepEqual(states(r).red, [IDS.classicalFullAccess, IDS.allowance, IDS.unrecorded]);
  const after = await run({});
  assert.equal(after.verdict, "GREEN", "green again once both are removed");
});

test("cage-check stand-in admin (sandbox only): the stand-in key is accepted as the one admin, everything else is judged as before, and the result says it is not production", async () => {
  const standIn = "ed25519:SANDBOXADMIN";
  const w = { keys: [key(standIn), D1, D2] };
  const clean = await run(w, { standInAdmin: standIn });
  assert.equal(clean.verdict, "GREEN");
  assert.equal(clean.mode, "sandbox-stand-in-admin");
  assert.match(renderCage(clean), /NOT a production result/);
  assert.doesNotMatch(renderCage(await run({})), /NOT a production result/);
  // The same cage without the stand-in flag is red: a classical admin is exactly what the guard forbids.
  assert.deepEqual(states(await run(w)).red, [IDS.classicalFullAccess, IDS.oneMlDsaAdmin]);
  // A second classical full-access key is still red, stand-in or not.
  assert.deepEqual(states(await run({ keys: [key(standIn), key("ed25519:PLANTED"), D1, D2] }, { standInAdmin: standIn })).red, [IDS.classicalFullAccess]);
  // And if the stand-in key is not on the account at all, row 2 is red.
  assert.deepEqual(states(await run({ keys: [D1, D2] }, { standInAdmin: standIn })).red, [IDS.oneMlDsaAdmin]);
});

// ---- limits of what was read ---------------------------------------------------------------------------------------

test("cage-check: a key list cut off at the paging limit turns the key-list rows from GREEN to UNKNOWN, but keeps a RED red", () => {
  const keys = Object.assign([key(ADMIN), D1], { truncated: true });
  const facts = {
    account: VAULT, block: { height: 1, hash: "h" }, acc: { code_hash: PIN }, keys,
    recorded: { daily: { value: ["ed25519:D1"] }, intents: { value: [] }, revoked: { value: [] } }, config: { error: "x" }, attest: { status: "absent" },
  };
  const r = evaluateCage(facts, policy());
  assert.deepEqual(states(r), { red: [], unknown: [IDS.classicalFullAccess, IDS.oneMlDsaAdmin, IDS.allowance, IDS.methodNames, IDS.scope, IDS.unrecorded] });
  assert.equal(r.verdict, "UNKNOWN");
  const planted = evaluateCage({ ...facts, keys: Object.assign([...keys, key("ed25519:PLANTED")], { truncated: true }) }, policy());
  assert.equal(status(planted, IDS.classicalFullAccess), "RED");
  assert.equal(planted.verdict, "RED");
});

test("cage-check: an account that does not exist is an error, never a verdict", async () => {
  await assert.rejects(cageCheck({ rpc: rpcOf(cleanWorld({ acc: null, keys: [] })), account: "ghost.test", policy: policy() }), /does not exist/);
});

test("cage-check is read-only: only block, view_account, view_access_key_list and call_function are sent, all pinned to one block", async () => {
  const rpc = rpcOf(cleanWorld());
  await cageCheck({ rpc, account: VAULT, policy: policy() });
  const kinds = new Set(rpc.calls.map((c) => (c.method === "query" ? `query:${c.params.request_type}` : c.method)));
  assert.deepEqual([...kinds].sort(), ["block", "query:call_function", "query:view_access_key_list", "query:view_account"]);
  const reads = rpc.calls.filter((c) => c.method === "query");
  assert.ok(reads.every((c) => c.params.block_id === "H100" && c.params.finality === undefined), "every read is pinned to the block read first");
  assert.deepEqual([...new Set(reads.filter((c) => c.params.request_type === "call_function").map((c) => c.params.method_name))].sort(), ["attest", "config", "daily_keys", "intents_keys", "revoked_keys"]);
});

// ---- the attest() adapter (not final) ------------------------------------------------------------------------------

test("cage-check attest adapter: absent on a v2 build, present with the raw answer kept, an error is recorded; none of it changes a verdict", async () => {
  const absent = await readAttest({ rpc: rpcOf(cleanWorld()), account: VAULT });
  assert.equal(absent.status, "absent");
  const present = await readAttest({ rpc: rpcOf(cleanWorld({ views: { attest: { daily_keys: [] } } })), account: VAULT });
  assert.deepEqual(present, { status: "present", raw: { daily_keys: [] } });
  const broken = await readAttest({ rpc: rpcOf(cleanWorld({ views: { attest: new Error("ProhibitedInView") } })), account: VAULT });
  assert.equal(broken.status, "error");
  // A lying attest() (the account's own full-access key can deploy one) cannot turn a red green or a green red.
  const lying = await run({ keys: [key(ADMIN), D1, D2, key("ed25519:PLANTED")], views: { daily_keys: ["ed25519:D1", "ed25519:D2"], intents_keys: [], attest: { clean: true } } });
  assert.deepEqual(states(lying).red, [IDS.classicalFullAccess]);
  assert.equal(lying.info.attest, "present");
  assert.equal(lying.info.attest_cross_check, "pending", "the comparison is a marked stub until attest()'s shape is final");
  assert.deepEqual(crossCheckAttest({ status: "present", raw: {} }, {}), { status: "pending", findings: [] });
});

// ---- output --------------------------------------------------------------------------------------------------------

test("cage-check text report: one line per condition by id, the verdict line, and the limits", async () => {
  const text = renderCage(await run({ keys: [key(ADMIN), D1, D2, key("ed25519:PLANTED")] }));
  for (const id of Object.values(IDS)) assert.match(text, new RegExp(`(RED|GREEN|UNKNOWN)\\s+${id}  `));
  assert.match(text, /^RED +ARCH-2\.8-1 /m);
  assert.match(text, /^GREEN +ARCH-2\.8-2 /m);
  assert.match(text, /RED: 1 of 8 conditions fail\./);
  assert.match(text, /limit: point in time/);
  assert.match(renderCage(await run({})), /GREEN: all 8 conditions hold\./);
  assert.match(renderCage(await run({}, { pinnedCodeHash: undefined })), /UNKNOWN: nothing is red but 1 of 8 conditions could not be checked; this is not a clean bill\./);
});

// ---- argument parsing ----------------------------------------------------------------------------------------------

test("cage-check args: account, rpc, policy and defaults", () => {
  const a = parseCageArgs(["vault.near", "--rpc", "http://x", "--admin", ADMIN, "--code-hash", PIN, "--max-allowance", "0.1", "--allow-method", "freeze", "--allow-method", "x", "--json"]);
  assert.equal(a.account, "vault.near");
  assert.equal(a.rpc, "http://x");
  assert.equal(a.json, true);
  assert.deepEqual(a.policy, { admin: ADMIN, standInAdmin: undefined, pinnedCodeHash: PIN, maxAllowanceYocto: 10n ** 23n, extraMethods: ["freeze", "x"] });
  const d = parseCageArgs(["v.near"]);
  assert.equal(d.policy.maxAllowanceYocto, 250n * 10n ** 21n, "default maximum is Mamori's own 0.25 NEAR");
  assert.equal(d.policy.pinnedCodeHash, undefined);
});

test("cage-check args: a 64-digit hex sha256 and its base58 spelling pin the same code, and a wasm file is hashed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cage-"));
  const file = path.join(dir, "m.wasm");
  fs.writeFileSync(file, WASM);
  try {
    assert.equal(parseCageArgs(["v", "--wasm", file]).policy.pinnedCodeHash, PIN);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
  const hex = createHash("sha256").update(WASM).digest("hex");
  assert.equal(normalizeCodeHash(hex), PIN);
  assert.equal(normalizeCodeHash(hex.toUpperCase()), PIN);
  assert.equal(normalizeCodeHash(PIN), PIN);
});

test("cage-check args: every bad invocation is a usage error", () => {
  const bad = (argv, re) => assert.throws(() => parseCageArgs(argv), (e) => e instanceof CageUsage && re.test(e.message), argv.join(" "));
  bad([], /give the vault account/);
  bad(["a", "b"], /one account at a time/);
  bad(["v", "--nope"], /unknown option --nope/);
  bad(["v", "--rpc"], /--rpc needs a value/);
  bad(["v", "--rpc", "--json"], /--rpc needs a value/);
  bad(["v", "--rpc", "a", "--rpc", "b"], /given twice/);
  bad(["v", "--admin", "a", "--stand-in-admin", "b"], /exclude each other/);
  bad(["v", "--code-hash", PIN, "--wasm", "x"], /exclude each other/);
  bad(["v", "--code-hash", "not a hash"], /neither a base58 nor a 64-digit hex/);
  bad(["v", "--code-hash", "abc"], /decodes to \d+ bytes/);
  bad(["v", "--max-allowance", "lots"], /not an amount in NEAR/);
  bad(["v", "--wasm", path.join(os.tmpdir(), "no-such-file.wasm")], /cannot read the wasm/);
});

// ---- the command (bin.mjs) against a fake node over HTTP ------------------------------------------------------------

async function withNode(world, fn) {
  const node = fakeNode(world);
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(node.handle(JSON.parse(body))));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function cli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, "cage-check", ...args], { env: { ...process.env, KAIGEN_RPC: "", KAIGEN_DEPLOYMENTS: path.join(os.tmpdir(), "no-such-deployments.json"), ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("cage-check command: exit 0 on a clean cage, 1 when a full-access key is planted, 3 when unpinned, 2 on usage, and --json parses", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cage-cli-"));
  const wasm = path.join(dir, "m.wasm");
  fs.writeFileSync(wasm, WASM);
  try {
    await withNode(cleanWorld(), async (url) => {
      const ok = await cli([VAULT, "--rpc", url, "--wasm", wasm]);
      assert.equal(ok.code, 0, ok.stdout + ok.stderr);
      assert.match(ok.stdout, /GREEN: all 8 conditions hold\./);
      const json = await cli([VAULT, "--rpc", url, "--wasm", wasm, "--json"]);
      assert.equal(JSON.parse(json.stdout).verdict, "GREEN");
      const unpinned = await cli([VAULT, "--rpc", url]);
      assert.equal(unpinned.code, 3, "nothing red, but the code hash was not checked");
      const viaEnv = await cli([VAULT, "--wasm", wasm], { KAIGEN_RPC: url });
      assert.equal(viaEnv.code, 0, "KAIGEN_RPC is honoured");
    });
    await withNode(cleanWorld({ keys: [key(ADMIN), D1, D2, key("ed25519:PLANTED")] }), async (url) => {
      const bad = await cli([VAULT, "--rpc", url, "--wasm", wasm, "--json"]);
      assert.equal(bad.code, 1, "any red is a nonzero exit");
      const parsed = JSON.parse(bad.stdout);
      assert.equal(parsed.verdict, "RED");
      assert.deepEqual(parsed.conditions.filter((c) => c.status === "RED").map((c) => c.id), [IDS.classicalFullAccess]);
      assert.match((await cli([VAULT, "--rpc", url, "--wasm", wasm])).stdout, /^RED +ARCH-2\.8-1 /m);
    });
    await withNode(cleanWorld({ acc: null, keys: [] }), async (url) => {
      const ghost = await cli(["ghost.test", "--rpc", url, "--wasm", wasm]);
      assert.equal(ghost.code, 1, "no account, no cage, no green");
      assert.match(ghost.stderr, /does not exist/);
      assert.doesNotMatch(ghost.stdout, /GREEN/);
    });
    const none = await cli([VAULT, "--wasm", wasm]);
    assert.equal(none.code, 2);
    assert.match(none.stderr, /no RPC url/);
    const usage = await cli([]);
    assert.equal(usage.code, 2);
    assert.match(usage.stderr, /give the vault account to check/);
    assert.match(usage.stderr, /usage: kaigen-jobs cage-check/);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test("cage-check: a node that cannot be reached is an error, never a verdict", async () => {
  const down = makeRpc("http://down.invalid", { retries: 0, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  await assert.rejects(cageCheck({ rpc: down, account: VAULT, policy: policy() }), /ECONNREFUSED/);
});
