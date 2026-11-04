// Read-only mainnet reads for gate G4 and the mainnet rule of docs/v3/ROADMAP.md section 3.
//
//   node jobs/src/mainnet-reads.mjs [--rpc <url> ...] [--json]
//
//   (a) `status` on each RPC host: protocol version, node version, and what the RPC can and cannot say about ML-DSA
//   (b) `view_code` of intents.near: the wasm export section, compared with the intents.near methods KAIGEN calls
//
// Only these requests are ever sent, enforced below: `status`, `EXPERIMENTAL_protocol_config`, and `query` with
// request_type view_code or view_access_key. No key is read, nothing is signed, nothing is sent to a chain. The
// requests carry a generic client name and nothing about whoever runs this.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { codeHash, wasmExports } from "../../scripts/predeploy.mjs";
import { makeRpc, RpcError } from "./rpc.mjs";

export const CLIENT_NAME = "kaigen-readonly-check/1.0";
export const MAINNET_HOSTS = ["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org"];
export const INTENTS = "intents.near";
const ML_DSA_65_PUBLIC_KEY_BYTES = 1952;
const QUERY_KINDS = new Set(["view_code", "view_access_key"]);
const READ_METHODS = new Set(["status", "EXPERIMENTAL_protocol_config"]);

/** True only for the requests this tool is allowed to send. */
export function isReadOnlyRequest(body) {
  const req = typeof body === "string" ? JSON.parse(body) : body;
  if (READ_METHODS.has(req.method)) return true;
  return req.method === "query" && QUERY_KINDS.has(req.params?.request_type);
}

/** A `makeRpc` client that refuses any request outside the allowlist and names itself generically. */
export function readOnlyRpc(url, { fetchImpl = fetch, retries = 2 } = {}) {
  const guarded = (target, init) => {
    // An RpcError that is not TRANSIENT, so the client does not retry a refusal.
    if (!isReadOnlyRequest(init.body)) throw new RpcError(`refused: ${JSON.parse(init.body).method} is not one of the read-only requests this tool sends`, { kind: "REFUSED" });
    return fetchImpl(target, { ...init, headers: { ...init.headers, "user-agent": CLIENT_NAME } });
  };
  return makeRpc(url, { fetchImpl: guarded, retries });
}

const message = (e) => String(e?.message ?? e).slice(0, 240);

// ---- (a) status, protocol config, key parsing ----------------------------------------------------------

/** The fields of `status` that matter here. The node's own keys and its validator list are left out on purpose. */
export function pickStatus(s) {
  return {
    chain_id: s.chain_id,
    protocol_version: s.protocol_version,
    latest_protocol_version: s.latest_protocol_version,
    node_version: s.version?.version,
    node_build: s.version?.build,
    node_commit: s.version?.commit,
    rustc_version: s.version?.rustc_version,
    block_height: s.sync_info?.latest_block_height,
    block_time: s.sync_info?.latest_block_time,
    syncing: s.sync_info?.syncing,
  };
}

/** Every key in the protocol config whose name mentions ML-DSA, with its value. */
export function findMlDsa(config) {
  const hits = [];
  (function walk(o, p) {
    if (o && typeof o === "object") {
      for (const [k, v] of Object.entries(o)) {
        const here = p ? `${p}.${k}` : k;
        if (/ml.?dsa|dilithium/i.test(k)) hits.push({ path: here, value: typeof v === "object" ? JSON.stringify(v) : v });
        walk(v, here);
      }
    }
  })(config, "");
  return hits;
}

/** A well-formed ML-DSA-65 public key nobody holds (same construction as mainnet.mjs): a fixed phrase's hash, repeated. */
export function probeKey(prefix = "ml-dsa-65") {
  const seed = sha256(Buffer.from("kaigen/ml-dsa-probe"));
  return `${prefix}:${base58.encode(Uint8Array.from({ length: ML_DSA_65_PUBLIC_KEY_BYTES }, (_, i) => seed[i % seed.length]))}`;
}

