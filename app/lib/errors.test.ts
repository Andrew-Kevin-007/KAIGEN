import test from "node:test";
import assert from "node:assert/strict";
import { disconnectOutcome, errorText } from "./errors.ts";

test("errorText reads an Error, a string, or an object with a message, and never prints [object Object]", () => {
  assert.equal(errorText(new Error("User closed the window"), "x"), "User closed the window");
  assert.equal(errorText("popup blocked", "x"), "popup blocked");
  assert.equal(errorText({ message: "wallet said no" }, "x"), "wallet said no");
  for (const odd of [undefined, null, 42, {}, { message: 5 }, new Error(""), ""]) {
    assert.equal(errorText(odd, "Could not connect a wallet."), "Could not connect a wallet.", String(odd));
  }
});

test("APP-W2: a disconnect that fails is reported in words and never rejects (Nav fires it with void)", async () => {
  assert.equal(await disconnectOutcome(async () => {}), "", "success says nothing");
  const failed = await disconnectOutcome(async () => {
    throw new Error("popup blocked");
  });
  assert.equal(failed, "Could not disconnect: popup blocked");
  // A wallet that rejects with something that is not an Error still produces a sentence, not a crash.
  assert.match(await disconnectOutcome(() => Promise.reject(undefined)), /^Could not disconnect: .+/);
  // A synchronous throw inside the callback is caught as well.
  assert.match(
    await disconnectOutcome(() => {
      throw new Error("boom");
    }),
    /boom/,
  );
});
