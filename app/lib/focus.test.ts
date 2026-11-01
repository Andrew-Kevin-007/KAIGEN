import test from "node:test";
import assert from "node:assert/strict";
import { focusPlan } from "./focus.ts";

test("APP-M1: focus goes back to an enabled opener", () => {
  assert.equal(focusPlan({ isConnected: true }), "focus");
  assert.equal(focusPlan({ isConnected: true, disabled: false }), "focus");
});

test("APP-M1: an opener that is disabled when the dialog closes is waited for, not focused into the void", () => {
  // Confirming 'Create and fund' starts the work that disables the 'Run step' button that opened the dialog.
  assert.equal(focusPlan({ isConnected: true, disabled: true }), "wait");
});

test("APP-M1: with no opener, or one that left the page, there is a fallback", () => {
  assert.equal(focusPlan(null), "fallback");
  assert.equal(focusPlan(undefined), "fallback");
  assert.equal(focusPlan({ isConnected: false }), "fallback");
  assert.equal(focusPlan({ isConnected: false, disabled: true }), "fallback");
});
