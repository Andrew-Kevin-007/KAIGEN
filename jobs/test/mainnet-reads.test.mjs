import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codeHash } from "../../scripts/predeploy.mjs";
import {
  CLIENT_NAME,
  compareExports,
  findMlDsa,
  isReadOnlyRequest,
  kaigenIntentsDependencies,
  pickStatus,
  probeKey,
  probeKeyParsing,
  readCode,
  readOnlyRpc,
  renderMarkdown,
  runMainnetReads,
} from "../src/mainnet-reads.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A valid wasm module that exports the given function names (same fixture as scripts/predeploy.test.mjs). */
function wasmWith(names) {
  const bytes = (s) => [...Buffer.from(s)];
  const n = names.length;
  const exportBody = [n, ...names.flatMap((name, i) => [name.length, ...bytes(name), 0, i])];
  const section = (id, body) => [id, body.length, ...body];
  return Buffer.from([
    0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...section(1, [1, 0x60, 0, 0]),
    ...section(3, [n, ...names.map(() => 0)]),
    ...section(7, exportBody),
    ...section(10, [n, ...names.flatMap(() => [2, 0, 0x0b])]),
  ]);
}

const STATUS = {
  chain_id: "mainnet",
  protocol_version: 86,
  latest_protocol_version: 88,
  version: { version: "2.14.0", build: "2.14.0", commit: "abc", rustc_version: "1.95.0" },
  sync_info: { latest_block_height: 100, latest_block_time: "2026-11-04T00:00:00Z", syncing: false },
  node_key: "ed25519:SHOULD-NOT-BE-KEPT",
  validators: [{ account_id: "v.near" }],
};
const CONFIG = {
  protocol_version: 86,
  runtime_config: {
    transaction_costs: { ml_dsa_65_verification_cost: 100000000000 },
    wasm_config: { ml_dsa_verify_host_fn: false, ext_costs: { ed25519_verify_base: 210000000000, ml_dsa_verify_base: 540000000000 } },
  },
};

/** A fetch that answers like a NEAR RPC node and records every request body. `methods` is the contract's exported function list. */
function fakeNode({ methods, hash, keyOk = true }) {
  const wasm = wasmWith(methods);
  const seen = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ body, headers: init.headers });
    const reply = (result) => ({ status: 200, json: async () => ({ jsonrpc: "2.0", id: body.id, result }) });
    if (body.method === "status") return reply(STATUS);
    if (body.method === "EXPERIMENTAL_protocol_config") return reply(CONFIG);
    if (body.method === "query" && body.params.request_type === "view_access_key") {
      return body.params.public_key.startsWith("ml-dsa-65:") && keyOk
        ? reply({ error: `access key ${body.params.public_key} does not exist while viewing` })
        : { status: 200, json: async () => ({ jsonrpc: "2.0", id: body.id, error: { name: "REQUEST_VALIDATION_ERROR", cause: { name: "PARSE_ERROR" }, message: "Parse error", data: "Failed parsing args: unknown key type" } }) };
    }
    if (body.method === "query" && body.params.request_type === "view_code") {
      return reply({ block_height: 7, block_hash: "BLOCKHASH", hash: hash ?? codeHash(wasm), code_base64: wasm.toString("base64") });
    }
    throw new Error(`the fake node was asked for ${body.method}, which this tool must not send`);
  };
  return { fetchImpl, seen };
}

// ---- only reads, and a generic name ------------------------------------------------------------------

test("only the read-only requests are allowed; sending a transaction or any other query is refused", () => {
  assert.equal(isReadOnlyRequest({ method: "status" }), true);
  assert.equal(isReadOnlyRequest({ method: "EXPERIMENTAL_protocol_config", params: { finality: "final" } }), true);
  assert.equal(isReadOnlyRequest({ method: "query", params: { request_type: "view_code" } }), true);
  assert.equal(isReadOnlyRequest({ method: "query", params: { request_type: "view_access_key" } }), true);
  for (const bad of [
    { method: "send_tx", params: {} },
    { method: "broadcast_tx_commit", params: [] },
    { method: "query", params: { request_type: "call_function" } },
    { method: "query", params: {} },
    { method: "block", params: {} },
  ]) assert.equal(isReadOnlyRequest(bad), false, bad.method);
});

