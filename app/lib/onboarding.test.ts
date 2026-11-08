import test from "node:test";
import assert from "node:assert/strict";
import { CREATE_OFF_ON_MAINNET } from "./vault-create.ts";
import { TESTNET_DEMO_VAULT, accountFromSearch, demoVaultFor, nextStep, vaultCandidates, vaultLink, type ProbeResult } from "./onboarding.ts";

const none: ProbeResult = { ok: false, kind: "none", message: "No contract is deployed on that account, so it is not a vault." };
const failed: ProbeResult = { ok: false, kind: "error", message: "RPC timed out" };
const isVault: ProbeResult = { ok: true };

test("without a connected account the next step is to connect", () => {
  assert.deepEqual(nextStep({ account: null, network: "testnet", candidates: [], results: {} }), { kind: "connect" });
});

test("candidates are the vault sub-account first, then the account itself, and only valid names", () => {
  assert.deepEqual(vaultCandidates("alice.testnet"), ["vault.alice.testnet", "alice.testnet"]);
  assert.deepEqual(vaultCandidates(null), []);
  // 64 characters is the longest account id: a sub-account that would be longer is dropped, the account itself is kept.
  const long = `${"a".repeat(58)}.near`;
  assert.deepEqual(vaultCandidates(long), [long]);
});

test("a candidate that has not been read yet holds the decision, even when a later one is already known to be a vault", () => {
  const candidates = ["vault.alice.testnet", "alice.testnet"];
  assert.deepEqual(nextStep({ account: "alice.testnet", network: "testnet", candidates, results: { "alice.testnet": isVault } }), {
    kind: "checking",
    account: "vault.alice.testnet",
  });
});

test("the first candidate that answers as a vault goes straight to the vault view", () => {
  const candidates = ["vault.alice.testnet", "alice.testnet"];
  assert.deepEqual(nextStep({ account: "alice.testnet", network: "testnet", candidates, results: { "vault.alice.testnet": none, "alice.testnet": isVault } }), {
    kind: "open-vault",
    account: "alice.testnet",
  });
  assert.deepEqual(nextStep({ account: "alice.testnet", network: "testnet", candidates, results: { "vault.alice.testnet": isVault } }), {
    kind: "open-vault",
    account: "vault.alice.testnet",
  });
});

test("when nothing is a vault, testnet offers Create vault and mainnet gives the existing sentence", () => {
  const candidates = ["vault.alice.testnet", "alice.testnet"];
  const results = { "vault.alice.testnet": none, "alice.testnet": none };
  assert.deepEqual(nextStep({ account: "alice.testnet", network: "testnet", candidates, results }), { kind: "choose", create: { enabled: true }, unreadable: [] });
  assert.deepEqual(nextStep({ account: "alice.near", network: "mainnet", candidates: ["vault.alice.near"], results: { "vault.alice.near": none } }), {
    kind: "choose",
    create: { enabled: false, reason: CREATE_OFF_ON_MAINNET },
    unreadable: [],
  });
});

test("a failed read is reported as unreadable, never as 'no vault'", () => {
  const step = nextStep({ account: "alice.testnet", network: "testnet", candidates: ["vault.alice.testnet"], results: { "vault.alice.testnet": failed } });
  assert.equal(step.kind, "choose");
  assert.deepEqual(step.kind === "choose" && step.unreadable, [{ account: "vault.alice.testnet", message: "RPC timed out" }]);
});

test("the vault link keeps the account in the query and survives a round trip", () => {
  const link = vaultLink("pv-45cbcb96.kaigen-funder-ee0d56.testnet");
  assert.equal(link, "/vault?account=pv-45cbcb96.kaigen-funder-ee0d56.testnet");
  assert.equal(accountFromSearch(link.slice(link.indexOf("?"))), "pv-45cbcb96.kaigen-funder-ee0d56.testnet");
});

test("accountFromSearch accepts a valid name in any case and refuses everything else", () => {
  assert.equal(accountFromSearch("?account=Alice.TESTNET"), "alice.testnet");
  assert.equal(accountFromSearch("?account="), null);
  assert.equal(accountFromSearch(""), null);
  assert.equal(accountFromSearch("?account=not%20an%20account"), null);
  assert.equal(accountFromSearch("?account=javascript:alert(1)"), null);
});

test("only testnet has a demo vault to offer", () => {
  assert.equal(demoVaultFor("testnet"), TESTNET_DEMO_VAULT);
  assert.equal(demoVaultFor("mainnet"), null);
});
