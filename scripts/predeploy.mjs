// KAIGEN pre-deploy checks for a Kizashi init configuration. Kizashi's init arguments are permanent once its
// keys are deleted, so everything that can be checked before the deploy transaction is checked here.
//
//   node predeploy.mjs --init <init.json> --wasm <kizashi.wasm> --drill-keys <drill-public-keys.json> --usdc <token account>
//                      [--rpc <url> --kizashi <account>]
//
// 1. the omens in the init list equal the ones re-derived from the public seeds exactly: no extra, none missing
// 2. no key is listed twice, none is a drill or testnet key (their PUBLIC keys are read from a file; secrets never)
// 3. the USDC token is given, matches the init file, and (with --rpc) Kizashi is registered with it
// 4. the wasm is the Kizashi artifact and exports no `reset` (the drill-only entry point), and its code hash is printed
//
// Every check returns { name, ok, detail }. A check that cannot run fails; only a check the caller did not ask
// for (USDC registration without --rpc) is reported as skipped.
import fs from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { compare, productionOmens } from "./omens.mjs";

const result = (name, ok, detail, extra = {}) => ({ name, ok, detail, ...extra });

// ---- code hash ----------------------------------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  for (; n > 0n; n /= 58n) s = B58[Number(n % 58n)] + s;
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}
/** The hash NEAR reports as an account's `code_hash`. */
export const codeHash = (bytes) => base58(sha256(bytes));

// ---- wasm export section ---------------------------------------------------------------------

function u32(b, pos) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (pos >= b.length) throw new Error("wasm ends inside a number");
    const byte = b[pos++];
    value += (byte & 0x7f) * 2 ** (7 * i);
    if ((byte & 0x80) === 0) return [value, pos];
  }
  throw new Error("wasm number is too long");
}

const KINDS = ["func", "table", "memory", "global", "tag"];

/** The module's exports as `[{ name, kind }]`, read straight from the binary's export section (id 7). */
export function wasmExports(input) {
  const b = Uint8Array.from(input);
  if (b.length < 8 || b[0] !== 0 || b[1] !== 0x61 || b[2] !== 0x73 || b[3] !== 0x6d) throw new Error("not a wasm module (bad magic)");
  if (b[4] !== 1 || b[5] !== 0 || b[6] !== 0 || b[7] !== 0) throw new Error("unsupported wasm version");
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let pos = 8;
  while (pos < b.length) {
    const id = b[pos++];
    let size;
    [size, pos] = u32(b, pos);
    const end = pos + size;
    if (end > b.length) throw new Error("a wasm section runs past the end of the file");
    if (id === 7) {
      let count;
      [count, pos] = u32(b, pos);
      const out = [];
      for (let i = 0; i < count; i++) {
        let len;
        [len, pos] = u32(b, pos);
        if (pos + len >= end) throw new Error("a wasm export runs past its section");
        const name = utf8.decode(b.subarray(pos, pos + len));
        pos += len;
        const kind = b[pos++];
        [, pos] = u32(b, pos);
        out.push({ name, kind: KINDS[kind] ?? `kind ${kind}` });
      }
      if (pos !== end) throw new Error("the wasm export section has trailing bytes");
      return out;
    }
    pos = end;
  }
  return [];
}

/** What a Kizashi build must export to be Kizashi at all. */
export const KIZASHI_EXPORTS = ["new", "claim", "era", "omens", "bounty"];

export function checkWasm(bytes) {
  let names;
  try {
    names = wasmExports(bytes).map((e) => e.name);
  } catch (e) {
    const detail = `could not check: ${e.message}`;
    return [result("wasm exports no reset", false, detail), result("wasm is the Kizashi contract", false, detail)];
  }
  const missing = KIZASHI_EXPORTS.filter((n) => !names.includes(n));
  return [
    result("wasm exports no reset", !names.includes("reset"), names.includes("reset") ? "exports `reset`: this is a drill build" : `${names.length} exports, none is reset`),
    result("wasm is the Kizashi contract", missing.length === 0, missing.length ? `missing exports: ${missing.join(", ")}` : `exports ${KIZASHI_EXPORTS.join(", ")}`),
    result("wasm code hash", true, codeHash(bytes)),
  ];
}

// ---- init configuration ------------------------------------------------------------------------

const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const isAccountId = (s) => typeof s === "string" && s.length >= 2 && s.length <= 64 && ACCOUNT_ID.test(s);

/** Public keys (lowercase hex) from a file that lists drill or testnet omens. A map of ids to values is refused: that is what a secrets file looks like. */
export function loadDrillKeys(file) {
  let v;
  try {
    v = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${file}: ${e.code ?? "not valid JSON"}`);
  }
  const list = Array.isArray(v) ? v : Array.isArray(v?.omens) ? v.omens : null;
  if (!list) throw new Error(`${file} is not a list of public keys; pass the public output of \`omens.mjs drill\`, never a secrets file`);
  return list.map((e) => {
    const key = typeof e === "string" ? e : e?.public_key;
    if (typeof key !== "string" || !/^[0-9a-f]+$/i.test(key)) throw new Error(`${file} has an entry that is not a hex public key`);
    return key.toLowerCase();
  });
}