test("readOnlyRpc names itself generically, sends no email address, and cannot be made to send a transaction", async () => {
  const node = fakeNode({ methods: ["new"] });
  const rpc = readOnlyRpc("https://example.test", { fetchImpl: node.fetchImpl });
  await rpc.status();
  assert.equal(node.seen[0].headers["user-agent"], CLIENT_NAME);
  assert.ok(!/@|mailto|kevin|kavita/i.test(JSON.stringify(node.seen)), "no personal detail in what was sent");
  await assert.rejects(() => rpc.call("send_tx", { signed_tx_base64: "AAAA" }), /refused: send_tx is not one of the read-only requests/);
  assert.equal(node.seen.length, 1, "the refused request never reached the network");
});

// ---- (a) status, protocol config, key parsing --------------------------------------------------------

test("pickStatus keeps the versions and the block, and drops the node's keys and validator list", () => {
  const s = pickStatus(STATUS);
  assert.deepEqual([s.chain_id, s.protocol_version, s.latest_protocol_version, s.node_version, s.block_height], ["mainnet", 86, 88, "2.14.0", 100]);
  assert.ok(!JSON.stringify(s).includes("SHOULD-NOT-BE-KEPT") && !("validators" in s));
});

test("findMlDsa lists every ML-DSA entry of the protocol config with its path, and nothing else", () => {
  assert.deepEqual(findMlDsa(CONFIG), [
    { path: "runtime_config.transaction_costs.ml_dsa_65_verification_cost", value: 100000000000 },
    { path: "runtime_config.wasm_config.ml_dsa_verify_host_fn", value: false },
    { path: "runtime_config.wasm_config.ext_costs.ml_dsa_verify_base", value: 540000000000 },
  ]);
  assert.deepEqual(findMlDsa({ runtime_config: { wasm_config: { ext_costs: { ed25519_verify_base: 1 } } } }), []);
});

test("probeKey is a 1952-byte ml-dsa-65 key under the prefix asked for", async () => {
  const { base58 } = await import("@scure/base");
  const key = probeKey();
  assert.ok(key.startsWith("ml-dsa-65:"));
  assert.equal(base58.decode(key.slice("ml-dsa-65:".length)).length, 1952);
  assert.ok(probeKey("other").startsWith("other:"));
});

test("key parsing: 'does not exist' means the type parsed, anything else means it did not, and the control shows both can happen", async () => {
  const rpc = readOnlyRpc("https://example.test", { fetchImpl: fakeNode({ methods: ["new"] }).fetchImpl });
  const r = await probeKeyParsing(rpc);
  assert.equal(r.ml_dsa_65.parsed, true);
  assert.equal(r.control_unknown_type.parsed, false);
  assert.match(r.control_unknown_type.answer, /unknown key type/);
  const refusing = readOnlyRpc("https://example.test", { fetchImpl: fakeNode({ methods: ["new"], keyOk: false }).fetchImpl });
  assert.equal((await probeKeyParsing(refusing)).ml_dsa_65.parsed, false, "a node that does not know the type is reported as not parsing it");
});

// ---- (b) intents.near ----------------------------------------------------------------------------------

test("dependencies are read from Mamori's source: the intents.near methods it calls, with the line", () => {
  const src = ["fn a() {", '    intents_call("add_public_key", &k)', "}", "fn b() {", '    let _ = intents_call("remove_public_key", &k).then(x);', "}", '// intents_call("not_a_call_site")'].join("\n");
  assert.deepEqual(kaigenIntentsDependencies(src, "lib.rs").map((d) => [d.method, d.where]), [
    ["add_public_key", "lib.rs:2"],
    ["remove_public_key", "lib.rs:5"],
    ["not_a_call_site", "lib.rs:7"], // a comment that looks like a call site is still listed: over-reporting a dependency is the safe error
  ]);
});

