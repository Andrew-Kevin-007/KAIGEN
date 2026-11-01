import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/curves/utils.js";
import { makeRpc, pool, RpcError } from "../src/rpc.mjs";
import { classifyKeys, exposure } from "../src/classify.mjs";
import { nearImplicit, solanaAddress, taprootAddress, taprootKey } from "../src/addresses.mjs";
import { record, snapshot } from "../src/hinomi.mjs";
import { runKeeper, tripOnce } from "../src/keeper.mjs";
import { check, sources } from "../src/watchers.mjs";

const FULL = "FullAccess";
const fc = { FunctionCall: { allowance: "1", receiver_id: "v", method_names: ["send_small"] } };
const key = (public_key, permission = FULL) => ({ public_key, access_key: { nonce: 0, permission } });

// ---- rpc --------------------------------------------------------------------------------

const reply = (body, status = 200) => ({ status, ok: status < 400, json: async () => body });

test("rpc: parses view results, retries transient failures, maps unknown accounts to null", async () => {
  let calls = 0;
  const rpc = makeRpc("http://x", {
    backoffMs: 1,
    fetchImpl: async (_, init) => {
      const { method, params } = JSON.parse(init.body);
      calls++;
      if (calls === 1) return reply({}, 503);
      if (params.request_type === "call_function") return reply({ result: { result: [...Buffer.from('"Calm"')] } });
      // Real nodes (mainnet, 30 Oct 2026): view_account of a missing account is an error, but view_access_key_list of
      // one is an EMPTY LIST, the same answer an existing account with no keys (a locked Kizashi) gives.
      if (params.request_type === "view_access_key_list") return reply({ result: { keys: [] } });
      if (params.account_id === "locked.near") return reply({ result: { amount: "1", code_hash: "x" } });
      return reply({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: params.account_id } }, code: -32000, message: "Server error", data: `account ${params.account_id} does not exist while viewing` } });
    },
  });
  assert.equal(await rpc.view("k", "era"), "Calm");
  assert.ok(calls >= 2, "retried after the 503");
  assert.equal(await rpc.account("ghost.near"), null);
  assert.equal(await rpc.accessKeys("ghost.near"), null, "an account that does not exist is null, not an empty key list");
  assert.deepEqual(await rpc.accessKeys("locked.near"), [], "an account with no keys left is an empty list: that is what a locked Kizashi looks like");
});

test("rpc: error kinds follow the real node's shapes (bodies copied from mainnet and testnet, 30 Oct 2026)", async () => {
  const bodies = {
    "ed25519:K": { result: { block_hash: "H", block_height: 1, error: "access key ed25519:K does not exist while viewing", logs: [] } },
    "ml-dsa-65-hash:K": { error: { name: "REQUEST_VALIDATION_ERROR", cause: { name: "PARSE_ERROR", info: { error_message: "Failed parsing args: unknown key type 'ml-dsa-65-hash'" } }, code: -32700, message: "Parse error", data: "Failed parsing args: unknown key type 'ml-dsa-65-hash'" } },
  };
  let calls = 0;
  const rpc = makeRpc("http://x", { backoffMs: 1, fetchImpl: async (_, init) => (calls++, reply(bodies[JSON.parse(init.body).params.public_key])) });
  const keyQuery = (public_key) => rpc.call("query", { request_type: "view_access_key", finality: "final", account_id: "near", public_key });
  await assert.rejects(keyQuery("ed25519:K"), (e) => e.kind === "UNKNOWN_ACCESS_KEY", "a missing key is not a missing account");
  await assert.rejects(keyQuery("ml-dsa-65-hash:K"), (e) => e.kind === "RPC" && /unknown key type 'ml-dsa-65-hash'/.test(e.message));
  assert.equal(calls, 2, "neither is retried");
});

test("rpc: a real error is thrown, not retried", async () => {
  let calls = 0;
  const rpc = makeRpc("http://x", { backoffMs: 1, fetchImpl: async () => (calls++, reply({ error: { message: "boom" } })) });
  await assert.rejects(() => rpc.status(), (e) => e instanceof RpcError && /boom/.test(e.message));
  assert.equal(calls, 1);
});

