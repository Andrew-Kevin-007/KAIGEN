import test from "node:test";
import assert from "node:assert/strict";
import { describedBy } from "./aria.ts";

test("describedBy lists only the ids that are on the page, and is undefined when none are", () => {
  assert.equal(describedBy(), undefined);
  assert.equal(describedBy(false, null, undefined, ""), undefined);
  assert.equal(describedBy("hint"), "hint");
  assert.equal(describedBy("hint", false), "hint");
  assert.equal(describedBy("hint", true && "amount-error"), "hint amount-error");
  const showError = false;
  assert.equal(describedBy("hint", showError && "amount-error"), "hint", "an id for an element that is not rendered would point at nothing");
});
