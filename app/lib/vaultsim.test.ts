import test from "node:test";
import assert from "node:assert/strict";
import { DAY_MS, DEMO_ATTACKER, DEMO_SUPPLIER, YOCTO_PER_NEAR, demoConfig, formatNear, newVault, nearToYocto, pay, reachedOutsiders, spent24h, strikesNow, worstCase } from "./vaultsim.ts";

const NEAR = YOCTO_PER_NEAR;
const T0 = 2_000_000;

test("nearToYocto reads numbers and decimal strings exactly and refuses everything else", () => {
  assert.equal(nearToYocto(0.1), NEAR / 10n);
  assert.equal(nearToYocto("4.798363"), 4_798_363n * (NEAR / 1_000_000n));
  assert.equal(nearToYocto(5), 5n * NEAR);
  assert.equal(nearToYocto(0), 0n);
  assert.equal(nearToYocto(-1), null);
  assert.equal(nearToYocto(NaN), null);
  assert.equal(nearToYocto("1e3"), null);
  assert.equal(nearToYocto("0.0000000000000000000000001"), null, "25 places");
  assert.equal(nearToYocto(null), null);
  assert.equal(nearToYocto({}), null);
  assert.equal(formatNear(4_798_363n * (NEAR / 1_000_000n)), "4.798363");
  assert.equal(formatNear(NEAR / 10n), "0.1");
  assert.equal(formatNear(5n * NEAR), "5");
});

// Mirrors contracts/mamori/src/tests/demo_story.rs: the same vault (1 NEAR cap, three strikes, one allowlisted supplier,
// minimum send off because the story sends 1 yocto), the same four calls, the same numbers and refusal reasons.
test("demo_story: 0.1 NEAR goes through, three attacks are refused, the third burns the key, the next attempt is rejected", () => {
  let s = newVault({ ...demoConfig(), minSendYocto: 0n }, 100n * NEAR);
  assert.deepEqual([s.config.maxStrikes, s.config.allowlist, s.config.enforceAllowlist, s.keyAlive], [3, [DEMO_SUPPLIER], true, true]);

  // [1] SENT 0.1 NEAR to the supplier.
  let r = pay(s, DEMO_SUPPLIER, 0.1, T0);
  assert.equal(r.verdict.kind, "sent");
  s = r.state;
  assert.equal(strikesNow(s, T0), 0);
  assert.equal(spent24h(s, T0), NEAR / 10n);

  // [2] 1 yocto to an attacker: not on the allowlist, strike 1.
  r = pay(s, DEMO_ATTACKER, "0.000000000000000000000001", T0 + 1000);
  assert.equal(r.verdict.kind, "refused");
  assert.equal(r.verdict.reason, "recipient is not on the allowlist");
  assert.equal(r.verdict.code, "not_allowlisted");
  assert.deepEqual([r.verdict.strikes, r.verdict.burned], [1, false]);
  s = r.state;

  // [3] 5 NEAR to the supplier: far over the cap, strike 2.
  r = pay(s, DEMO_SUPPLIER, 5, T0 + 2000);
  assert.equal(r.verdict.kind, "refused");
  assert.equal(r.verdict.reason, "over the 24 h limit");
  assert.equal(r.verdict.code, "over_cap_total");
  assert.deepEqual([r.verdict.strikes, r.verdict.burned], [2, false]);
  s = r.state;

  // [4] 5 NEAR to the attacker: strike 3, the key is burned.
  r = pay(s, DEMO_ATTACKER, 5, T0 + 3000);
  assert.equal(r.verdict.reason, "recipient is not on the allowlist");
  assert.deepEqual([r.verdict.strikes, r.verdict.burned], [3, true]);
  assert.match(r.verdict.toolText, /strike 3 of 3, key burned/);
  s = r.state;
  assert.equal(s.keyAlive, false);
  assert.equal(spent24h(s, T0 + 3000), NEAR / 10n, "none of the attacks moved a yoctoNEAR");
  assert.equal(reachedOutsiders(s), 0n);

  // [6] the burned key's next attempt, even an honest one.
  r = pay(s, DEMO_SUPPLIER, 1e-9, T0 + 10_000);
  assert.equal(r.verdict.kind, "rejected");
  assert.equal(r.verdict.reason, "not a recorded daily key");
  assert.equal(r.verdict.code, "not_a_daily_key");
  assert.equal(r.state.balanceYocto, 100n * NEAR - NEAR / 10n);
});

