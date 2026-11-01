import test from "node:test";
import assert from "node:assert/strict";
import { NOT_A_VAULT, vaultShapeProblem } from "./vault-shape.ts";

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
