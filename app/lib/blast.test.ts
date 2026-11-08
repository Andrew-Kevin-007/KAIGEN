import test from "node:test";
import assert from "node:assert/strict";
import { blastFormula, blastRadius } from "./blast.ts";

const DAY = 86_400;

test("LOSS-BOUND 1: the documented tight example, C = 1000 and P = 3000 with a 24 h delay, is 4000", () => {
  const b = blastRadius({ cap: "1000", pending: "3000", delaySecs: DAY });
  assert.ok(b);
  assert.equal(b.worst, 4000n);
  assert.equal(b.pendingTimes, 1);
  assert.equal(blastFormula(b, String), "1000 + 3000 = 4000");
});

test("LOSS-BOUND 1: a delay under 24 h lets two pending limits through (the documented 1 h case: 1000 + 2 x 3000 = 7000)", () => {
  const b = blastRadius({ cap: "1000", pending: "3000", delaySecs: 3600 });
  assert.ok(b);
  assert.equal(b.worst, 7000n);
  assert.equal(b.pendingTimes, 2);
  assert.equal(blastFormula(b, String), "1000 + 2 x 3000 = 7000");
});

test("the delay boundary is exactly 24 h: one second less is the drill case", () => {
  assert.equal(blastRadius({ cap: "1", pending: "1", delaySecs: DAY })?.worst, 2n);
  assert.equal(blastRadius({ cap: "1", pending: "1", delaySecs: DAY - 1 })?.worst, 3n);
});

test("yocto-sized amounts keep every digit (no float)", () => {
  const cap = "5000000000000000000000000";
  const pending = "50000000000000000000000000";
  assert.equal(blastRadius({ cap, pending, delaySecs: DAY * 2 })?.worst, 55000000000000000000000000n);
});

test("a zero cap or zero pending limit is a real answer, not a missing one", () => {
  assert.equal(blastRadius({ cap: "0", pending: "0", delaySecs: DAY })?.worst, 0n);
});

test("any missing or malformed input shows nothing instead of a guess", () => {
  const ok = { cap: "1000", pending: "3000", delaySecs: DAY };
  assert.equal(blastRadius({ ...ok, cap: undefined }), null);
  assert.equal(blastRadius({ ...ok, pending: null }), null);
  assert.equal(blastRadius({ ...ok, pending: "-5" }), null);
  assert.equal(blastRadius({ ...ok, cap: "1e3" }), null);
  assert.equal(blastRadius({ ...ok, cap: 1000 }), null);
  assert.equal(blastRadius({ ...ok, delaySecs: undefined }), null);
  assert.equal(blastRadius({ ...ok, delaySecs: Number.NaN }), null);
  assert.equal(blastRadius({ ...ok, delaySecs: -1 }), null);
});