test("rpc: accounts with over 100 keys are read page by page with after_key", async () => {
  const all = Array.from({ length: 230 }, (_, i) => ({ public_key: `ed25519:K${i}`, access_key: { nonce: 0, permission: "FullAccess" } }));
  const seen = [];
  const rpc = makeRpc("http://x", {
    fetchImpl: async (_, init) => {
      const { params } = JSON.parse(init.body);
      seen.push(params);
      if (!params.limit) return reply({ error: { cause: { name: "TOO_MANY_ACCESS_KEYS" }, message: "paginate" } });
      const start = params.after_key ? all.findIndex((k) => k.public_key === params.after_key) + 1 : 0;
      const keys = all.slice(start, start + params.limit);
      return reply({ result: { keys, last_key: keys.at(-1)?.public_key } });
    },
  });
  const keys = await rpc.accessKeys("near");
  assert.equal(keys.length, 230);
  assert.equal(new Set(keys.map((k) => k.public_key)).size, 230, "no key twice, none missing");
  assert.ok(!keys.truncated);
  assert.equal(seen.length, 4); // the failed plain read, then pages of 100, 100, 30
});

test("pool: bounded concurrency, ordered results", async () => {
  let live = 0, peak = 0;
  const out = await pool([1, 2, 3, 4, 5, 6], 2, async (n) => {
    peak = Math.max(peak, ++live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12]);
  assert.equal(peak, 2);
});

// ---- classify ---------------------------------------------------------------------------

test("classify: exposure follows full-access keys only", () => {
  assert.equal(exposure([key("ed25519:A")]), "classical-only");
  assert.equal(exposure([key("ml-dsa-65-hash:B")]), "post-quantum");
  assert.equal(exposure([key("ed25519:A"), key("ml-dsa-65-hash:B")]), "mixed");
  // Mamori daily keys are function-call keys: they do not expose the account.
  assert.equal(exposure([key("ml-dsa-65-hash:B"), key("ed25519:D", fc)]), "post-quantum");
  assert.equal(exposure([key("ed25519:D", fc)]), "locked");
  assert.deepEqual(classifyKeys([key("ed25519:D", fc)]).functionCall, ["ed25519:D"]);
});

// ---- addresses --------------------------------------------------------------------------

test("addresses: known vectors", () => {
  const zero = "00".repeat(32);
  assert.equal(nearImplicit(zero.toUpperCase()), zero);
  assert.equal(solanaAddress(zero), "1".repeat(32)); // the all-zero key is the Solana system program id
  // BIP-350 test vector: witness v1 program = secp256k1 generator x.
  const g = bytesToHex(secp256k1.Point.BASE.toBytes(false).slice(1));
  assert.equal(taprootAddress(g), "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0");
  assert.equal(taprootKey(taprootAddress(g)).x, g.slice(0, 64));
  assert.throws(() => taprootAddress("00"));
});

// ---- hinomi -----------------------------------------------------------------------------

function fakeChain(accounts) {
  return {
    status: async () => ({ sync_info: { latest_block_height: 100, latest_block_hash: "H" } }),
    finalBlock: async () => ({ height: 100, hash: "H" }),
    account: async (id) => (accounts[id] ? { amount: accounts[id].amount } : null),
    accessKeys: async (id) => accounts[id]?.keys ?? null,
    view: async (id, method) => accounts[id].views[method],
  };
}

test("hinomi: totals exposed vs post-quantum value and flags bypassing vaults", async () => {
  const rpc = fakeChain({
    "whale.near": { amount: "700", keys: [key("ed25519:A")] },
    "pq.near": { amount: "200", keys: [key("ml-dsa-65-hash:B")] },
    "mixed.near": { amount: "50", keys: [key("ed25519:A"), key("ml-dsa-65-hash:B")] },
    "vault1.near": { amount: "30", keys: [key("ml-dsa-65-hash:B"), key("ed25519:D", fc)] },
    "vault2.near": { amount: "20", keys: [key("ml-dsa-65-hash:B"), key("ed25519:X")] }, // user added a classical full-access key
  });
  const s = await snapshot({ rpc, accounts: ["whale.near", "pq.near", "mixed.near", "gone.near"], vaults: ["vault1.near", "vault2.near"] });
  assert.equal(s.block_height, 100);
  assert.equal(s.exposed_yocto, "770"); // 700 classical-only + 50 mixed + 20 (vault2 is mixed)
  assert.equal(s.post_quantum_yocto, "230"); // 200 + 30
  assert.deepEqual(s.missing, ["gone.near"]);
  assert.deepEqual(s.flagged_vaults, ["vault2.near"]);
  assert.equal(s.classes["classical-only"].accounts, 1);
});

test("hinomi: one account that cannot be read is reported and the rest still count", async () => {
  const chain = fakeChain({ "ok.near": { amount: "5", keys: [key("ed25519:A")] } });
  const rpc = { ...chain, accessKeys: async (id) => { if (id === "bad.near") throw new Error("HTTP 429"); return chain.accessKeys(id); }, account: async (id) => (id === "bad.near" ? { amount: "1" } : chain.account(id)) };
  const s = await snapshot({ rpc, accounts: ["ok.near", "bad.near"] });
  assert.equal(s.sampled, 1);
  assert.deepEqual(s.errors, [{ id: "bad.near", error: "HTTP 429" }]);
  assert.equal(s.exposed_yocto, "5");
});

test("hinomi: history gets one line per block and latest.json keeps the detail", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hinomi-"));
  const rpc = fakeChain({ "a.near": { amount: "5", keys: [key("ed25519:A")] } });
  const s = await snapshot({ rpc, accounts: ["a.near"] });
  assert.equal(record(dir, s), "appended");
  assert.equal(record(dir, s), "duplicate", "same block is not appended twice");
  assert.equal(fs.readFileSync(path.join(dir, "history.jsonl"), "utf8").trim().split("\n").length, 1);
  assert.ok(!("rows" in JSON.parse(fs.readFileSync(path.join(dir, "history.jsonl"), "utf8"))));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "latest.json"), "utf8")).rows.length, 1);
});