test("the real source of Mamori depends on exactly add_public_key and remove_public_key on intents.near", async () => {
  const fs = await import("node:fs");
  const deps = kaigenIntentsDependencies(fs.readFileSync(path.join(root, "contracts", "mamori", "src", "lib.rs"), "utf8"));
  assert.deepEqual([...new Set(deps.map((d) => d.method))].sort(), ["add_public_key", "remove_public_key"]);
});

test("compareExports: a missing method, and a name exported as something other than a function, are mismatches", () => {
  const deps = [
    { method: "add_public_key", where: "a:1" },
    { method: "remove_public_key", where: "a:2" },
    { method: "memory", where: "a:3" },
  ];
  const rows = compareExports(deps, [{ name: "add_public_key", kind: "func" }, { name: "memory", kind: "memory" }]);
  assert.deepEqual(rows.map((r) => [r.method, r.exported, r.other_kind]), [
    ["add_public_key", true, undefined],
    ["remove_public_key", false, undefined],
    ["memory", false, "memory"],
  ]);
});

test("readCode: lists the real export section, and flags bytes that do not hash to the node's code hash", async () => {
  const good = await readCode(readOnlyRpc("https://x.test", { fetchImpl: fakeNode({ methods: ["new", "add_public_key"] }).fetchImpl }), "intents.near");
  assert.deepEqual(good.exports.map((e) => e.name), ["new", "add_public_key"]);
  assert.equal(good.hash_matches_bytes, true);
  assert.equal(good.block_height, 7);
  const bad = await readCode(readOnlyRpc("https://x.test", { fetchImpl: fakeNode({ methods: ["new"], hash: "SomeOtherHash" }).fetchImpl }), "intents.near");
  assert.equal(bad.hash_matches_bytes, false);
});

test("runMainnetReads: both hosts, versions and ML-DSA entries recorded, matches and a mismatch reported, only reads sent", async () => {
  const hostA = fakeNode({ methods: ["new", "add_public_key", "remove_public_key"] });
  const hostB = fakeNode({ methods: ["new", "add_public_key"] }); // pretend a second host serves code without remove_public_key
  const byUrl = { "https://a.test": hostA, "https://b.test": hostB };
  const fetchImpl = (url, init) => byUrl[url].fetchImpl(url, init);
  const result = await runMainnetReads({ hosts: ["https://a.test", "https://b.test"], root, fetchImpl, now: () => new Date("2026-11-04T01:02:03Z") });
  assert.equal(result.hosts.length, 2);
  assert.equal(result.hosts[0].fetched_at, "2026-11-04T01:02:03.000Z");
  assert.equal(result.hosts[0].protocol.status.protocol_version, 86);
  assert.equal(result.hosts[0].protocol.ml_dsa_entries.length, 3);
  assert.deepEqual(result.hosts[0].comparison.map((r) => [r.method, r.exported]), [["add_public_key", true], ["remove_public_key", true]]);
  assert.deepEqual(result.hosts[1].comparison.map((r) => [r.method, r.exported]), [["add_public_key", true], ["remove_public_key", false]]);
  const allowed = new Set(["status", "EXPERIMENTAL_protocol_config", "query"]);
  for (const node of [hostA, hostB]) assert.ok(node.seen.every((s) => allowed.has(s.body.method) && s.headers["user-agent"] === CLIENT_NAME));

  const md = renderMarkdown(result);
  assert.match(md, /### https:\/\/a\.test/);
  assert.match(md, /\| `remove_public_key` \| .* \| NO \|/, "the mismatch shows in the table");
  assert.match(md, /protocol_version \| 86/);
});

test("runMainnetReads: a host that cannot be reached is reported as an error, not as a pass", async () => {
  const fetchImpl = async () => {
    throw new Error("connect ECONNREFUSED");
  };
  const result = await runMainnetReads({ hosts: ["https://down.test"], root, fetchImpl });
  assert.match(result.hosts[0].protocol_error, /ECONNREFUSED/);
  assert.match(result.hosts[0].code_error, /ECONNREFUSED/);
  assert.equal(result.hosts[0].comparison, undefined, "no comparison is shown when the code was not read");
});