test("the page's vault: a 1 NEAR cap, 5 NEAR balance; the full-balance attack is refused and counted", () => {
  const s = newVault(demoConfig(), 5n * NEAR, T0);
  const r = pay(s, DEMO_ATTACKER, 5, T0);
  assert.equal(r.verdict.toolText, "refused: recipient is not on the allowlist. strike 1 of 3");
  assert.equal(r.state.balanceYocto, 5n * NEAR);
});

test("the honest payment: 0.1 NEAR to the supplier, balance goes down, nothing reached an outsider", () => {
  const r = pay(newVault(demoConfig(), 5n * NEAR, T0), DEMO_SUPPLIER, 0.1, T0);
  assert.equal(r.verdict.toolText, "sent");
  assert.equal(r.state.balanceYocto, 5n * NEAR - NEAR / 10n);
  assert.equal(reachedOutsiders(r.state), 0n);
});

test("the cap: what fits the cap but not what is left is refused WITHOUT a strike; more than the whole cap is a strike", () => {
  let s = newVault(demoConfig(), 5n * NEAR, T0);
  s = pay(s, DEMO_SUPPLIER, 0.9, T0).state;
  const r = pay(s, DEMO_SUPPLIER, 0.2, T0 + 1);
  assert.equal(r.verdict.code, "cap_exhausted");
  assert.equal(r.verdict.counted, false);
  assert.equal(r.verdict.strikes, 0);
  assert.equal(r.verdict.toolText, "refused: over the 24 h limit.");
  const big = pay(s, DEMO_SUPPLIER, 1.5, T0 + 2);
  assert.equal(big.verdict.code, "over_cap_total");
  assert.equal(big.verdict.strikes, 1);
});

test("dust is refused without a strike, zero and junk are rejected without a strike", () => {
  const s = newVault(demoConfig(), 5n * NEAR, T0);
  assert.deepEqual([pay(s, DEMO_SUPPLIER, 0.0001, T0).verdict.code, pay(s, DEMO_SUPPLIER, 0.0001, T0).verdict.strikes], ["below_min_send", 0]);
  assert.equal(pay(s, DEMO_SUPPLIER, 0, T0).verdict.code, "zero_amount");
  assert.equal(pay(s, DEMO_SUPPLIER, "lots", T0).verdict.kind, "rejected");
  assert.equal(pay(s, undefined, 1, T0).verdict.kind, "rejected");
  assert.equal(pay(s, DEMO_SUPPLIER, 0, T0).state, s, "a rejection changes nothing");
});

test("the 24 h window rolls: a send older than a day no longer counts against the cap, and old strikes lapse", () => {
  let s = newVault(demoConfig(), 5n * NEAR, T0);
  s = pay(s, DEMO_SUPPLIER, 1, T0).state;
  assert.equal(pay(s, DEMO_SUPPLIER, 0.5, T0 + DAY_MS - 1).verdict.code, "cap_exhausted");
  assert.equal(pay(s, DEMO_SUPPLIER, 0.5, T0 + DAY_MS + 1).verdict.kind, "sent");
  s = pay(s, DEMO_ATTACKER, 1, T0 + 5).state;
  assert.equal(strikesNow(s, T0 + 5), 1);
  assert.equal(strikesNow(s, T0 + 5 + DAY_MS + 1), 0);
  assert.equal(pay(s, DEMO_ATTACKER, 1, T0 + 5 + DAY_MS + 1).verdict.strikes, 1, "the count starts over");
});

test("a payment above the balance is rejected without a strike (simulation only)", () => {
  const s = newVault({ ...demoConfig(), capYocto: 10n * NEAR }, NEAR, T0);
  const r = pay(s, DEMO_SUPPLIER, 2, T0);
  assert.deepEqual([r.verdict.code, r.verdict.strikes], ["insufficient_balance", 0]);
});

test("the worst case is lib/blast.ts on the demo settings: 1 + 10 = 11 NEAR at a 24 h delay (LOSS-BOUND section 1)", () => {
  const b = worstCase(newVault());
  assert.ok(b);
  assert.equal(b.worst, 11n * NEAR);
  assert.equal(b.pendingTimes, 1);
  const drill = worstCase(newVault({ ...demoConfig(), delaySecs: 10 }));
  assert.equal(drill?.worst, 21n * NEAR, "C + 2P under a day");
});
