import test from "node:test";
import assert from "node:assert/strict";
import { MIN_PASSPHRASE, checkPassphrase, estimateBits } from "./passphrase.ts";

test("APP-3: the 12 character minimum stays", () => {
  assert.equal(MIN_PASSPHRASE, 12);
  const r = checkPassphrase("Xk9#mPq2$vL");
  assert.equal(r.ok, false);
  assert.match(r.message, /at least 12/);
});

test("APP-3: very common passphrases are refused, including simple disguises", () => {
  for (const p of ["password1234", "Password123456", "qwertyuiop12", "iloveyou2024!", "p@ssw0rd!!!!!", "correcthorsebatterystaple", "kaigenkaigen"]) {
    const r = checkPassphrase(p);
    assert.equal(r.ok, false, p);
  }
  assert.match(checkPassphrase("password1234").message, /too common/);
});

test("APP-3: repeats and runs are refused", () => {
  for (const p of ["aaaaaaaaaaaa", "abababababab", "abcdefghijkl", "123456789012", "            "]) {
    const r = checkPassphrase(p);
    assert.equal(r.ok, false, JSON.stringify(p));
  }
  assert.match(checkPassphrase("aaaaaaaaaaaa").message, /repeat or sequence/);
});

test("APP-3: too few different characters is refused by the entropy estimate", () => {
  const r = checkPassphrase("aabbccddeeff");
  assert.equal(r.ok, false);
  assert.match(r.message, /different characters/);
  assert.ok(estimateBits("aaaaaaaaaaaa") < 20);
  assert.ok(estimateBits("Xk9#mPq2$vLw") > 60);
});

test("APP-3: ordinary strong passphrases pass", () => {
  for (const p of ["violet lantern cobalt seven", "ocean-pepper-lamp-turtle-91", "Xk9#mPq2$vLw", "my dragon ate the purple moon"]) {
    const r = checkPassphrase(p);
    assert.equal(r.ok, true, `${p}: ${r.message}`);
  }
});