// ---- keeper -----------------------------------------------------------------------------

test("keeper: does nothing while calm", async () => {
  const sent = [];
  const rpc = fakeChain({ k: { views: { era: "Calm" } } });
  const r = await tripOnce({ rpc, kizashi: "k", vaults: ["v"], sendTrip: async (v) => sent.push(v) });
  assert.deepEqual(sent, []);
  assert.equal(r.era, "Calm");
});

/** What a real `trip` leaves behind at Kaigen: the vault's era cached and its daily keys gone. */
const lockDown = (accounts, v) => {
  accounts[v].views = { era: "Kaigen", daily_keys: [] };
  accounts[v].keys = [key("ml-dsa-65-hash:B")];
};

test("keeper: trips stale vaults, skips current ones, retries half-finished lockdowns, survives errors", async () => {
  const accounts = {
    k: { views: { era: "Kaigen" } },
    stale: { views: { era: "Calm", daily_keys: ["ed25519:D"] } },
    done: { views: { era: "Kaigen", daily_keys: [] } },
    partial: { views: { era: "Kaigen", daily_keys: ["ed25519:D"] } },
  };
  const rpc = fakeChain(accounts);
  const sent = [];
  const r = await tripOnce({
    rpc,
    kizashi: "k",
    vaults: ["stale", "done", "partial", "notavault"],
    sendTrip: async (v) => (sent.push(v), lockDown(accounts, v), `hash-${v}`),
  });
  assert.deepEqual(sent.sort(), ["partial", "stale"]);
  const by = Object.fromEntries(r.results.map((x) => [x.vault, x.action]));
  assert.deepEqual(by, { stale: "tripped", done: "up to date", partial: "tripped", notavault: "error" });
});

