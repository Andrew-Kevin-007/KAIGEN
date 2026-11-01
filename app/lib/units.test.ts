import test from "node:test";
import assert from "node:assert/strict";
import { toUnits } from "./units.ts";

test("converts decimal amounts to the smallest unit exactly", () => {
  assert.equal(toUnits("1.5", 6), "1500000");
  assert.equal(toUnits("1", 6), "1000000");
  assert.equal(toUnits("0.000001", 6), "1");
  assert.equal(toUnits("12", 0), "12");
  assert.equal(toUnits("  2.25 ", 2), "225");
  assert.equal(toUnits("1000000000000000000", 18), "1000000000000000000000000000000000000");
});

test("rejects anything that is not a plain positive amount at the asset's precision", () => {
  for (const bad of ["", "abc", "-1", "1e3", "1.", ".5", "1,5", "0", "0.0", "1.0000001", "1 2", "0x10", "+1"]) {
    assert.equal(toUnits(bad, 6), null, JSON.stringify(bad));
  }
  assert.equal(toUnits("1.5", 0), null, "more decimals than the asset has");
});
