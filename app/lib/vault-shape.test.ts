import test from "node:test";
import assert from "node:assert/strict";
import { NOT_A_VAULT, isMissingView, lockdownOf, vaultShapeProblem } from "./vault-shape.ts";

const config = { kizashi: "kizashi.near", era: "Calm", daily_limit: "5000000000000000000000000", delay_secs: 3600, effective_delay_secs: 3600, max_strikes: 3, pending_limit: "1", min_send: "1" };
const withdrawal = { id: "1", token: null, amount: "1000", to: "bob.near", requested_at: "5", requested_by: "ed25519:x", unlocks_at: "1700000000000000000" };
const good = { config, keys: ["ed25519:abc"], queue: [withdrawal], spent: "0" };

test("APP-V1: what a Mamori vault answers passes", () => {
  assert.equal(vaultShapeProblem(good), null);
  assert.equal(vaultShapeProblem({ ...good, keys: [], queue: [] }), null, "a locked-down vault with nothing queued");
  assert.equal(vaultShapeProblem({ ...good, queue: [{ ...withdrawal, token: "usdc.near" }] }), null, "a token withdrawal");
});

test("APP-V1: a contract that answers the views with something else gets a sentence, not a TypeError", () => {
  // The page used to read config.kizashi first; with config null or a string that threw before any check ran.
  for (const config of [null, undefined, "nope", 7, [], {}]) {
    assert.equal(vaultShapeProblem({ ...good, config }), NOT_A_VAULT, JSON.stringify(config));
  }
  assert.equal(vaultShapeProblem({ ...good, config: { ...config, kizashi: 5 } }), NOT_A_VAULT);
  assert.equal(vaultShapeProblem({ ...good, config: { ...config, kizashi: "" } }), NOT_A_VAULT);
  assert.equal(vaultShapeProblem({ ...good, config: { ...config, era: "Eternal" } }), NOT_A_VAULT);
  assert.equal(vaultShapeProblem({ ...good, config: { ...config, daily_limit: "lots" } }), NOT_A_VAULT);
  assert.equal(vaultShapeProblem({ ...good, config: { ...config, delay_secs: "3600" } }), NOT_A_VAULT);
});

test("APP-V1: wrong keys, queue or spent are refused before the page renders them", () => {
  assert.equal(vaultShapeProblem({ ...good, keys: null }), NOT_A_VAULT);
  assert.equal(vaultShapeProblem({ ...good, keys: [1] }), NOT_A_VAULT);
  assert.equal(vaultShapeProblem({ ...good, queue: {} }), NOT_A_VAULT);
  assert.equal(vaultShapeProblem({ ...good, spent: 0 }), NOT_A_VAULT);
  assert.equal(vaultShapeProblem({ ...good, spent: "abc" }), NOT_A_VAULT, "BigInt('abc') would throw while rendering");
  // A queue entry the page would feed to BigInt, or read .to from, must not get that far.
  for (const bad of [null, "x", { ...withdrawal, unlocks_at: "soon" }, { ...withdrawal, amount: 5 }, { ...withdrawal, to: undefined }, { ...withdrawal, id: undefined }, { ...withdrawal, token: 5 }]) {
    assert.equal(vaultShapeProblem({ ...good, queue: [bad] }), NOT_A_VAULT, JSON.stringify(bad));
  }
});

test("APP-V2: revoked_keys and intents_keys are optional views, but an answer must be a key list", () => {
  assert.equal(vaultShapeProblem({ ...good, revoked: [], intents: [] }), null);
  assert.equal(vaultShapeProblem({ ...good, revoked: null, intents: null }), null, "a build without the views");
  assert.equal(vaultShapeProblem({ ...good, revoked: ["ed25519:old"] }), null);
  assert.equal(vaultShapeProblem({ ...good, revoked: "ed25519:old" }), NOT_A_VAULT);
  assert.equal(vaultShapeProblem({ ...good, intents: [1] }), NOT_A_VAULT);
});

test("APP-V2: a view the vault does not have is told apart from a real failure", () => {
  assert.equal(isMissingView(new Error("wasm execution failed with error: FunctionCallError(MethodResolveError(MethodNotFound))")), true);
  assert.equal(isMissingView(new Error("RPC 502")), false);
  assert.equal(isMissingView(new Error("The Mamori reference is empty")), false);
});

test("APP-V2: 'Post-quantum only' needs the era at kaigen, no daily key, no revoked key waiting, no intents key", () => {
  const ok = { era: "Kaigen", daily: 0, revoked: 0, intents: 0 } as const;
  assert.deepEqual(lockdownOf(ok), { label: "Post-quantum only", tone: "valid" });
  // The old rule: era kaigen and no daily keys. A revoked key whose delete is unconfirmed may still be on the account.
  assert.match(lockdownOf({ ...ok, revoked: 1 }).label, /Locking down: 1 key still to delete/);
  assert.equal(lockdownOf({ ...ok, revoked: 1 }).tone, "warning");
  assert.match(lockdownOf({ ...ok, intents: 3 }).label, /3 keys still to delete/);
  assert.match(lockdownOf({ ...ok, revoked: 2, intents: 1 }).label, /3 keys/, "both lists add up");
  // A list the vault does not offer is unknown, never empty.
  for (const unknown of [{ ...ok, revoked: null }, { ...ok, intents: null }, { ...ok, revoked: null, intents: null }]) {
    assert.equal(lockdownOf(unknown).tone, "warning");
    assert.match(lockdownOf(unknown).label, /not checked/);
  }
  assert.deepEqual(lockdownOf({ ...ok, daily: 2 }), { label: "Era: Kaigen", tone: "invalid" }, "still serving daily keys at kaigen");
  assert.deepEqual(lockdownOf({ era: "Calm", daily: 1, revoked: 0, intents: 0 }), { label: "Era: Calm", tone: "valid" });
  assert.deepEqual(lockdownOf({ era: "Warning", daily: 1, revoked: null, intents: null }), { label: "Era: Warning", tone: "warning" });
});