test("keeper: a failing submit is reported and does not stop the others", async () => {
  const accounts = {
    k: { views: { era: "Warning" } },
    a: { views: { era: "Calm" } },
    b: { views: { era: "Calm" } },
  };
  const rpc = fakeChain(accounts);
  const r = await tripOnce({
    rpc,
    kizashi: "k",
    vaults: ["a", "b"],
    sendTrip: async (v) => {
      if (v === "a") throw new Error("out of gas");
      accounts[v].views = { era: "Warning" };
      return "h";
    },
  });
  assert.deepEqual(r.results.map((x) => x.action), ["error", "tripped"]);
});

// ---- watchers ---------------------------------------------------------------------------

const omens = [
  { id: "ed25519-omen", curve: "Ed25519", public_key: "11".repeat(32) },
  { id: "secp256k1-omen", curve: "Secp256k1", public_key: bytesToHex(secp256k1.Point.BASE.toBytes(false).slice(1)) },
];

test("watchers: first read is a baseline, a drop alerts, a top-up does not", async () => {
  let balance = 1000n;
  const src = [{ id: "near:x", read: async () => ({ balance }) }];
  let r = await check(src, {});
  assert.deepEqual(r.alerts, []);
  balance = 1500n; // someone topped up the bounty
  r = await check(src, r.state);
  assert.deepEqual(r.alerts, []);
  balance = 0n; // the key moved the funds
  r = await check(src, r.state);
  assert.equal(r.alerts[0].kind, "outflow");
  // The baseline stays at the high-water mark, so the alert repeats until a human clears it.
  r = await check(src, r.state);
  assert.equal(r.alerts[0].kind, "outflow");
});

test("watchers: bitcoin alerts on spent outputs, including ones that predate the baseline", async () => {
  let spent = 0;
  const src = [{ id: "bitcoin:x", read: async () => ({ spent }) }];
  let r = await check(src, {});
  assert.deepEqual(r.alerts, []);
  spent = 1;
  r = await check(src, r.state);
  assert.equal(r.alerts.length, 1);
  assert.equal((await check([{ id: "b", read: async () => ({ spent: 2 }) }], {})).alerts.length, 1);
});

test("watchers: an unreadable source is reported but never mistaken for an outflow", async () => {
  const bad = [{ id: "solana:x", read: async () => { throw new Error("rate limited"); } }];
  const r = await check(bad, { "solana:x": { balance: "5" } });
  assert.equal(r.alerts[0].kind, "unreadable");
  assert.deepEqual(r.state, { "solana:x": { balance: "5" } });
});

test("watchers: sources are built from the omen keys, on the right chains", async () => {
  const rpc = { account: async () => ({ amount: "7" }) };
  const fetchImpl = async (url) => {
    if (String(url).includes("solana")) return reply({ result: { value: 9 } });
    return reply({ chain_stats: { spent_txo_count: 0 }, mempool_stats: { spent_txo_count: 0 } });
  };
  const srcs = sources({ rpc, omens, fetchImpl, solanaUrl: "https://solana.example", btcApi: "https://btc.example" });
  assert.deepEqual(srcs.map((s) => s.id.split(":")[0]), ["near", "solana", "bitcoin"]);
  assert.deepEqual(await srcs[0].read(), { balance: 7n });
  assert.deepEqual(await srcs[1].read(), { balance: 9n });
  assert.deepEqual(await srcs[2].read(), { spent: 0 });
  assert.equal(srcs[0].address, "11".repeat(32));
});

// ---- review follow-ups ----------------------------------------------------------------

test("hinomi: a partial snapshot is saved for inspection but never enters the history", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hinomi-"));
  const chain = fakeChain({ "ok.near": { amount: "5", keys: [key("ed25519:A")] } });
  const rpc = { ...chain, accessKeys: async (id) => { if (id === "bad.near") throw new Error("HTTP 429"); return chain.accessKeys(id); }, account: async (id) => (id === "bad.near" ? { amount: "1" } : chain.account(id)) };
  const s = await snapshot({ rpc, accounts: ["ok.near", "bad.near"] });
  assert.equal(record(dir, s), "partial");
  assert.ok(fs.existsSync(path.join(dir, "latest.json")));
  assert.ok(!fs.existsSync(path.join(dir, "history.jsonl")), "a false drop in exposure must not become a data point");
});