/**
 * Asks about an access key of the account `near` that does not exist. "Does not exist" means the node parsed the key type;
 * any other answer means it did not. A control with an invented key type shows the two answers can be told apart.
 */
export async function probeKeyParsing(rpc) {
  const ask = async (publicKey) => {
    try {
      await rpc.call("query", { request_type: "view_access_key", finality: "final", account_id: "near", public_key: publicKey });
      return { parsed: true, answer: "the node returned a key" };
    } catch (e) {
      // The 2.6 kB probe key is left out of the answer; the rest of the node's words are kept as they came.
      const answer = String(e?.message ?? e).replace(/(ml-dsa-65|kaigen-not-a-key-type):[1-9A-HJ-NP-Za-km-z]{100,}/g, "$1:<probe key>").slice(0, 240);
      if (e.kind === "UNKNOWN_ACCESS_KEY" || /access key .*does not exist/i.test(String(e?.message ?? e))) return { parsed: true, answer };
      return { parsed: false, answer };
    }
  };
  return { ml_dsa_65: await ask(probeKey("ml-dsa-65")), control_unknown_type: await ask(probeKey("kaigen-not-a-key-type")) };
}

export async function readProtocol(rpc) {
  const [status, config] = await Promise.all([rpc.status(), rpc.call("EXPERIMENTAL_protocol_config", { finality: "final" })]);
  const wasm = config.runtime_config?.wasm_config ?? {};
  return {
    status: pickStatus(status),
    config_protocol_version: config.protocol_version,
    ml_dsa_entries: findMlDsa(config),
    // A control: the same table does list the ed25519 host function, so an empty ML-DSA list would not mean "table missing".
    control_ed25519_verify_base: wasm.ext_costs?.ed25519_verify_base,
    ext_costs_entries: Object.keys(wasm.ext_costs ?? {}).length,
    key_parsing: await probeKeyParsing(rpc),
  };
}

// ---- (b) intents.near ------------------------------------------------------------------------------------

/** The exported function names of one account's code, as `view_code` returns it, plus enough to check the answer is whole. */
export async function readCode(rpc, account) {
  const r = await rpc.call("query", { request_type: "view_code", finality: "final", account_id: account });
  const wasm = Buffer.from(r.code_base64, "base64");
  const computed = codeHash(wasm);
  return {
    account,
    block_height: r.block_height,
    block_hash: r.block_hash,
    code_hash: r.hash,
    bytes: wasm.length,
    // The node's hash against the one we compute from the bytes we received: a truncated or altered download would not match.
    hash_matches_bytes: computed === r.hash,
    exports: wasmExports(wasm),
  };
}

/** The intents.near methods Mamori calls, read from its source so this list cannot drift from the code. */
export function kaigenIntentsDependencies(source, file = "contracts/mamori/src/lib.rs") {
  const out = [];
  source.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(/intents_call\(\s*"([a-z_][a-z0-9_]*)"/g)) out.push({ method: m[1], where: `${file}:${i + 1}` });
  });
  return out;
}

/** One row per dependency: is a function of that exact name exported? (Names only: the export section has no signatures.) */
export function compareExports(dependencies, exports) {
  const funcs = new Map(exports.filter((e) => e.kind === "func").map((e) => [e.name, e]));
  const methods = [...new Set(dependencies.map((d) => d.method))];
  return methods.map((method) => ({
    method,
    where: dependencies.filter((d) => d.method === method).map((d) => d.where),
    exported: funcs.has(method),
    other_kind: !funcs.has(method) && exports.some((e) => e.name === method) ? exports.find((e) => e.name === method).kind : undefined,
  }));
}

// ---- the run ---------------------------------------------------------------------------------------------

