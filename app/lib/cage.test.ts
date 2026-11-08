import test from "node:test";
import assert from "node:assert/strict";
import { base58Decode, evaluateCage, exitCodeOf, implicitAccountOf, isCodeHash, isMamori, KNOWN_PINS, keyRows, type CageFacts, type RpcKey } from "./cage.ts";

const VAULT = "pv-45cbcb96.kaigen-funder-ee0d56.testnet";
const ADMIN = "ml-dsa-65-hash:BrXHPEEZqnGA3x39K381CKgNG3o1gH9i8x1pCEBMuCdo";
const PIN = "AoxPd3zABfzDRoPsE14ReAzMrzq5o5rMFj8FZXn9zKoQ";
const DAILY = "ed25519:DaiLy1111111111111111111111111111111111111";

const full = (public_key: string): RpcKey => ({ public_key, access_key: { nonce: 0, permission: "FullAccess" } });
const fc = (public_key: string, p: { allowance?: string | null; receiver_id?: string; method_names?: string[] } = {}): RpcKey => ({
  public_key,
  access_key: {
    nonce: 0,
    permission: { FunctionCall: { allowance: p.allowance === undefined ? "250000000000000000000000" : p.allowance, receiver_id: p.receiver_id ?? VAULT, method_names: p.method_names ?? ["send_small", "request_withdraw"] } },
  },
});

const config = { kizashi: "k.testnet", era: "Calm", daily_limit: "1000", delay_secs: 86400, effective_delay_secs: 86400, max_strikes: 3, pending_limit: "3000", min_send: "1" };
const attestOf = (over: Record<string, unknown> = {}) => ({
  attest_version: 1,
  contract: "mamori",
  drill_build: false,
  account_id: VAULT,
  block_height: "1",
  block_timestamp: "1000000000000000000",
  config,
  min_delay_secs: 86400,
  allowlist_enforced: false,
  allowlist_len: 0,
  daily_keys: [{ public_key: DAILY, strikes: 0 }],
  intents_keys: [],
  revoked_keys: [],
  queue_len: 0,
  policy_account: null,
  safe_account: { current: null, pending: null },
  watchers: [],
  emergency_until: "0",
  proposals: [],
  ...over,
});

function facts(over: Partial<CageFacts> = {}): CageFacts {
  return {
    account: VAULT,
    block: { height: 1, hash: "H" },
    acc: { code_hash: "11111111111111111111111111111111", global_contract_hash: PIN },
    keys: [full(ADMIN), fc(DAILY)],
    recorded: { daily: { value: [DAILY] }, intents: { value: [] }, revoked: { value: [] } },
    config: { value: config },
    attest: { status: "present", raw: attestOf() },
    ...over,
  };
}
const policy = { knownPins: [...KNOWN_PINS] };
const row = (r: ReturnType<typeof evaluateCage>, id: string) => r.conditions.find((c) => c.id === id)!;

test("the production-mode vault shape is GREEN on all 15 rows (cage-check exit 0)", () => {
  const r = evaluateCage(facts(), policy);
  assert.equal(r.conditions.length, 15);
  assert.deepEqual(r.conditions.filter((c) => c.status !== "GREEN"), []);
  assert.equal(r.verdict, "GREEN");
  assert.equal(exitCodeOf(r), 0);
  assert.ok(isMamori(facts()));
});

test("ARCH-2.8-1: a classical full-access key is RED and named (exit 1)", () => {
  const r = evaluateCage(facts({ keys: [full(ADMIN), full("ed25519:Planted"), fc(DAILY)] }), policy);
  assert.equal(r.verdict, "RED");
  assert.equal(exitCodeOf(r), 1);
  assert.deepEqual(row(r, "ARCH-2.8-1").offenders, ["ed25519:Planted"]);
});

test("ARCH-2.8-2: two ML-DSA keys, or none, is RED; an expected admin that differs is RED; a matching one is GREEN", () => {
  assert.equal(row(evaluateCage(facts({ keys: [full(ADMIN), full("ml-dsa-65-hash:Other"), fc(DAILY)] }), policy), "ARCH-2.8-2").status, "RED");
  assert.equal(row(evaluateCage(facts({ keys: [fc(DAILY)] }), policy), "ARCH-2.8-2").status, "RED");
  assert.equal(row(evaluateCage(facts(), { ...policy, admin: "ml-dsa-65-hash:Other" }), "ARCH-2.8-2").status, "RED");
  assert.equal(row(evaluateCage(facts(), { ...policy, admin: ADMIN }), "ARCH-2.8-2").status, "GREEN");
  assert.equal(row(evaluateCage(facts(), { ...policy, admin: "ml-dsa-65:FULLKEY" }), "ARCH-2.8-2").status, "UNKNOWN");
});