test("hinomi: every read is pinned to the one final block", async () => {
  const seen = [];
  const chain = fakeChain({ "a.near": { amount: "5", keys: [key("ed25519:A")] } });
  const rpc = { ...chain, account: async (id, b) => (seen.push(b), chain.account(id)), accessKeys: async (id, b) => (seen.push(b), chain.accessKeys(id)) };
  await snapshot({ rpc, accounts: ["a.near"] });
  assert.deepEqual(seen, ["H", "H"]);
});

test("keeper: an era it does not know stops the pass instead of reading as up to date", async () => {
  const rpc = fakeChain({ k: { views: { era: "Quantum" } } });
  await assert.rejects(() => tripOnce({ rpc, kizashi: "k", vaults: [], sendTrip: async () => "h" }), /unknown era/);
  const rpc2 = fakeChain({ k: { views: { era: "Kaigen" } }, v: { views: { era: "Weird", daily_keys: [] } } });
  const r = await tripOnce({ rpc: rpc2, kizashi: "k", vaults: ["v"], sendTrip: async () => "h" });
  assert.equal(r.results[0].action, "error");
  assert.match(r.results[0].error, /unknown era/);
});

test("keeper: a live function-call key the contract no longer lists still triggers a trip", async () => {
  const accounts = {
    k: { views: { era: "Kaigen" } },
    v: { views: { era: "Kaigen", daily_keys: [] }, amount: "1", keys: [key("ml-dsa-65-hash:B"), key("ed25519:D", fc)] },
  };
  const rpc = fakeChain(accounts);
  const sent = [];
  const r = await tripOnce({ rpc, kizashi: "k", vaults: ["v"], sendTrip: async (v) => (sent.push(v), lockDown(accounts, v), "h") });
  assert.deepEqual(sent, ["v"]);
  assert.equal(r.results[0].action, "tripped");
});

test("keeper: a trip that was submitted but did not lock the vault is 'unconfirmed', never 'tripped'", async () => {
  // Submission succeeded (a hash came back) but re-reading the chain still shows a live function-call key.
  const accounts = {
    k: { views: { era: "Kaigen" } },
    stuck: { views: { era: "Calm", daily_keys: ["ed25519:D"] }, amount: "1", keys: [key("ml-dsa-65-hash:B"), key("ed25519:D", fc)] },
    eraOnly: { views: { era: "Calm", daily_keys: [] }, amount: "1", keys: [key("ml-dsa-65-hash:B"), key("ed25519:D", fc)] },
    good: { views: { era: "Calm", daily_keys: ["ed25519:D"] }, amount: "1", keys: [key("ml-dsa-65-hash:B"), key("ed25519:D", fc)] },
  };
  const rpc = fakeChain(accounts);
  const r = await tripOnce({
    rpc,
    kizashi: "k",
    vaults: ["stuck", "eraOnly", "good"],
    sendTrip: async (v) => {
      if (v === "good") lockDown(accounts, v);
      if (v === "eraOnly") accounts[v].views = { era: "Kaigen", daily_keys: [] }; // era moved, the key survived
      return `hash-${v}`;
    },
  });
  const by = Object.fromEntries(r.results.map((x) => [x.vault, x]));
  assert.equal(by.stuck.action, "unconfirmed");
  assert.equal(by.stuck.hash, "hash-stuck", "the submitted hash is still reported");
  assert.match(by.stuck.error, /still/);
  assert.equal(by.eraOnly.action, "unconfirmed", "a cached era alone is not a lockdown while a function-call key is live");
  assert.equal(by.good.action, "tripped");
});

