import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/curves/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { compare, drillOmens, productionOmens } from "./omens.mjs";
import { claimMessage, signClaim } from "./claim.mjs";

test("derivation is deterministic and independent per curve", () => {
  const a = productionOmens();
  const b = productionOmens();
  assert.deepEqual(a, b);
  assert.equal(a[0].public_key.length, 64); // 32 bytes
  assert.equal(a[1].public_key.length, 128); // 64 bytes
  assert.notEqual(a[0].public_key, a[1].public_key);
});

test("pinned production keys: a change here means the seeds or DST changed", () => {
  const [ed, secp] = productionOmens();
  assert.equal(ed.public_key, "48978dd729365cca674d8a038947c1f8f468a0da760a6e559778fcc7839e26d6");
  assert.equal(
    secp.public_key,
    "5e468e65e5756653adc5cf107f4e070c91abfb28dd4ee49e1a3b2e232343c39f30e5b61dd5799f6e1e3868dc56b761b917350dc24bf87d8a0ad72880649ce2b0",
  );
});

test("derived points are valid, in the prime-order subgroup, and not the identity", () => {
  const [ed, secp] = productionOmens();
  const p = ed25519.Point.fromBytes(hexToBytes(ed.public_key));
  assert.ok(p.isTorsionFree() && !p.is0());
  const q = secp256k1.Point.fromBytes(Uint8Array.from([4, ...hexToBytes(secp.public_key)]));
  q.assertValidity();
  assert.ok(!q.is0());
});

test("compare flags a missing or wrong omen", () => {
  const good = productionOmens();
  assert.deepEqual(compare(good), []);
  assert.equal(compare(good.slice(1)).length, 1);
  assert.equal(compare([{ ...good[0], public_key: "00".repeat(32) }, good[1]]).length, 1);
});

test("claim message matches the contract format", () => {
  assert.equal(claimMessage("kizashi.near", "ed25519-omen", "bob.near"), "KAIGEN/v1/claim\nkizashi.near\ned25519-omen\nbob.near");
});

test("drill omens: signed claims verify the way the contract verifies them", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kaigen-")), "drill.json");
  const omens = drillOmens(file);
  assert.deepEqual(drillOmens(file), omens, "second read returns the same keys");
  const keys = JSON.parse(fs.readFileSync(file, "utf8"));
  const args = { kizashi: "k.drill.near", claimant: "keeper.near" };

  const ed = omens[0];
  const edSig = signClaim({ curve: "Ed25519", secretHex: keys["drill-ed25519-omen"], omenId: ed.id, ...args });
  assert.equal(edSig.length, 64);
  assert.ok(ed25519.verify(edSig, new TextEncoder().encode(claimMessage(args.kizashi, ed.id, args.claimant)), hexToBytes(ed.public_key)));

  const sp = omens[1];
  const sig = signClaim({ curve: "Secp256k1", secretHex: keys["drill-secp256k1-omen"], omenId: sp.id, ...args });
  assert.equal(sig.length, 65);
  assert.ok(sig[64] <= 1);
  // Recover the key the way the contract's ecrecover does: sha256(message), r||s, v.
  const hash = sha256(new TextEncoder().encode(claimMessage(args.kizashi, sp.id, args.claimant)));
  const recovered = new secp256k1.Signature(
    BigInt("0x" + Buffer.from(sig.slice(0, 32)).toString("hex")),
    BigInt("0x" + Buffer.from(sig.slice(32, 64)).toString("hex")),
    sig[64],
  ).recoverPublicKey(hash);
  assert.equal(Buffer.from(recovered.toBytes(false).slice(1)).toString("hex"), sp.public_key);
  // Low-s: s <= n/2.
  const s = BigInt("0x" + Buffer.from(sig.slice(32, 64)).toString("hex"));
  assert.ok(s <= secp256k1.Point.Fn.ORDER >> 1n);
});