export async function runMainnetReads({ hosts = MAINNET_HOSTS, root, fetchImpl = fetch, now = () => new Date() } = {}) {
  const lib = fs.readFileSync(path.join(root, "contracts", "mamori", "src", "lib.rs"), "utf8");
  const dependencies = kaigenIntentsDependencies(lib);
  const perHost = [];
  for (const url of hosts) {
    const rpc = readOnlyRpc(url, { fetchImpl });
    const row = { rpc: url, fetched_at: now().toISOString() };
    try {
      row.protocol = await readProtocol(rpc);
    } catch (e) {
      row.protocol_error = message(e);
    }
    try {
      row.code = await readCode(rpc, INTENTS);
      row.comparison = compareExports(dependencies, row.code.exports);
    } catch (e) {
      row.code_error = message(e);
    }
    perHost.push(row);
  }
  return { client: CLIENT_NAME, dependencies, hosts: perHost };
}

export function renderMarkdown(result) {
  const lines = [];
  const code = (s) => `\`${s}\``;
  for (const h of result.hosts) {
    lines.push(`### ${h.rpc}`, "", `Fetched ${h.fetched_at} (UTC, this machine's clock).`, "");
    if (h.protocol_error) lines.push(`Protocol reads failed: ${h.protocol_error}`, "");
    if (h.protocol) {
      const s = h.protocol.status;
      lines.push(
        "| `status` field | value |",
        "|---|---|",
        `| chain_id | ${s.chain_id} |`,
        `| protocol_version | ${s.protocol_version} |`,
        `| latest_protocol_version (highest this node binary supports) | ${s.latest_protocol_version} |`,
        `| node version / build | ${s.node_version} / ${s.node_build} |`,
        `| node commit | ${s.node_commit} |`,
        `| rustc the node was built with | ${s.rustc_version} |`,
        `| latest block | ${s.block_height} at ${s.block_time} |`,
        "",
        `ML-DSA entries in ${code("EXPERIMENTAL_protocol_config")} (finality final, protocol ${h.protocol.config_protocol_version}; the table has ${h.protocol.ext_costs_entries} host-function costs, and ${code("ed25519_verify_base")} is ${h.protocol.control_ed25519_verify_base}):`,
        "",
        ...h.protocol.ml_dsa_entries.map((e) => `- ${code(e.path)} = ${e.value}`),
        "",
        `Key parsing, ${code("view_access_key")} on account ${code("near")} with a key nobody holds:`,
        "",
        `- ${code("ml-dsa-65:")} key of 1952 bytes: ${h.protocol.key_parsing.ml_dsa_65.parsed ? "PARSED" : "NOT parsed"}. Node said: ${h.protocol.key_parsing.ml_dsa_65.answer}`,
        `- control, invented key type: ${h.protocol.key_parsing.control_unknown_type.parsed ? "parsed (the control did not discriminate)" : "rejected"}. Node said: ${h.protocol.key_parsing.control_unknown_type.answer}`,
        "",
      );
    }
    if (h.code_error) lines.push(`${code(INTENTS)} code read failed: ${h.code_error}`, "");
    if (h.code) {
      const c = h.code;
      lines.push(
        `${code(INTENTS)} via ${code("view_code")}: code hash ${code(c.code_hash)}, ${c.bytes.toLocaleString("en-US")} bytes, read at block ${c.block_height} (${c.block_hash}). Hash recomputed from the received bytes ${c.hash_matches_bytes ? "matches" : "DOES NOT MATCH"}.`,
        "",
        `Exported functions (${c.exports.filter((e) => e.kind === "func").length}): ${c.exports.filter((e) => e.kind === "func").map((e) => code(e.name)).join(", ")}`,
        "",
        "| method KAIGEN calls | where | exported by intents.near |",
        "|---|---|---|",
        ...h.comparison.map((r) => `| ${code(r.method)} | ${r.where.join(", ")} | ${r.exported ? "yes" : `NO${r.other_kind ? ` (exported as ${r.other_kind})` : ""}`} |`),
        "",
      );
    }
  }
  return lines.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const hosts = args.flatMap((a, i) => (a === "--rpc" ? [args[i + 1]] : []));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const result = await runMainnetReads({ hosts: hosts.length ? hosts : MAINNET_HOSTS, root });
  console.log(args.includes("--json") ? JSON.stringify(result, null, 2) : renderMarkdown(result));
}