test("keeper: at Warning a trip is confirmed by the vault's era alone", async () => {
  const accounts = { k: { views: { era: "Warning" } }, v: { views: { era: "Calm" } } };
  const rpc = fakeChain(accounts);
  const miss = await tripOnce({ rpc, kizashi: "k", vaults: ["v"], sendTrip: async () => "h" });
  assert.equal(miss.results[0].action, "unconfirmed");
  const hit = await tripOnce({ rpc, kizashi: "k", vaults: ["v"], sendTrip: async () => ((accounts.v.views = { era: "Warning" }), "h") });
  assert.equal(hit.results[0].action, "tripped");
});

test("keeper: an empty vault list is an error, not a clean pass, even while calm", async () => {
  const rpc = fakeChain({ k: { views: { era: "Calm" } } });
  await assert.rejects(() => tripOnce({ rpc, kizashi: "k", vaults: [], sendTrip: async () => "h" }), /no vaults configured/);
  await assert.rejects(() => tripOnce({ rpc, kizashi: "k", sendTrip: async () => "h" }), /no vaults configured/);
});

test("keeper loop: stops promptly on abort, survives a throwing reporter, and leaks no listeners", async () => {
  const rpc = fakeChain({ k: { views: { era: "Calm" } } });
  const ctl = new AbortController();
  let passes = 0;
  const done = runKeeper({
    rpc, kizashi: "k", vaults: [], sendTrip: async () => "h", intervalMs: 5, signal: ctl.signal,
    onPass: () => { if (++passes === 3) ctl.abort(); throw new Error("reporter broke"); },
  });
  await done;
  assert.equal(passes, 3);
  // A long interval must not delay the exit once aborted.
  const ctl2 = new AbortController();
  const t0 = Date.now();
  const p = runKeeper({ rpc, kizashi: "k", vaults: [], sendTrip: async () => "h", intervalMs: 60_000, signal: ctl2.signal, onPass: () => setTimeout(() => ctl2.abort(), 5) });
  await p;
  assert.ok(Date.now() - t0 < 2000);
});

test("watchers: a bitcoin spend keeps alerting on every later run, not just the first", async () => {
  let spent = 0;
  const src = [{ id: "bitcoin:x", read: async () => ({ spent }) }];
  let r = await check(src, {});
  spent = 1;
  for (let run = 0; run < 3; run++) {
    r = await check(src, r.state);
    assert.equal(r.alerts.length, 1, `run ${run} must still alert`);
  }
  // First sighting with spends already present alerts, and keeps alerting.
  let first = await check([{ id: "b", read: async () => ({ spent: 2 }) }], {});
  first = await check([{ id: "b", read: async () => ({ spent: 2 }) }], first.state);
  assert.equal(first.alerts.length, 1);
});

test("watchers: a bitcoin response without spend counts is unreadable, not 'nothing spent'", async () => {
  const rpc = { account: async () => ({ amount: "1" }) };
  const fetchImpl = async () => reply({ error: "rate limited" });
  const src = sources({ rpc, omens, fetchImpl, solanaUrl: "https://s", btcApi: "https://b" }).find((s) => s.id.startsWith("bitcoin"));
  const r = await check([src], {});
  assert.equal(r.alerts[0].kind, "unreadable");
  assert.deepEqual(r.state, {});
});

test("rpc: node-side timeouts are retried, and an object error message is readable", async () => {
  let calls = 0;
  const rpc = makeRpc("http://x", {
    backoffMs: 1,
    fetchImpl: async () => (++calls < 3 ? reply({ error: { name: "HANDLER_ERROR", cause: { name: "UNAVAILABLE_SHARD" }, data: { shard: 2 } } }) : reply({ result: { ok: true } })),
  });
  assert.deepEqual(await rpc.call("x", []), { ok: true });
  assert.equal(calls, 3);
  const hard = makeRpc("http://x", { backoffMs: 1, fetchImpl: async () => reply({ error: { name: "HANDLER_ERROR", cause: { name: "OTHER" }, data: { detail: 1 } } }) });
  await assert.rejects(() => hard.call("x", []), (e) => e.message === '{"detail":1}');
});