test("ARCH-2.8-3/4/5: unlimited allowance, any-method key and a key reaching another account are RED", () => {
  const r3 = evaluateCage(facts({ keys: [full(ADMIN), fc(DAILY, { allowance: null })] }), policy);
  assert.equal(row(r3, "ARCH-2.8-3").status, "RED");
  const r3b = evaluateCage(facts({ keys: [full(ADMIN), fc(DAILY, { allowance: "250000000000000000000001" })] }), policy);
  assert.equal(row(r3b, "ARCH-2.8-3").status, "RED");
  const r4 = evaluateCage(facts({ keys: [full(ADMIN), fc(DAILY, { method_names: [] })] }), policy);
  assert.equal(row(r4, "ARCH-2.8-4").status, "RED");
  const r5 = evaluateCage(facts({ keys: [full(ADMIN), fc(DAILY, { receiver_id: "evil.testnet" })] }), policy);
  assert.equal(row(r5, "ARCH-2.8-5").status, "RED");
  const r5b = evaluateCage(facts({ keys: [full(ADMIN), fc(DAILY, { method_names: ["send_small", "ft_transfer"] })] }), policy);
  assert.equal(row(r5b, "ARCH-2.8-5").status, "RED");
});

test("ARCH-2.8-6: a function-call key the vault does not record is RED; one pending deletion is said so", () => {
  const stray = "ed25519:Stray";
  const r = evaluateCage(facts({ keys: [full(ADMIN), fc(DAILY), fc(stray)], recorded: { daily: { value: [DAILY] }, intents: { value: [] }, revoked: { value: [stray] } } }), policy);
  const c = row(r, "ARCH-2.8-6");
  assert.equal(c.status, "RED");
  assert.match(c.detail, /revoked_keys/);
});

test("ARCH-2.8-6: daily_keys() unreadable is UNKNOWN, never GREEN", () => {
  const r = evaluateCage(facts({ recorded: { daily: { error: "boom" }, intents: { value: [] }, revoked: { value: [] } } }), policy);
  assert.equal(row(r, "ARCH-2.8-6").status, "UNKNOWN");
  assert.equal(r.verdict, "UNKNOWN");
  assert.equal(exitCodeOf(r), 3);
});

test("ARCH-2.8-7: a recorded intents key is RED (from the view, and from attest())", () => {
  const r = evaluateCage(facts({ recorded: { daily: { value: [DAILY] }, intents: { value: ["ed25519:I"] }, revoked: { value: [] } } }), policy);
  assert.equal(row(r, "ARCH-2.8-7").status, "RED");
  const r2 = evaluateCage(facts({ attest: { status: "present", raw: attestOf({ intents_keys: ["ed25519:I"] }) } }), policy);
  assert.equal(row(r2, "ARCH-2.8-7").status, "RED");
});

test("ARCH-2.8-8: the known hash is GREEN, an unknown hash is UNKNOWN (not RED), a typed pin that differs is RED, a publisher reference is RED", () => {
  assert.equal(row(evaluateCage(facts(), policy), "ARCH-2.8-8").status, "GREEN");
  const other = facts({ acc: { code_hash: "SomethingElse", global_contract_hash: null } });
  assert.equal(row(evaluateCage(other, policy), "ARCH-2.8-8").status, "UNKNOWN");
  assert.equal(row(evaluateCage(other, { ...policy, userPins: [PIN] }), "ARCH-2.8-8").status, "RED");
  assert.equal(row(evaluateCage(other, { ...policy, userPins: ["SomethingElse"] }), "ARCH-2.8-8").status, "GREEN");
  const byPublisher = facts({ acc: { code_hash: "x", global_contract_account_id: "publisher.testnet" } });
  assert.equal(row(evaluateCage(byPublisher, policy), "ARCH-2.8-8").status, "RED");
});

test("ATTEST-2: a drill build, or a delay under the floor, is RED", () => {
  const drill = evaluateCage(facts({ attest: { status: "present", raw: attestOf({ drill_build: true }) } }), policy);
  assert.equal(row(drill, "ATTEST-2").status, "RED");
  const short = { ...config, delay_secs: 3600, effective_delay_secs: 3600 };
  const r = evaluateCage(facts({ config: { value: short }, attest: { status: "present", raw: attestOf({ config: short }) } }), policy);
  assert.equal(row(r, "ATTEST-2").status, "RED");
});

