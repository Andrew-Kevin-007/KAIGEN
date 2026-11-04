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
  ATTEST_VERSION, CageUsage, DEFAULT_MAX_ALLOWANCE_YOCTO, IDS, cageCheck, crossCheckAttest, evaluateCage, exitCodeOf, normalizeCodeHash, parseAttestation, parseCageArgs, readAttest, readCageFacts, renderCage,
} from "../src/cage.mjs";
import { base58 } from "@scure/base";
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

const DEFAULT_VIEWS = { daily_keys: ["ed25519:D1", "ed25519:D2"], intents_keys: [], revoked_keys: [], config: { era: "Calm", delay_secs: 86_400 } };

/**
 * What attest() answers for these views, in the shape of docs/v3/ATTEST-CHECK.md 2.1 (u64 as strings, a view that is
 * unreadable in the test falls back to the clean value). `over` replaces fields, to build a lying or odd answer.
 */
const attestOf = (views, over = {}) => ({
  attest_version: ATTEST_VERSION,
  contract: "mamori",
  drill_build: false,
  account_id: VAULT,
  block_height: "100",
  block_timestamp: "1700000000000000000",
  config: views.config ?? DEFAULT_VIEWS.config,
  min_delay_secs: 86_400,
  allowlist_enforced: false,
  allowlist_len: 0,
  daily_keys: (views.daily_keys ?? DEFAULT_VIEWS.daily_keys).map((public_key) => ({ public_key, strikes: 0 })),
  intents_keys: views.intents_keys ?? DEFAULT_VIEWS.intents_keys,
  revoked_keys: views.revoked_keys ?? DEFAULT_VIEWS.revoked_keys,
  queue_len: 0,
  // The stretch fields (STRETCH-DESIGN.md): a vault with no policy path, no safe account, no watchers, no window.
  policy_account: null,
  safe_account: { current: null, pending: null },
  watchers: [],
  emergency_until: "0",
  proposals: [],
  note: "informational",
  ...over,
});

/**
 * A clean cage: the ML-DSA admin, two recorded daily keys, no intents key, the pinned code, and an attest() that says
 * the same as the views. Views are values or Errors; `views: { x: undefined }` makes view x absent (a v2 build has no
 * attest, so `views: { attest: undefined }`), and an attest the test does not give is built from the other views.
 */
const cleanWorld = (over = {}) => {
  const views = { ...DEFAULT_VIEWS, ...over.views };
  if (!("attest" in views)) views.attest = attestOf(views);
  return { height: 100, acc: { amount: "1", code_hash: PIN }, keys: [key(ADMIN), D1, D2], ...over, views };
};
const NO_ATTEST = { attest: undefined };
/** The five rows that read the stretch fields of attest(): UNKNOWN whenever attest() is absent, unreadable, newer or malformed. */
const STRETCH = [IDS.safeAccount, IDS.policyActors, IDS.emergencyWindow, IDS.safeChange, IDS.proposals];
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

