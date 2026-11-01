// Builds and signs Kizashi `claim` payloads. Format must match contracts/kizashi exactly:
//   message  = "KAIGEN/v1/claim\n<kizashi account>\n<omen id>\n<claimant>"
//   ed25519  = 64-byte signature over the message bytes
//   secp256k1 = 65 bytes r || s || v over sha256(message), v in {0,1}, low-s
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/curves/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";

const enc = new TextEncoder();

export const claimMessage = (kizashi, omenId, claimant) => `KAIGEN/v1/claim\n${kizashi}\n${omenId}\n${claimant}`;

/** Returns the signature bytes (Uint8Array) for `claim`. `secretHex` is the omen's secret key. */
export function signClaim({ curve, secretHex, kizashi, omenId, claimant }) {
  const msg = enc.encode(claimMessage(kizashi, omenId, claimant));
  const secret = hexToBytes(secretHex);
  if (curve === "Ed25519") return ed25519.sign(msg, secret);
  // `prehash: false`: we hash ourselves. `lowS` is the default for noble signing; keep it explicit.
  const sig = secp256k1.sign(sha256(msg), secret, { prehash: false, lowS: true, format: "recovered" });
  // noble's "recovered" format is recovery byte first (v || r || s); the contract wants r || s || v.
  return Uint8Array.from([...sig.slice(1), sig[0]]);
}

/** Base64 for the `claim` JSON argument. */
export const toBase64 = (bytes) => Buffer.from(bytes).toString("base64");