/** Checks 1 to 3 that need no network. `init` is what will be passed to `new`: { omens, usdc }. */
export function checkInit({ init, drillKeys, usdc }) {
  const out = [];
  const omens = Array.isArray(init?.omens) ? init.omens : null;
  const shape = [];
  if (!omens) shape.push("init has no omens list");
  const unknown = Object.keys(init ?? {}).filter((k) => k !== "omens" && k !== "usdc");
  if (unknown.length) shape.push(`unknown field(s) ${unknown.join(", ")}`);
  if (!init || !("usdc" in init)) shape.push('init has no "usdc" field (a missing field would silently mean no USDC bounty)');
  out.push(result("init has exactly the fields omens and usdc", shape.length === 0, shape.join("; ") || "ok"));
  if (!omens) return out;

  // 1. exactly the derived set.
  const want = productionOmens();
  const problems = compare(omens);
  const wantIds = new Set(want.map((o) => o.id));
  const extra = omens.filter((o) => !wantIds.has(o.id)).map((o) => o.id);
  if (extra.length) problems.push(`unexpected omen(s) not derived from the public seeds: ${extra.join(", ")}`);
  if (new Set(omens.map((o) => o.id)).size !== omens.length) problems.push("an omen id is listed twice");
  if (omens.length !== want.length) problems.push(`${omens.length} omens listed, ${want.length} derived`);
  out.push(result("omens equal the ones re-derived from the public seeds", problems.length === 0, problems.join("; ") || `${omens.length} omens match`));

  // 2. no repeats, nothing from a drill.
  const keys = omens.map((o) => String(o.public_key).toLowerCase());
  out.push(result("no key is listed twice", new Set(keys).size === keys.length, new Set(keys).size === keys.length ? "ok" : "the same public key appears under more than one omen"));
  const drill = new Set(drillKeys ?? []);
  const hit = omens.filter((o, i) => drill.has(keys[i]) || /drill|test/i.test(o.id)).map((o) => o.id);
  out.push(
    drillKeys === undefined
      ? result("no drill or testnet key", false, "could not check: no list of drill public keys given")
      : result("no drill or testnet key", hit.length === 0, hit.length ? `drill or testnet omen(s): ${hit.join(", ")}` : `checked against ${drill.size} known public key(s)`),
  );

  // 3. the token.
  const bad = [];
  if (!usdc) bad.push("no USDC token id given (--usdc)");
  else if (!isAccountId(usdc)) bad.push(`${usdc} is not a valid account id`);
  if (typeof init.usdc !== "string") bad.push("init.usdc is not set");
  else if (usdc && init.usdc !== usdc) bad.push(`init.usdc is ${init.usdc}, the token given is ${usdc}`);
  out.push(result("USDC token id is given and matches the init file", bad.length === 0, bad.join("; ") || usdc));
  return out;
}

/** Kizashi must be registered with the token or its USDC payout can never land. Read-only. */
export async function checkUsdcRegistration({ rpc, usdc, kizashi }) {
  const name = "Kizashi is registered with the USDC token";
  try {
    const balance = await rpc.view(usdc, "storage_balance_of", { account_id: kizashi });
    return balance ? result(name, true, `${kizashi} has a storage deposit on ${usdc}`) : result(name, false, `${kizashi} is not registered on ${usdc} (storage_balance_of is null)`);
  } catch (e) {
    return result(name, false, `could not check: ${e.message ?? e}`);
  }
}

/** All checks. `rpc` and `kizashi` together switch on the registration check. */
export async function predeploy({ init, drillKeys, usdc, wasm, rpc, kizashi }) {
  const out = [...checkInit({ init, drillKeys, usdc }), ...checkWasm(wasm)];
  if (rpc && kizashi && usdc) out.push(await checkUsdcRegistration({ rpc, usdc, kizashi }));
  else out.push(result("Kizashi is registered with the USDC token", true, "NOT CHECKED: pass --rpc and --kizashi to check it", { skipped: true }));
  return out;
}

export function report(results) {
  const lines = results.map((r) => `${r.skipped ? "SKIP" : r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
  const failed = results.filter((r) => !r.ok).length;
  lines.push("", failed === 0 ? `All ${results.filter((r) => !r.skipped).length} checks passed.` : `${failed} of ${results.length} checks FAILED.`);
  return { text: lines.join("\n"), ok: failed === 0 };
}

// ---- CLI ---------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[argv[i].slice(2)] = true;
    else out[argv[i].slice(2)] = argv[++i];
  }
  return out;
}

async function main(argv) {
  const a = parseArgs(argv);
  if (typeof a.init !== "string" || typeof a.wasm !== "string" || typeof a["drill-keys"] !== "string" || typeof a.usdc !== "string" || (a.rpc && typeof a.kizashi !== "string")) {
    console.error("usage: node predeploy.mjs --init <init.json> --wasm <kizashi.wasm> --drill-keys <drill-public-keys.json> --usdc <token account> [--rpc <url> --kizashi <account>]");
    return 2;
  }
  try {
    const rpc = typeof a.rpc === "string" ? (await import("../jobs/src/rpc.mjs")).makeRpc(a.rpc) : undefined;
    const results = await predeploy({
      init: JSON.parse(fs.readFileSync(a.init, "utf8")),
      drillKeys: loadDrillKeys(a["drill-keys"]),
      usdc: a.usdc,
      wasm: fs.readFileSync(a.wasm),
      rpc,
      kizashi: a.kizashi,
    });
    const { text, ok } = report(results);
    console.log(text);
    return ok ? 0 : 1;
  } catch (e) {
    console.error(`predeploy could not run: ${e.code ?? e.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop())) {
  process.exitCode = await main(process.argv.slice(2));
}