test("cage-check: a clean cage is GREEN on all fifteen conditions, in doc order, and exits 0", async () => {
  const r = await run();
  assert.deepEqual(r.conditions.map((c) => [c.id, c.status]), Object.values(IDS).map((id) => [id, "GREEN"]));
  assert.deepEqual(Object.values(IDS), [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `ARCH-2.8-${n}`).concat(["ATTEST-1", "ATTEST-2", "ATTEST-3", "ATTEST-4", "ATTEST-5", "ATTEST-6", "ATTEST-7"]), "the eight rows of ARCHITECTURE.md 2.8, then the seven attest() rows");
  assert.equal(r.verdict, "GREEN");
  assert.equal(r.info.attest_cross_check, "agree");
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

test("cage-check ARCH-2.8-6: when daily_keys() cannot be read the row is UNKNOWN (exit 3), not green, even with a clean attest()", async () => {
  const r = await run({ views: { daily_keys: undefined } });
  assert.deepEqual(states(r), { red: [], unknown: [IDS.unrecorded, IDS.attestAgrees] }, "attest() cannot stand in for the view it is compared with");
  assert.equal(exitCodeOf(r), 3);
  assert.match(r.conditions[5].detail, /daily_keys\(\) could not be read/);
});

test("cage-check ARCH-2.8-7: a recorded intents key is RED (only that row)", async () => {
  const r = await run({ views: { daily_keys: ["ed25519:D1", "ed25519:D2"], intents_keys: ["ed25519:INTENTS"], revoked_keys: [] } });
  assert.deepEqual(states(r).red, [IDS.intentsKey]);
  assert.deepEqual(r.conditions[6].offenders, ["ed25519:INTENTS"]);
});

test("cage-check ARCH-2.8-7: when intents_keys() cannot be read the row is UNKNOWN, not green, even with a clean attest()", async () => {
  const r = await run({ views: { intents_keys: undefined } });
  assert.deepEqual(states(r), { red: [], unknown: [IDS.intentsKey, IDS.attestAgrees] });
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
    recorded: { daily: { value: ["ed25519:D1"] }, intents: { value: [] }, revoked: { value: [] } }, config: { value: DEFAULT_VIEWS.config },
    attest: { status: "present", raw: attestOf({ daily_keys: ["ed25519:D1"] }) },
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

// ---- attest(): read, parse, cross-check (docs/v3/ATTEST-CHECK.md) ---------------------------------------------------
// attest() is a cross-check that can only ADD a red or an unchecked. The eight rows of ARCHITECTURE.md 2.8 stand on RPC
// (and, for rows 6 and 7, on the vault's own views); ATTEST-1 and ATTEST-2 are the two rows attest() brings itself.

const DAILY = (...ks) => ks.map((public_key) => ({ public_key, strikes: 0 }));
const row = (r, id) => r.conditions.find((c) => c.id === id);
/** A world whose attest() says `over` on top of what the other views say; `views` and `world` shape those views and the account. */
const withAttest = (over, views = {}, world = {}) => ({ ...world, views: { ...views, attest: attestOf({ ...DEFAULT_VIEWS, ...views }, over) } });

test("cage-check attest read: absent on a v2 build, present with the raw answer kept, any other failure is an error", async () => {
  const absent = await readAttest({ rpc: rpcOf(cleanWorld({ views: NO_ATTEST })), account: VAULT });
  assert.equal(absent.status, "absent");
  const present = await readAttest({ rpc: rpcOf(cleanWorld({ views: { attest: { daily_keys: [] } } })), account: VAULT });
  assert.deepEqual(present, { status: "present", raw: { daily_keys: [] } });
  const broken = await readAttest({ rpc: rpcOf(cleanWorld({ views: { attest: new Error("ProhibitedInView") } })), account: VAULT });
  assert.equal(broken.status, "error");
  // A missing method is spelled differently by different node versions, and an account without code has no attest() either.
  const statusFor = async (msg) => (await readAttest({ rpc: rpcOf(cleanWorld({ views: { attest: new Error(msg) } })), account: VAULT })).status;
  for (const msg of ["MethodNotFound", "MethodResolveError", "method attest not found", "CompilationError(CodeDoesNotExist { account_id: vault.test })", "no contract code"]) {
    assert.equal(await statusFor(msg), "absent", msg);
  }
  for (const msg of ["ProhibitedInView", "Exceeded the prepaid gas", "HostError(GasExceeded)", "timeout"]) {
    assert.equal(await statusFor(msg), "error", msg);
  }
});

test("cage-check attest: matching attest() is GREEN on ATTEST-1 and ATTEST-2, and its settings are reported, not graded", async () => {
  const r = await run();
  assert.deepEqual([row(r, IDS.attestAgrees).status, row(r, IDS.productionBuild).status], ["GREEN", "GREEN"]);
  assert.equal(r.info.attest, "present");
  assert.equal(r.info.attest_cross_check, "agree");
  assert.equal(r.info.allowlist_enforced, false);
  // An enforced allowlist, a different strike cap and a strike on a key are not red: none is a condition of the loss bound.
  const odd = await run(withAttest({ allowlist_enforced: true, daily_keys: DAILY("ed25519:D1", "ed25519:D2").map((k) => ({ ...k, strikes: 2 })) }, { config: { era: "Calm", delay_secs: 86_400, max_strikes: 5 } }));
  assert.equal(odd.verdict, "GREEN");
  assert.deepEqual([odd.info.allowlist_enforced, odd.info.max_strikes], [true, 5]);
  assert.match(renderCage(odd), /allowlist enforced, max strikes 5/);
});

test("cage-check attest: an old v2 vault without attest() is UNCHECKED (UNKNOWN, exit 3), never GREEN; the eight rows still judge it", async () => {
  const v2 = await run({ views: NO_ATTEST });
  assert.deepEqual(states(v2), { red: [], unknown: [IDS.attestAgrees, IDS.productionBuild, ...STRETCH] });
  assert.equal(v2.verdict, "UNKNOWN");
  assert.equal(exitCodeOf(v2), 3);
  assert.deepEqual([v2.info.attest, v2.info.attest_cross_check], ["absent", "absent"]);
  assert.match(row(v2, IDS.attestAgrees).detail, /no attest\(\) view: a v2 build, or no Mamori on the account; this was not checked/);
  const text = renderCage(v2);
  assert.doesNotMatch(text, /GREEN: all/);
  assert.match(text, /^UNKNOWN +ATTEST-1 /m);
  assert.match(text, /UNKNOWN: nothing is red but 7 of 15 conditions could not be checked/);
  // The same v2 vault with a planted key is RED, not merely unchecked: a missing attest() hides nothing the RPC rows can see.
  const planted = await run({ views: NO_ATTEST, keys: [key(ADMIN), D1, D2, key("ed25519:PLANTED")] });
  assert.deepEqual(states(planted), { red: [IDS.classicalFullAccess], unknown: [IDS.attestAgrees, IDS.productionBuild, ...STRETCH] });
  assert.equal(exitCodeOf(planted), 1);
});

test("cage-check attest: an attest() that fails for another reason is UNKNOWN, not absent and not green", async () => {
  const r = await run({ views: { attest: new Error("ProhibitedInView: attest") } });
  assert.deepEqual(states(r), { red: [], unknown: [IDS.attestAgrees, IDS.productionBuild, ...STRETCH] });
  assert.equal(r.info.attest, "error");
  assert.match(row(r, IDS.attestAgrees).detail, /attest\(\) could not be read: .*ProhibitedInView/);
  assert.equal(exitCodeOf(r), 3);
});

test("cage-check attest mismatch ARCH-2.8-6: the vault's view records a key on the account that attest() does not, RED on rows 6 and ATTEST-1", async () => {
  const r = await run(withAttest({ daily_keys: DAILY("ed25519:D1") }));
  assert.deepEqual(states(r).red, [IDS.unrecorded, IDS.attestAgrees]);
  assert.deepEqual(row(r, IDS.unrecorded).offenders, ["ed25519:D2"]);
  assert.match(row(r, IDS.unrecorded).detail, /not in attest\(\)\.daily_keys: ed25519:D2/);
  assert.match(row(r, IDS.attestAgrees).detail, /daily_keys differ, only in daily_keys\(\): ed25519:D2/);
  assert.equal(exitCodeOf(r), 1);
});

test("cage-check attest mismatch ARCH-2.8-6: a function-call key on the account that neither record knows is named once", async () => {
  const r = await run({ keys: [key(ADMIN), D1, D2, key("ed25519:STRANGER", fc())] });
  assert.deepEqual(row(r, IDS.unrecorded).offenders, ["ed25519:STRANGER"], "the view and attest() both miss it: one offender, not two");
  assert.deepEqual(states(r).red, [IDS.unrecorded]);
  const burned = await run({ keys: [key(ADMIN), D1, D2, key("ed25519:BURNED", fc())], views: { revoked_keys: ["ed25519:BURNED"] } });
  assert.deepEqual(row(burned, IDS.unrecorded).offenders, ["ed25519:BURNED (in revoked_keys: its DeleteKey has not landed)"]);
});

test("cage-check attest mismatch ATTEST-1: attest() records a daily key that neither the view nor the account has (RED on ATTEST-1 only)", async () => {
  const r = await run(withAttest({ daily_keys: DAILY("ed25519:D1", "ed25519:D2", "ed25519:GHOST") }));
  assert.deepEqual(states(r).red, [IDS.attestAgrees]);
  assert.deepEqual(row(r, IDS.attestAgrees).offenders, ["ed25519:GHOST"]);
  assert.match(row(r, IDS.attestAgrees).detail, /daily_keys differ, only in attest\(\): ed25519:GHOST/);
});

test("cage-check attest mismatch ARCH-2.8-7: attest() records an intents key that intents_keys() does not, RED on row 7 and ATTEST-1", async () => {
  const r = await run(withAttest({ intents_keys: ["ed25519:INTENTS"] }));
  assert.deepEqual(states(r).red, [IDS.intentsKey, IDS.attestAgrees]);
  assert.deepEqual(row(r, IDS.intentsKey).offenders, ["ed25519:INTENTS"]);
  assert.match(row(r, IDS.intentsKey).detail, /attest\(\)\.intents_keys records: ed25519:INTENTS/);
});

test("cage-check attest mismatch ARCH-2.8-7: intents_keys() records a key that attest() does not, RED on row 7 and ATTEST-1", async () => {
  const r = await run(withAttest({ intents_keys: [] }, { intents_keys: ["ed25519:INTENTS"] }));
  assert.deepEqual(states(r).red, [IDS.intentsKey, IDS.attestAgrees]);
  assert.match(row(r, IDS.attestAgrees).detail, /intents_keys differ, only in intents_keys\(\): ed25519:INTENTS/);
});

test("cage-check attest mismatch ARCH-2.8-7: attest() turns an unreadable intents_keys() from UNKNOWN to RED, never the reverse", async () => {
  const r = await run({ views: { intents_keys: undefined, attest: attestOf(DEFAULT_VIEWS, { intents_keys: ["ed25519:INTENTS"] }) } });
  assert.equal(status(r, IDS.intentsKey), "RED");
  assert.equal(status(r, IDS.attestAgrees), "UNKNOWN");
  assert.equal(r.verdict, "RED");
});

test("cage-check attest mismatch ATTEST-1: revoked_keys that differ are RED, in either direction", async () => {
  const fromAttest = await run(withAttest({ revoked_keys: ["ed25519:OLD"] }));
  assert.deepEqual(states(fromAttest).red, [IDS.attestAgrees]);
  assert.match(row(fromAttest, IDS.attestAgrees).detail, /revoked_keys differ, only in attest\(\): ed25519:OLD/);
  const fromView = await run(withAttest({ revoked_keys: [] }, { revoked_keys: ["ed25519:OLD"] }));
  assert.deepEqual(states(fromView).red, [IDS.attestAgrees]);
  assert.match(row(fromView, IDS.attestAgrees).detail, /only in revoked_keys\(\): ed25519:OLD/);
});

test("cage-check attest mismatch ATTEST-1: config fields that differ from config() are RED and named, including a field only one side has", async () => {
  const delay = await run(withAttest({ config: { era: "Calm", delay_secs: 90_000 } }));
  assert.deepEqual(states(delay).red, [IDS.attestAgrees]);
  assert.deepEqual(row(delay, IDS.attestAgrees).offenders, ["config.delay_secs"]);
  assert.match(row(delay, IDS.attestAgrees).detail, /delay_secs 90000 against 86400/);
  assert.deepEqual(states(await run(withAttest({ config: { era: "Kaigen", delay_secs: 86_400 } }))).red, [IDS.attestAgrees]);
  const extra = await run(withAttest({ config: { era: "Calm", delay_secs: 86_400, max_strikes: 3 } }));
  assert.deepEqual(row(extra, IDS.attestAgrees).offenders, ["config.max_strikes"]);
});

test("cage-check attest mismatch ATTEST-1: an attest() that answered as another account is RED", async () => {
  const r = await run(withAttest({ account_id: "other.test" }));
  assert.deepEqual(states(r).red, [IDS.attestAgrees]);
  assert.match(row(r, IDS.attestAgrees).detail, /answered as other\.test, the account asked about is vault\.test/);
});

test("cage-check attest ATTEST-1: when config() cannot be read nothing disagrees but the comparison is incomplete: UNKNOWN, cross-check partial", async () => {
  const r = await run({ views: { config: undefined } });
  assert.deepEqual(states(r), { red: [], unknown: [IDS.attestAgrees] });
  assert.equal(r.info.attest_cross_check, "partial");
  assert.match(row(r, IDS.attestAgrees).detail, /config\(\) could not be read/);
});

test("cage-check attest ATTEST-2: a drill build is RED on ATTEST-2 only", async () => {
  const r = await run(withAttest({ drill_build: true }));
  assert.deepEqual(states(r).red, [IDS.productionBuild]);
  assert.deepEqual(row(r, IDS.productionBuild).offenders, ["drill_build"]);
  assert.equal(exitCodeOf(r), 1);
});

test("cage-check attest ATTEST-2: a delay under min_delay_secs is RED, exactly the minimum is not", async () => {
  const short = { config: { era: "Calm", delay_secs: 3_600 } };
  const r = await run(withAttest(short, short));
  assert.deepEqual(states(r).red, [IDS.productionBuild]);
  assert.match(row(r, IDS.productionBuild).detail, /delay_secs 3600 is under min_delay_secs 86400/);
  const both = await run(withAttest({ ...short, drill_build: true }, short));
  assert.match(row(both, IDS.productionBuild).detail, /drill_build is true.*; config\.delay_secs 3600 is under/);
  const atMin = { config: { era: "Calm", delay_secs: 86_400 } };
  assert.equal((await run(withAttest(atMin, atMin))).verdict, "GREEN");
});

test("cage-check attest: an answer that is not Mamori's attest of this version is RED on ATTEST-1 (ATTEST-2 unchecked), never read as clean", async () => {
  const good = attestOf(DEFAULT_VIEWS);
  const without = (name) => Object.fromEntries(Object.entries(good).filter(([k]) => k !== name));
  const bad = {
    "a string": "ok",
    "a list": [],
    "null": null,
    "another contract": { ...good, contract: "other" },
    "no version": without("attest_version"),
    "version 0": { ...good, attest_version: 0 },
    "no daily_keys": without("daily_keys"),
    "daily_keys of bare strings": { ...good, daily_keys: ["ed25519:D1"] },
    "no intents_keys": without("intents_keys"),
    "no revoked_keys": without("revoked_keys"),
    "drill_build as text": { ...good, drill_build: "false" },
    "no config": without("config"),
    "delay_secs as text": { ...good, config: { era: "Calm", delay_secs: "86400" } },
    "no min_delay_secs": without("min_delay_secs"),
    "no account_id": without("account_id"),
  };
  for (const [what, raw] of Object.entries(bad)) {
    const r = await run({ views: { attest: raw } });
    assert.deepEqual(states(r), { red: [IDS.attestAgrees], unknown: [IDS.productionBuild, ...STRETCH] }, what);
    assert.equal(exitCodeOf(r), 1, what);
    assert.equal(r.info.attest_cross_check, "malformed", what);
  }
});

test("cage-check attest: a newer attest_version is UNKNOWN (a field may have changed meaning), a new field at the same version is fine", async () => {
  const newer = await run({ views: { attest: attestOf(DEFAULT_VIEWS, { attest_version: ATTEST_VERSION + 1 }) } });
  assert.deepEqual(states(newer), { red: [], unknown: [IDS.attestAgrees, IDS.productionBuild, ...STRETCH] });
  assert.match(row(newer, IDS.attestAgrees).detail, /attest_version 2, this check reads 1/);
  assert.equal(newer.info.attest_cross_check, "unsupported");
  const extra = await run({ views: { attest: attestOf(DEFAULT_VIEWS, { a_field_added_later: { x: 1 } }) } });
  assert.equal(extra.verdict, "GREEN");
});

test("cage-check attest can only add a red or an unchecked: a lying or clean attest() never turns one of the eight rows green", async () => {
  // The account's own full-access key can deploy an attest() that says anything. Whatever it says, these stay as RPC reads them.
  const planted = [key(ADMIN), D1, D2, key("ed25519:PLANTED")];
  assert.deepEqual(states(await run({ keys: planted, views: { attest: attestOf(DEFAULT_VIEWS) } })).red, [IDS.classicalFullAccess], "a clean attest() does not hide a planted full-access key");
  // It claims the planted function-call key as recorded; the vault's view does not, so row 6 stays red, and the books disagree.
  const claimed = await run({ keys: [key(ADMIN), D1, D2, key("ed25519:PLANTED", fc())], views: { attest: attestOf(DEFAULT_VIEWS, { daily_keys: DAILY("ed25519:D1", "ed25519:D2", "ed25519:PLANTED") }) } });
  assert.deepEqual(states(claimed).red, [IDS.unrecorded, IDS.attestAgrees]);
  // A clean attest() does not make an unpinned code hash,, a clean bill.
  assert.deepEqual(states(await run({}, { pinnedCodeHash: undefined })), { red: [], unknown: [IDS.codeHash] });
  // And a clean attest() does not make a swapped code hash green: the code could be one that lies.
  assert.deepEqual(states(await run({ acc: { amount: "1", code_hash: codeHashOf(Buffer.from("liar")) } })).red, [IDS.codeHash]);
});

test("cage-check parseAttestation and crossCheckAttest: states and the shape of the result", () => {
  const facts = (over = {}) => ({
    account: VAULT, block: { height: 1, hash: "h" }, keys: [key(ADMIN), D1, D2],
    recorded: { daily: { value: ["ed25519:D1", "ed25519:D2"] }, intents: { value: [] }, revoked: { value: [] } }, config: { value: DEFAULT_VIEWS.config }, ...over,
  });
  const present = (raw) => ({ status: "present", raw });
  assert.equal(parseAttestation(undefined).state, "absent");
  assert.equal(parseAttestation({ status: "absent" }).state, "absent");
  assert.equal(parseAttestation({ status: "error", error: "x" }).state, "unreadable");
  assert.equal(parseAttestation(present({})).state, "malformed");
  const ok = parseAttestation(present(attestOf(DEFAULT_VIEWS)));
  assert.equal(ok.state, "ok");
  assert.deepEqual(ok.a.daily, ["ed25519:D1", "ed25519:D2"], "daily_keys is reduced to the public keys");
  assert.deepEqual(crossCheckAttest(present(attestOf(DEFAULT_VIEWS)), facts()), { status: "agree", problems: [], findings: [], unchecked: [], attest: ok.a });
  const disagree = crossCheckAttest(present(attestOf(DEFAULT_VIEWS, { drill_build: true })), facts());
  assert.equal(disagree.status, "disagree");
  assert.deepEqual(disagree.findings.map((f) => f.id), [IDS.productionBuild]);
  const partial = crossCheckAttest(present(attestOf(DEFAULT_VIEWS)), facts({ config: { error: "x" } }));
  assert.deepEqual([partial.status, partial.findings.length, partial.unchecked.map((u) => u.id)], ["partial", 0, [IDS.attestAgrees]]);
  const none = crossCheckAttest({ status: "absent" }, facts());
  assert.deepEqual([none.status, none.findings, none.unchecked, none.attest], ["absent", [], [], null]);
});

test("cage-check attest: read for real by readCageFacts, pinned to the one block like every other read", async () => {
  const rpc = rpcOf(cleanWorld());
  const facts = await readCageFacts({ rpc, account: VAULT });
  assert.equal(facts.attest.status, "present");
  assert.equal(facts.attest.raw.contract, "mamori");
  const calls = rpc.calls.filter((c) => c.method === "query" && c.params.method_name === "attest");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.block_id, "H100");
});

// ---- output --------------------------------------------------------------------------------------------------------

test("cage-check text report: one line per condition by id, the verdict line, and the limits", async () => {
  const text = renderCage(await run({ keys: [key(ADMIN), D1, D2, key("ed25519:PLANTED")] }));
  for (const id of Object.values(IDS)) assert.match(text, new RegExp(`(RED|GREEN|UNKNOWN)\\s+${id}  `));
  assert.match(text, /^RED +ARCH-2\.8-1 /m);
  assert.match(text, /^GREEN +ARCH-2\.8-2 /m);
  assert.match(text, /RED: 1 of 15 conditions fail\./);
  assert.match(text, /limit: point in time/);
  assert.match(renderCage(await run({})), /GREEN: all 15 conditions hold\./);
  assert.match(renderCage(await run({}, { pinnedCodeHash: undefined })), /UNKNOWN: nothing is red but 1 of 15 conditions could not be checked; this is not a clean bill\./);
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
      assert.match(ok.stdout, /GREEN: all 15 conditions hold\./);
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

// ---- the real shape ------------------------------------------------------------------------------------------------

/** attest() verbatim as the sandbox returned it (wasm sha256 A773D106..., 2026-11-03), so the parser is held to the contract's own output, not only to the doc. */
const REAL_ATTEST = `{"account_id":"dev-20261103140559-21233164518080.test.near","allowlist_enforced":true,"allowlist_len":1,"attest_version":1,"block_height":"465","block_timestamp":"1793714762890876020","config":{"daily_limit":"1000000000000000000000000","delay_secs":86400,"effective_delay_secs":86400,"era":"Calm","kizashi":"kizashi.test.near","max_strikes":3,"min_send":"1000000000000000000000","pending_limit":"10000000000000000000000000"},"contract":"mamori","daily_keys":[{"public_key":"ed25519:7wV4U82xudVpPNfPZVy4XSLKKnf3hA6P37kJrcWv3Qcd","strikes":0},{"public_key":"ed25519:9ui3t6qCE46MFKQUecA8ibjZ9QU3dsB1qKDTm1R6RWUh","strikes":0}],"drill_build":false,"intents_keys":[],"min_delay_secs":86400,"note":"informational: the state this contract records, not proof about the account. A full-access key can deploy a contract whose attest() says anything. Read the code hash and the key list from RPC (view_account, view_access_key_list).","queue_len":0,"revoked_keys":[]}`;

test("cage-check attest: the contract's real attest() output parses, agrees with matching views, and a change to it is caught", async () => {
  const raw = JSON.parse(REAL_ATTEST);
  const account = raw.account_id;
  const daily = raw.daily_keys.map((k) => k.public_key);
  const views = { daily_keys: daily, intents_keys: [], revoked_keys: [], config: raw.config, attest: raw };
  const acct = { height: 100, acc: { amount: "1", code_hash: PIN }, views };
  const keysOf = (extra = []) => [key(ADMIN), ...daily.map((d) => key(d, fc({ receiver_id: account }))), ...extra];
  const real = (world, pol) => cageCheck({ rpc: rpcOf({ ...acct, keys: keysOf(), ...world }), account, policy: policy(pol) });
  const ok = await real({});
  // This capture predates the stretch items: no policy_account, safe_account, watchers, emergency_until or proposals. Everything the
  // older answer can show is GREEN; the five rows that read the new fields say UNKNOWN (not GREEN), so the verdict is exit 3.
  assert.deepEqual(states(ok), { red: [], unknown: STRETCH }, JSON.stringify(ok.conditions.filter((c) => c.status === "RED")));
  assert.equal(ok.verdict, "UNKNOWN");
  assert.match(row(ok, IDS.safeAccount).detail, /attest\(\) lacks safe_account, emergency_until \(a vault built before the stretch items\)/);
  assert.deepEqual([ok.info.allowlist_enforced, ok.info.max_strikes, ok.info.attest_cross_check], [true, 3, "partial"], "partial: the stretch fields are not in this older answer");
  // The same answer with a field renamed or its type changed (what a contract edit would do) is not read as clean.
  const renamed = { ...raw, daily_keys: raw.daily_keys.map(({ public_key, strikes }) => ({ key: public_key, strikes })) };
  assert.deepEqual(states(await real({ views: { ...views, attest: renamed } })).red, [IDS.attestAgrees]);
  const retyped = { ...raw, config: { ...raw.config, delay_secs: String(raw.config.delay_secs) } };
  assert.deepEqual(states(await real({ views: { ...views, attest: retyped } })).red, [IDS.attestAgrees]);
  // A function-call key on the account that the real answer does not list is a row 6 red.
  const stranger = await real({ keys: keysOf([key("ed25519:STRANGER", fc({ receiver_id: account }))]) });
  assert.deepEqual(states(stranger).red, [IDS.unrecorded]);
});

// ---- the stretch rows ATTEST-3 .. ATTEST-7 (docs/v3/STRETCH-DESIGN.md; row table at the top of src/cage.mjs) -------------
// Every row: GREEN on a sound answer, RED on the condition the design forbids, UNKNOWN when attest() lacks its fields.

const NOW = 1_700_000_000_000_000_000n; // attestOf's block_timestamp
const SEC = 1_000_000_000n;
const DAY = 86_400n * SEC;
const at = (ns) => String(ns);
/** A world whose attest() carries `over` on top of the clean stretch fields. */
const stretch = (over, views) => withAttest(over, views);
const reds = async (over) => states(await run(stretch(over))).red;
/** An attest() with these fields left out, as an older vault answers. */
const without = (...names) => ({ views: { attest: Object.fromEntries(Object.entries(attestOf(DEFAULT_VIEWS)).filter(([k]) => !names.includes(k))) } });
/** A real ed25519 key and the implicit account it names, so ATTEST-4 can be shown a policy account that is a daily key's own. */
const REAL_KEY_BYTES = Buffer.alloc(32, 7);
const REAL_KEY = `ed25519:${base58.encode(REAL_KEY_BYTES)}`;
const REAL_KEY_ACCOUNT = REAL_KEY_BYTES.toString("hex");

test("cage-check stretch rows: a vault that uses all of them soundly is GREEN on ATTEST-3 .. ATTEST-7", async () => {
  const r = await run(stretch({
    policy_account: "policy.test",
    safe_account: { current: "safe.test", pending: { account: "next.test", effective_at: at(NOW + DAY / 2n) } },
    watchers: ["w1.test", "w2.test"],
    emergency_until: at(NOW + 7n * DAY),
    proposals: [{ id: "0", change: { kind: "allow_recipient" }, proposed_at: at(NOW - DAY / 2n), executable_at: at(NOW + DAY / 2n), expires_at: at(NOW + DAY + DAY / 2n) }],
  }));
  assert.deepEqual(states(r), { red: [], unknown: [] });
  assert.equal(r.verdict, "GREEN");
  assert.deepEqual(STRETCH.map((id) => status(r, id)), ["GREEN", "GREEN", "GREEN", "GREEN", "GREEN"]);
});

test("cage-check ATTEST-3: the safe account (in force or waiting) being the vault is RED; an open window with no safe account in force is RED", async () => {
  assert.deepEqual(await reds({ safe_account: { current: VAULT, pending: null } }), [IDS.safeAccount]);
  assert.deepEqual(await reds({ safe_account: { current: "safe.test", pending: { account: VAULT, effective_at: at(NOW + DAY) } } }), [IDS.safeAccount]);
  const armed = await run(stretch({ emergency_until: at(NOW + DAY), safe_account: { current: null, pending: { account: "next.test", effective_at: at(NOW + DAY) } } }));
  assert.deepEqual(states(armed).red, [IDS.safeAccount]);
  assert.match(row(armed, IDS.safeAccount).detail, /emergency window is open but no safe account is in force/);
  assert.equal(exitCodeOf(armed), 1);
  // Not red: no window and no safe account (a new vault), a window that closed, and a window with a safe account in force.
  assert.deepEqual(await reds({}), []);
  assert.deepEqual(await reds({ emergency_until: at(NOW) }), [], "at the block time a window is closed");
  assert.deepEqual(await reds({ emergency_until: at(NOW + DAY), safe_account: { current: "safe.test", pending: null } }), []);
  // attest() answering as another account does not hide it: the account asked about is the vault as well (ATTEST-1 is red too).
  assert.ok((await reds({ account_id: "other.test", safe_account: { current: "other.test", pending: null } })).includes(IDS.safeAccount));
});

test("cage-check ATTEST-3: UNKNOWN when attest() lacks safe_account or emergency_until or block_timestamp", async () => {
  for (const name of ["safe_account", "emergency_until", "block_timestamp"]) {
    const r = await run(without(name));
    assert.equal(status(r, IDS.safeAccount), "UNKNOWN", name);
    assert.match(row(r, IDS.safeAccount).detail, new RegExp(`lacks .*${name}`));
    assert.equal(exitCodeOf(r), 3, name);
  }
});

test("cage-check ATTEST-4: the policy account or a watcher being the vault is RED", async () => {
  const policyIsVault = await run(stretch({ policy_account: VAULT }));
  assert.deepEqual(states(policyIsVault).red, [IDS.policyActors]);
  assert.match(row(policyIsVault, IDS.policyActors).detail, /policy account is the vault itself/);
  const watcherIsVault = await run(stretch({ watchers: ["w1.test", VAULT] }));
  assert.deepEqual(states(watcherIsVault).red, [IDS.policyActors]);
  assert.deepEqual(row(watcherIsVault, IDS.policyActors).offenders, [VAULT]);
  assert.match(row(watcherIsVault, IDS.policyActors).detail, /watcher is the vault itself/);
  assert.equal(exitCodeOf(watcherIsVault), 1);
});

test("cage-check ATTEST-4: a policy account or watcher that is a daily key's own (implicit) account is RED; a policy path that is off is not", async () => {
  const views = { daily_keys: ["ed25519:D1", REAL_KEY] };
  const keys = [key(ADMIN), D1, key(REAL_KEY, fc())];
  const daily = DAILY("ed25519:D1", REAL_KEY);
  const policyKey = await run({ ...stretch({ policy_account: REAL_KEY_ACCOUNT, daily_keys: daily }, views), keys });
  assert.deepEqual(states(policyKey).red, [IDS.policyActors]);
  assert.match(row(policyKey, IDS.policyActors).detail, new RegExp(`implicit account of the daily key ${REAL_KEY}`));
  const watcherKey = await run({ ...stretch({ watchers: [REAL_KEY_ACCOUNT], daily_keys: daily }, views), keys });
  assert.deepEqual(states(watcherKey).red, [IDS.policyActors]);
  // A function-call key on the account that the vault does not record is read too (that is already ARCH-2.8-6 RED).
  const planted = await run({ ...stretch({ policy_account: REAL_KEY_ACCOUNT }), keys: [key(ADMIN), D1, D2, key(REAL_KEY, fc())] });
  assert.ok(states(planted).red.includes(IDS.policyActors));
  assert.deepEqual(await reds({ policy_account: null, watchers: [] }), [], "policy path off: nothing to police");
  assert.deepEqual(await reds({ policy_account: "policy.test", watchers: ["w.test"] }), []);
});

test("cage-check ATTEST-4: more than 4 watchers, or one listed twice, is RED", async () => {
  assert.deepEqual(await reds({ watchers: ["a.test", "b.test", "c.test", "d.test"] }), [], "4 is the limit");
  assert.deepEqual(await reds({ watchers: ["a.test", "b.test", "c.test", "d.test", "e.test"] }), [IDS.policyActors]);
  const twice = await run(stretch({ watchers: ["a.test", "b.test", "a.test"] }));
  assert.deepEqual(states(twice).red, [IDS.policyActors]);
  assert.match(row(twice, IDS.policyActors).detail, /watcher listed twice: a\.test/);
});

test("cage-check ATTEST-4: UNKNOWN when attest() lacks policy_account or watchers (a null policy_account is a field, not an absence)", async () => {
  for (const name of ["policy_account", "watchers"]) {
    const r = await run(without(name));
    assert.equal(status(r, IDS.policyActors), "UNKNOWN", name);
    assert.match(row(r, IDS.policyActors).detail, new RegExp(`lacks ${name}`));
  }
  assert.equal(status(await run(stretch({ policy_account: null })), IDS.policyActors), "GREEN");
});

test("cage-check ATTEST-5: an emergency window ending more than 7 days after the block is RED; exactly 7 days or a closed one is not", async () => {
  assert.equal(status(await run(stretch({ emergency_until: at(NOW + 7n * DAY), safe_account: { current: "safe.test", pending: null } })), IDS.emergencyWindow), "GREEN", "exactly 7 days is allowed");
  const long = await run(stretch({ emergency_until: at(NOW + 7n * DAY + 1n), safe_account: { current: "safe.test", pending: null } }));
  assert.deepEqual(states(long).red, [IDS.emergencyWindow]);
  assert.match(row(long, IDS.emergencyWindow).detail, /ends 7 days after the block, the longest allowed is 7/);
  assert.equal(exitCodeOf(long), 1);
  const forever = await run(stretch({ emergency_until: at(NOW + 400n * DAY), safe_account: { current: "safe.test", pending: null } }));
  assert.deepEqual(states(forever).red, [IDS.emergencyWindow]);
  assert.match(row(forever, IDS.emergencyWindow).detail, /ends 400 days/);
  assert.equal(status(await run(stretch({ emergency_until: "0" })), IDS.emergencyWindow), "GREEN");
  assert.equal(status(await run(stretch({ emergency_until: at(NOW - DAY) })), IDS.emergencyWindow), "GREEN", "a window in the past is closed");
});

test("cage-check ATTEST-5: UNKNOWN when attest() lacks emergency_until or block_timestamp", async () => {
  for (const name of ["emergency_until", "block_timestamp"]) assert.equal(status(await run(without(name)), IDS.emergencyWindow), "UNKNOWN", name);
});

test("cage-check ATTEST-6: a pending safe-account change that unlocks at or before the block time, or later than one delay after it, is RED", async () => {
  const pend = (effective_at) => ({ safe_account: { current: "safe.test", pending: { account: "next.test", effective_at: at(effective_at) } } });
  assert.deepEqual(await reds(pend(NOW + DAY)), [], "one delay after the block time is the latest a change set now can unlock");
  assert.deepEqual(await reds(pend(NOW + 1n)), [], "waiting, nearly due");
  const due = await run(stretch(pend(NOW)));
  assert.deepEqual(states(due).red, [IDS.safeChange]);
  assert.match(row(due, IDS.safeChange).detail, /not after the block time .*did not wait its delay/);
  assert.deepEqual(row(due, IDS.safeChange).offenders, ["next.test"]);
  assert.deepEqual(await reds(pend(1n)), [IDS.safeChange]);
  const late = await run(stretch(pend(NOW + DAY + 1n)));
  assert.deepEqual(states(late).red, [IDS.safeChange]);
  assert.match(row(late, IDS.safeChange).detail, /more than delay_secs 86400 after the block time/);
  assert.equal(exitCodeOf(late), 1);
  assert.equal(status(await run(stretch({ safe_account: { current: "safe.test", pending: null } })), IDS.safeChange), "GREEN");
});

test("cage-check ATTEST-6: the delay is the vault's own delay_secs; UNKNOWN when attest() lacks safe_account or block_timestamp", async () => {
  const longDelay = { config: { era: "Calm", delay_secs: 3 * 86_400 } };
  const world = (effective_at) => withAttest({ safe_account: { current: "safe.test", pending: { account: "next.test", effective_at: at(effective_at) } } }, longDelay);
  assert.equal(status(await run(world(NOW + 3n * DAY)), IDS.safeChange), "GREEN");
  assert.equal(status(await run(world(NOW + 3n * DAY + 1n)), IDS.safeChange), "RED");
  for (const name of ["safe_account", "block_timestamp"]) assert.equal(status(await run(without(name)), IDS.safeChange), "UNKNOWN", name);
});

test("cage-check ATTEST-7: a proposal that can run sooner than one delay after it was proposed, or more than 8 waiting, is RED", async () => {
  const prop = (id, proposed_at, executable_at) => ({ id: String(id), change: { kind: "allow_recipient", account: "x.test" }, proposed_at: at(proposed_at), executable_at: at(executable_at), expires_at: at(executable_at + DAY) });
  assert.deepEqual(await reds({ proposals: [prop(0, NOW - DAY, NOW)] }), [], "exactly the delay");
  const fast = await run(stretch({ proposals: [prop(0, NOW - DAY, NOW), prop(1, NOW - DAY / 2n, NOW + DAY / 2n - 1n)] }));
  assert.deepEqual(states(fast).red, [IDS.proposals]);
  assert.match(row(fast, IDS.proposals).detail, /proposal 1 can run 86399999999999 ns after it was proposed, under delay_secs 86400/);
  assert.deepEqual(row(fast, IDS.proposals).offenders, ["proposal 1"]);
  assert.equal(exitCodeOf(fast), 1);
  const nine = Array.from({ length: 9 }, (_, i) => prop(i, NOW - DAY, NOW));
  assert.deepEqual(await reds({ proposals: nine.slice(0, 8) }), [], "8 is the limit");
  const crowded = await run(stretch({ proposals: nine }));
  assert.deepEqual(states(crowded).red, [IDS.proposals]);
  assert.match(row(crowded, IDS.proposals).detail, /9 proposals wait, the contract allows at most 8/);
  assert.equal(status(await run(stretch({ proposals: [] })), IDS.proposals), "GREEN");
});

test("cage-check ATTEST-7: UNKNOWN when attest() lacks proposals", async () => {
  const r = await run(without("proposals"));
  assert.equal(status(r, IDS.proposals), "UNKNOWN");
  assert.match(row(r, IDS.proposals).detail, /lacks proposals/);
  assert.deepEqual(states(r), { red: [], unknown: [IDS.proposals] });
  assert.equal(exitCodeOf(r), 3);
});

test("cage-check stretch rows: an older vault (none of the five fields) is UNKNOWN on exactly those rows and GREEN elsewhere, exit 3", async () => {
  const r = await run(without("policy_account", "safe_account", "watchers", "emergency_until", "proposals"));
  assert.deepEqual(states(r), { red: [], unknown: STRETCH });
  assert.equal(r.verdict, "UNKNOWN");
  assert.equal(exitCodeOf(r), 3);
  assert.match(renderCage(r), /UNKNOWN: nothing is red but 5 of 15 conditions could not be checked/);
});

test("cage-check stretch rows: a field of the wrong shape makes attest() malformed (ATTEST-1 RED, the other attest rows UNKNOWN), never read as clean", async () => {
  const bad = {
    "policy_account as a number": { policy_account: 7 },
    "safe_account as a string": { safe_account: "safe.test" },
    "safe_account.pending without effective_at": { safe_account: { current: null, pending: { account: "n.test" } } },
    "safe_account without pending": { safe_account: { current: null } },
    "watchers as a string": { watchers: "w.test" },
    "emergency_until as a number": { emergency_until: 5 },
    "emergency_until as text": { emergency_until: "soon" },
    "proposals as an object": { proposals: {} },
    "a proposal without executable_at": { proposals: [{ id: "0", proposed_at: "1" }] },
    "block_timestamp as a number": { block_timestamp: 1 },
  };
  for (const [what, over] of Object.entries(bad)) {
    const r = await run(stretch(over));
    assert.deepEqual(states(r), { red: [IDS.attestAgrees], unknown: [IDS.productionBuild, ...STRETCH] }, what);
    assert.equal(r.info.attest_cross_check, "malformed", what);
    assert.equal(exitCodeOf(r), 1, what);
  }
});

test("cage-check stretch rows never make a result greener: a planted key stays RED with sound stretch fields, a v2 vault stays UNKNOWN on every stretch row", async () => {
  const planted = await run({ keys: [key(ADMIN), D1, D2, key("ed25519:PLANTED")], ...stretch({ policy_account: "policy.test", safe_account: { current: "safe.test", pending: null }, watchers: ["w.test"] }) });
  assert.deepEqual(states(planted), { red: [IDS.classicalFullAccess], unknown: [] });
  const v2 = await run({ views: NO_ATTEST });
  assert.deepEqual(STRETCH.map((id) => status(v2, id)), ["UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN"]);
});
