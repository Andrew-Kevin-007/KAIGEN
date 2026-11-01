// Where each production omen also holds a bounty. The omen key itself is the owner of these
// addresses, so any outflow from one means the key is broken, even without a `claim`.
import { base58, bech32m } from "@scure/base";

const unhex = (h) => Uint8Array.from(Buffer.from(h, "hex"));

/** ed25519 omen: a NEAR implicit account is the lowercase hex of the public key. */
export const nearImplicit = (ed25519Hex) => ed25519Hex.toLowerCase();

/** ed25519 omen: a Solana address is the base58 of the same 32-byte public key. */
export const solanaAddress = (ed25519Hex) => base58.encode(unhex(ed25519Hex));

/**
 * secp256k1 omen: a Taproot (P2TR) address whose output key is the omen's x-only key, so spending
 * needs a signature from the omen's secret key. `uncompressedXY` is the 64-byte x||y hex.
 */
export function taprootAddress(uncompressedXYHex, hrp = "bc") {
  const xy = unhex(uncompressedXYHex);
  if (xy.length !== 64) throw new Error("expected 64-byte x||y");
  const x = xy.slice(0, 32);
  return bech32m.encode(hrp, [1, ...bech32m.toWords(x)]);
}

/** Inverse of taprootAddress, used by tests and the verifier. Returns the x coordinate as hex. */
export function taprootKey(address) {
  const { prefix, words } = bech32m.decode(address);
  if (words[0] !== 1) throw new Error("not a witness v1 address");
  return { hrp: prefix, x: Buffer.from(bech32m.fromWords(words.slice(1))).toString("hex") };
}