test("ATTEST-1: attest() that disagrees with the views is RED", () => {
  const r = evaluateCage(facts({ attest: { status: "present", raw: attestOf({ daily_keys: [] }) } }), policy);
  assert.equal(row(r, "ATTEST-1").status, "RED");
  const r2 = evaluateCage(facts({ attest: { status: "present", raw: attestOf({ account_id: "someone.else" }) } }), policy);
  assert.equal(row(r2, "ATTEST-1").status, "RED");
});

test("an account without attest() is never GREEN: the seven ATTEST rows are UNKNOWN (cage-check exit 3)", () => {
  const r = evaluateCage(facts({ attest: { status: "absent", error: "MethodNotFound" } }), policy);
  assert.equal(r.conditions.filter((c) => c.id.startsWith("ATTEST") && c.status === "UNKNOWN").length, 7);
  assert.equal(r.verdict, "UNKNOWN");
  assert.equal(exitCodeOf(r), 3);
  assert.equal(isMamori(facts({ attest: { status: "absent" } })), false);
});

test("a malformed attest() is ATTEST-1 RED and the rest UNKNOWN; a newer attest_version is UNKNOWN", () => {
  const bad = evaluateCage(facts({ attest: { status: "present", raw: { contract: "other" } } }), policy);
  assert.equal(row(bad, "ATTEST-1").status, "RED");
  assert.equal(row(bad, "ATTEST-3").status, "UNKNOWN");
  const newer = evaluateCage(facts({ attest: { status: "present", raw: attestOf({ attest_version: 2 }) } }), policy);
  assert.equal(row(newer, "ATTEST-1").status, "UNKNOWN");
});

test("stretch rows: absent fields are UNKNOWN; a safe account that is the vault, too many watchers and a short proposal are RED", () => {
  const raw = attestOf();
  delete (raw as Record<string, unknown>).watchers;
  assert.equal(row(evaluateCage(facts({ attest: { status: "present", raw } }), policy), "ATTEST-4").status, "UNKNOWN");
  const safe = evaluateCage(facts({ attest: { status: "present", raw: attestOf({ safe_account: { current: VAULT, pending: null } }) } }), policy);
  assert.equal(row(safe, "ATTEST-3").status, "RED");
  const w = evaluateCage(facts({ attest: { status: "present", raw: attestOf({ watchers: ["a", "b", "c", "d", "e"] }) } }), policy);
  assert.equal(row(w, "ATTEST-4").status, "RED");
  const prop = evaluateCage(facts({ attest: { status: "present", raw: attestOf({ proposals: [{ id: "7", proposed_at: "100", executable_at: "200" }] }) } }), policy);
  assert.equal(row(prop, "ATTEST-7").status, "RED");
});

test("an ordinary account (no contract, one ed25519 full-access key) is RED on ARCH-2.8-1 and is not a Mamori vault", () => {
  const f = facts({
    account: "alice.testnet",
    acc: { code_hash: "11111111111111111111111111111111" },
    keys: [full("ed25519:Alice")],
    recorded: { daily: { error: "no contract code" }, intents: { error: "x" }, revoked: { error: "x" } },
    config: { error: "x" },
    attest: { status: "absent", error: "CodeDoesNotExist" },
  });
  const r = evaluateCage(f, policy);
  assert.equal(r.verdict, "RED");
  assert.deepEqual(row(r, "ARCH-2.8-1").offenders, ["ed25519:Alice"]);
  assert.equal(isMamori(f), false);
});

test("keyRows reports type, receiver, methods and allowance", () => {
  const rows = keyRows([full(ADMIN), fc(DAILY), { public_key: "ed25519:Odd", access_key: { nonce: 0, permission: "Weird" } }]);
  assert.equal(rows[0].kind, "full");
  assert.equal(rows[1].kind === "function-call" && rows[1].receiver, VAULT);
  assert.equal(rows[1].kind === "function-call" && rows[1].methods.join(), "send_small,request_withdraw");
  assert.equal(rows[2].kind, "unknown");
});

test("base58 helpers: a 32-byte hash is a code hash, an implicit account is the key's hex", () => {
  assert.equal(isCodeHash(PIN), true);
  assert.equal(isCodeHash("not-base58-0OIl"), false);
  assert.equal(isCodeHash("abc"), false);
  assert.equal(base58Decode("11")?.length, 2);
  assert.equal(implicitAccountOf("ed25519:" + "1".repeat(32)), "00".repeat(32));
  assert.equal(implicitAccountOf("secp256k1:abc"), null);
});
