import test from "node:test";
import assert from "node:assert/strict";
import type { KeyRow } from "./cage.ts";
import { plainFindings } from "./xray-says.ts";

const classical: KeyRow = { kind: "full", key: "ed25519:Abc", curve: "classical" };
const pq: KeyRow = { kind: "full", key: "ml-dsa-65-hash:Abc", curve: "post-quantum" };

test("a classical full-access key is described as total control, without claiming who holds it", () => {
  const s = plainFindings([classical], false).join(" ");
  assert.match(s, /Whoever holds it can take everything/);
  assert.doesNotMatch(s, /\b(unsafe|insecure|vulnerable|compromised)\b/);
});

test("a non-Mamori account is told it was not graded as a vault; a Mamori one is not", () => {
  assert.match(plainFindings([pq], false).join(" "), /does not answer as a Mamori vault/);
  assert.doesNotMatch(plainFindings([pq], true).join(" "), /does not answer as a Mamori vault/);
});

test("no keys is said plainly", () => {
  assert.match(plainFindings([], true).join(" "), /no access keys/);
});
