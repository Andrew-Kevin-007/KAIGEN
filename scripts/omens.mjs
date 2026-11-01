// KAIGEN omen derivation. Anyone can rerun this and compare the output with `kizashi.omens()`.
//
// A production omen is a public key nobody holds: hash a published seed to a curve point with
// RFC 9380 hash_to_curve. Nobody learns the discrete log of that point, so a valid signature under
// it proves the curve's discrete log problem was broken.
//
//   node omens.mjs derive              print production omens as Kizashi init JSON
//   node omens.mjs check <file|url>    compare derived keys with a saved `omens()` view
//   node omens.mjs drill <secrets.json> create (or read) our own drill omen keys, print init JSON
import fs from "node:fs";
import { ed25519, ed25519_hasher } from "@noble/curves/ed25519.js";
import { secp256k1, secp256k1_hasher } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/curves/utils.js";

export const OMEN_SEEDS = [
  { id: "ed25519-omen", curve: "Ed25519", level: "Kaigen", seed: "KAIGEN/v1/omen/ed25519" },
  { id: "secp256k1-omen", curve: "Secp256k1", level: "Kaigen", seed: "KAIGEN/v1/omen/secp256k1" },
];
const DST = (curve) => `KAIGEN-V1-OMEN-${curve.toUpperCase()}_RO_`;

const enc = new TextEncoder();

/** Production omen public key (hex) from its seed. ed25519: 32 B compressed; secp256k1: 64 B x||y. */
export function deriveOmen({ curve, seed }) {
  const opts = { DST: DST(curve) };
  if (curve === "Ed25519") {
    return bytesToHex(ed25519_hasher.hashToCurve(enc.encode(seed), opts).toBytes());
  }
  return bytesToHex(secp256k1_hasher.hashToCurve(enc.encode(seed), opts).toBytes(false).slice(1));
}

export const productionOmens = () =>
  OMEN_SEEDS.map((o) => ({ id: o.id, curve: o.curve, level: o.level, public_key: deriveOmen(o) }));

/** Drill omens are ours: random secret keys, so the weekly fire test can sign a real claim. */
export function drillOmens(secretsPath) {
  let keys;
  if (fs.existsSync(secretsPath)) {
    keys = JSON.parse(fs.readFileSync(secretsPath, "utf8"));
  } else {
    keys = {
      "drill-ed25519-omen": bytesToHex(ed25519.utils.randomSecretKey()),
      "drill-secp256k1-omen": bytesToHex(secp256k1.utils.randomSecretKey()),
    };
    fs.writeFileSync(secretsPath, JSON.stringify(keys, null, 2), { mode: 0o600 });
  }
  return [
    {
      id: "drill-ed25519-omen",
      curve: "Ed25519",
      level: "Kaigen",
      public_key: bytesToHex(ed25519.getPublicKey(hexToBytes(keys["drill-ed25519-omen"]))),
    },
    {
      id: "drill-secp256k1-omen",
      curve: "Secp256k1",
      level: "Kaigen",
      public_key: bytesToHex(secp256k1.getPublicKey(hexToBytes(keys["drill-secp256k1-omen"]), false).slice(1)),
    },
  ];
}

/** Compare derived production omens with an `omens()` view. Returns a list of problems. */
export function compare(view) {
  const problems = [];
  for (const want of productionOmens()) {
    const got = view.find((o) => o.id === want.id);
    if (!got) problems.push(`${want.id}: missing on chain`);
    else if (got.public_key !== want.public_key) problems.push(`${want.id}: key mismatch (chain ${got.public_key})`);
    // Right key bytes on the wrong curve could never verify a claim; the wrong level would raise the wrong era.
    else if (got.curve !== want.curve) problems.push(`${want.id}: curve ${got.curve}, expected ${want.curve}`);
    else if (got.level !== want.level) problems.push(`${want.id}: level ${got.level}, expected ${want.level}`);
  }
  return problems;
}

const [cmd, arg] = process.argv.slice(2);
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop())) {
  if (cmd === "derive") {
    console.log(JSON.stringify({ seeds: OMEN_SEEDS.map(({ id, seed }) => ({ id, seed, dst: DST(OMEN_SEEDS.find((o) => o.id === id).curve) })), omens: productionOmens() }, null, 2));
  } else if (cmd === "check" && arg) {
    const view = JSON.parse(fs.readFileSync(arg, "utf8"));
    const problems = compare(view);
    console.log(problems.length ? problems.join("\n") : "OK: every omen matches its derivation");
    process.exit(problems.length ? 1 : 0);
  } else if (cmd === "drill" && arg) {
    console.log(JSON.stringify(drillOmens(arg), null, 2));
  } else {
    console.error("usage: node omens.mjs derive | check <omens.json> | drill <secrets.json>");
    process.exit(2);
  }
}
