// The full counterparty check (assessCounterparty), its blocklist file and its command line, against a fake chain.
// The fake sits behind the real makeRpc (through a fake fetch), so the real error parsing of rpc.mjs is what turns a
// node's "garbage collected" or "unknown block" answer into a state the search understands.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addReport,
  assessCounterparty,
  CounterpartyUsage,
  exitCodeOf,
  firstSeen,
  isAccountId,
  loadBlocklist,
  looksLikeEvidence,
  parseCounterpartyArgs,
  parseReportArgs,
  renderCounterparty,
} from "../src/counterparty.mjs";
import { makeRpc } from "../src/rpc.mjs";

const NO_CODE = "11111111111111111111111111111111";
const NS = 1_000_000_000n;
const HEAD = 3_000_000;
const HEAD_TS = 1_800_000_000n * NS;
const VAULT = "vault.test.near";
const TO = "shop.test.near";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "src", "bin.mjs");

/**
 * A chain where `accounts[id] = { created, deleted?, code?: [[fromHeight, hash]...], global? }`. One block every `blockSec`
 * seconds, nothing readable below `readableFrom`, no block at the `skipped` heights, optional `fail(method, params)` to
 * answer with a given HTTP status. Answers have the shapes a real node uses.
 */
function makeChain({ head = HEAD, blockSec = 1, accounts = {}, readableFrom = 1, skipped = [], policy = { enforced: false, accounts: [] }, viewFails = false, fail } = {}) {
  const skip = new Set(skipped);
  const tsOf = (h) => HEAD_TS - BigInt(head - h) * BigInt(blockSec) * NS;
  const accountAt = (id, h) => {
    const a = accounts[id];
    if (!a || h < a.created || (a.deleted !== undefined && h >= a.deleted)) return undefined;
    const [, hash] = [...(a.code ?? [[0, NO_CODE]])].filter(([from]) => from <= h).pop() ?? [0, NO_CODE];
    return { amount: "1", locked: "0", code_hash: hash, storage_usage: 100, storage_paid_at: 0, block_height: h, block_hash: "x", ...(a.global ? { global_contract_hash: a.global } : {}) };
  };
  const err = (name, data) => ({ error: { name: "HANDLER_ERROR", cause: { name, info: {} }, code: -32000, message: "Server error", data } });
  const calls = [];
  const handle = (method, params) => {
    calls.push({ method, params });
    const failing = fail?.(method, params);
    if (failing) return { status: failing, body: {} };
    if (method === "block") {
      const h = params.block_id ?? head;
      if (h > head || h < 1 || skip.has(h)) return { body: err("UNKNOWN_BLOCK", `DB Not Found Error: BLOCK HEIGHT: ${h} \n Cause: Unknown`) };
      return { body: { result: { header: { height: h, timestamp_nanosec: String(tsOf(h)), hash: "h" } } } };
    }
    if (method === "query" && params.request_type === "view_account") {
      const h = params.block_id ?? head;
      if (h > head || skip.has(h)) return { body: err("UNKNOWN_BLOCK", `DB Not Found Error: BLOCK HEIGHT: ${h} \n Cause: Unknown`) };
      if (h < readableFrom) return { body: err("GARBAGE_COLLECTED_BLOCK", `The data for block #${h} is garbage collected on this node, use an archival node to fetch historical data`) };
      const a = accountAt(params.account_id, h);
      return { body: a ? { result: a } : err("UNKNOWN_ACCOUNT", `account ${params.account_id} does not exist while viewing`) };
    }
    if (method === "query" && params.request_type === "call_function") {
      if (viewFails) return { body: err("CONTRACT_EXECUTION_ERROR", "the vault has no such method") };
      return { body: { result: { result: [...Buffer.from(JSON.stringify(policy))], logs: [] } } };
    }
    return { body: err("METHOD_NOT_FOUND", method) };
  };
  const fetchImpl = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    const r = handle(method, params);
    return { status: r.status ?? 200, json: async () => ({ jsonrpc: "2.0", id: "kaigen", ...r.body }) };
  };
  return { rpc: makeRpc("http://fake.invalid", { fetchImpl, retries: 0, backoffMs: 0 }), handle, calls, head };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kaigen-cp-"));
const missingList = () => loadBlocklist(path.join(tmp(), "none.json"));
const sig = (r, id) => r.signals.find((s) => s.id === id);
const text = (r, id) => sig(r, id).reasons.map((x) => x.text).join(" | ");
const old = { created: 408_000 }; // 30 days at one block a second
const assess = (chain, extra = {}) => assessCounterparty({ rpc: chain.rpc, vault: VAULT, to: TO, history: [TO], blocklist: missingList(), ...extra });

// ---- 1. account age ---------------------------------------------------------------------------------------------

test("firstSeen finds the exact first block of an account created inside the node's history", async () => {
  const c = makeChain({ accounts: { [TO]: { created: HEAD - 50_000 } } });
  const r = await firstSeen({ rpc: c.rpc, id: TO, head: { height: HEAD, tsNs: HEAD_TS } });
  assert.equal(r.kind, "exact");
  assert.equal(r.height, HEAD - 50_000);
  assert.equal(r.before, HEAD - 50_001, "the block just before has no such account");
  assert.ok(c.calls.length < 60, `a search, not a scan: ${c.calls.length} reads`);
});

test("firstSeen steps over heights that have no block", async () => {
  const created = HEAD - 50_000;
  const c = makeChain({ accounts: { [TO]: { created } }, skipped: [created - 1, created, created + 1] });
  const r = await firstSeen({ rpc: c.rpc, id: TO, head: { height: HEAD, tsNs: HEAD_TS } });
  assert.equal(r.kind, "exact");
  assert.equal(r.height, created + 2, "the first height that has a block and shows the account");
});

test("firstSeen says at-least, never an exact date, when the node has thrown the older state away", async () => {
  const readableFrom = HEAD - 30_000;
  const c = makeChain({ accounts: { [TO]: { created: HEAD - 900_000 } }, readableFrom });
  const r = await firstSeen({ rpc: c.rpc, id: TO, head: { height: HEAD, tsNs: HEAD_TS } });
  assert.equal(r.kind, "at-least");
  assert.equal(r.height, readableFrom, "the oldest readable block that has it");
});

test("firstSeen reads the threshold block first, then still finds the exact first block", async () => {
  const c = makeChain({ accounts: { [TO]: old } });
  const threshold = { height: HEAD - 7 * 86_400 - 1_800, tsNs: HEAD_TS - BigInt(7 * 86_400 + 1_800) * NS };
  const r = await firstSeen({ rpc: c.rpc, id: TO, head: { height: HEAD, tsNs: HEAD_TS }, threshold });
  assert.deepEqual([r.kind, r.height], ["exact", 408_000]);
});

test("firstSeen keeps what the threshold block proved when the rest of the search is rate limited", async () => {
  const threshold = { height: HEAD - 7 * 86_400 - 1_800, tsNs: HEAD_TS - BigInt(7 * 86_400 + 1_800) * NS };
  const c = makeChain({ accounts: { [TO]: old }, fail: (m, p) => (m === "query" && p.block_id !== undefined && p.block_id < threshold.height ? 429 : 0) });
  const r = await firstSeen({ rpc: c.rpc, id: TO, head: { height: HEAD, tsNs: HEAD_TS }, threshold });
  assert.deepEqual([r.kind, r.height, r.interrupted], ["at-least", threshold.height, "HTTP 429"]);
  // With nothing proven yet, a rate limit is an error, not a guess.
  await assert.rejects(firstSeen({ rpc: c.rpc, id: TO, head: { height: HEAD, tsNs: HEAD_TS } }), /HTTP 429/);
});

test("an old account is still known to be old when the exact search is rate limited", async () => {
  const c = makeChain({ accounts: { [TO]: old }, fail: (m, p) => (m === "query" && p.block_id !== undefined && p.block_id < HEAD - 8 * 86_400 ? 429 : 0) });
  const r = await assess(c);
  assert.equal(sig(r, "age").status, "known");
  assert.match(text(r, "age"), /at least 7\.\d days old.*the search for the exact date stopped: HTTP 429/);
  assert.equal(r.verdict, "allow");
});

test("a young account warns and the reason states its age", async () => {
  const c = makeChain({ accounts: { [TO]: { created: HEAD - 18_000 } } }); // 5 hours
  const r = await assess(c);
  assert.equal(sig(r, "age").status, "known");
  assert.equal(r.verdict, "warn");
  assert.match(text(r, "age"), /only 5\.0 hours old/);
  assert.match(text(r, "age"), /younger than 168 hours/);
});

test("an old account is known to be old and does not warn on age", async () => {
  const c = makeChain({ accounts: { [TO]: old } });
  const r = await assess(c);
  assert.equal(sig(r, "age").status, "known");
  assert.match(text(r, "age"), /30\.0 days old/);
  assert.ok(sig(r, "age").reasons.every((x) => x.level === "info"));
});

test("the age threshold is a parameter", async () => {
  const c = makeChain({ accounts: { [TO]: { created: HEAD - 18_000 } } });
  const r = await assess(c, { minAgeHours: 4 });
  assert.ok(sig(r, "age").reasons.every((x) => x.level === "info"), "5 hours is past a 4 hour threshold");
});

test("age is unknown, with the limit named, when the node only holds a day and a half", async () => {
  const c = makeChain({ accounts: { [TO]: old }, readableFrom: HEAD - 125_000 }); // about 34.7 hours
  const r = await assess(c);
  assert.equal(sig(r, "age").status, "unknown");
  assert.match(text(r, "age"), /age unknown/);
  assert.match(text(r, "age"), /at least 34\.\d hours old/);
  assert.match(text(r, "age"), /archival/);
  assert.equal(r.verdict, "warn", "unknown is a warning, never a pass");
});

test("a lower bound past the threshold is a known fact: at least that old", async () => {
  const c = makeChain({ accounts: { [TO]: old }, readableFrom: HEAD - 8 * 86_400 });
  const r = await assess(c);
  assert.equal(sig(r, "age").status, "known");
  assert.match(text(r, "age"), /at least 8\.0 days old/);
});

test("age is unknown, not guessed, when the node errors", async () => {
  const c = makeChain({ accounts: { [TO]: old }, fail: (m, p) => (m === "query" && p.request_type === "view_account" && p.block_id !== undefined && p.block_id < HEAD ? 500 : 0) });
  const r = await assess(c);
  // Every past read failing is "unreadable": the best the search can say is the head block, a lower bound of zero.
  assert.equal(sig(r, "age").status, "unknown");
  assert.doesNotMatch(text(r, "age"), /only .* old/);
  assert.equal(r.verdict, "warn");
});

test("the age search gives up on its time budget and says so, instead of holding the payment", async () => {
  const young = await assess(makeChain({ accounts: { [TO]: { created: HEAD - 18_000 } } }), { searchBudgetMs: -1 });
  assert.equal(sig(young, "age").status, "unknown");
  assert.match(text(young, "age"), /age unknown: gave up after/);
  assert.equal(young.verdict, "warn");
  // An old account already proved old by the threshold block keeps that proof.
  const proven = await assess(makeChain({ accounts: { [TO]: old } }), { searchBudgetMs: -1 });
  assert.equal(sig(proven, "age").status, "known");
  assert.match(text(proven, "age"), /at least 7\.\d days old.*stopped: gave up after/);
});

test("age is unknown when the block head cannot be read", async () => {
  const c = makeChain({ accounts: { [TO]: old }, fail: (m, p) => (m === "block" && p.finality === "final" ? 500 : 0) });
  const r = await assess(c);
  assert.equal(sig(r, "age").status, "unknown");
  assert.equal(sig(r, "code-change").status, "unknown");
  assert.match(text(r, "age"), /could not read the latest block/);
});

test("an archival node can answer the age while the main node cannot", async () => {
  const main = makeChain({ accounts: { [TO]: old }, readableFrom: HEAD - 125_000 });
  const archive = makeChain({ accounts: { [TO]: old } });
  const r = await assessCounterparty({ rpc: main.rpc, archival: archive.rpc, vault: VAULT, to: TO, history: [TO], blocklist: missingList() });
  assert.match(text(r, "age"), /30\.0 days old/);
  assert.match(sig(r, "age").source, /archival node/);
  assert.equal(r.verdict, "allow");
});

// ---- 2. contract or not, and code change --------------------------------------------------------------------------

test("a plain account is not a contract and has no code change", async () => {
  const r = await assess(makeChain({ accounts: { [TO]: old } }));
  assert.match(text(r, "contract"), /plain account/);
  assert.match(text(r, "code-change"), /no contract code now or 24\.0 hours ago/);
  assert.equal(r.verdict, "allow");
});

test("a contract warns, and unchanged code is reported as unchanged", async () => {
  const r = await assess(makeChain({ accounts: { [TO]: { created: 408_000, code: [[0, "HASH_A"]] } } }));
  assert.equal(r.verdict, "warn");
  assert.match(text(r, "contract"), /is a contract.*code HASH_A/);
  assert.match(text(r, "code-change"), /did not change over the last 24\.0 hours \(code HASH_A\)/);
  assert.ok(sig(r, "code-change").reasons.every((x) => x.level === "info"));
});

test("a code change inside the window warns and names both hashes, but never blocks", async () => {
  const r = await assess(makeChain({ accounts: { [TO]: { created: 408_000, code: [[0, "HASH_A"], [HEAD - 3_600, "HASH_B"]] } } }));
  assert.equal(r.verdict, "warn");
  assert.equal(sig(r, "code-change").reasons[0].level, "warn");
  assert.match(text(r, "code-change"), /changed within the last 24\.0 hours: code HASH_A -> code HASH_B/);
  assert.ok(!r.reasons.some((x) => x.level === "block"), "a change alone blocks nothing");
});

test("a code change older than the window is not a recent change", async () => {
  const r = await assess(makeChain({ accounts: { [TO]: { created: 408_000, code: [[0, "HASH_A"], [HEAD - 200_000, "HASH_B"]] } } }));
  assert.match(text(r, "code-change"), /did not change/);
});

test("deploying code onto a plain account inside the window is a change", async () => {
  const r = await assess(makeChain({ accounts: { [TO]: { created: 408_000, code: [[0, NO_CODE], [HEAD - 3_600, "HASH_B"]] } } }));
  assert.match(text(r, "code-change"), /no contract -> code HASH_B/);
  assert.equal(sig(r, "code-change").reasons[0].level, "warn");
});

test("a global contract counts as a contract and its hash is compared", async () => {
  const r = await assess(makeChain({ accounts: { [TO]: { created: 408_000, global: "GLOBAL_X" } } }));
  assert.match(text(r, "contract"), /is a contract.*global contract GLOBAL_X/);
  assert.match(text(r, "code-change"), /did not change.*global contract GLOBAL_X/);
});

test("an account created, as a contract, inside the window warns on both age and code", async () => {
  const r = await assess(makeChain({ accounts: { [TO]: { created: HEAD - 1_000, code: [[0, "HASH_A"]] } } }));
  assert.match(text(r, "code-change"), /did not exist 24\.0 hours ago.*deployed within/);
  assert.equal(sig(r, "code-change").reasons[0].level, "warn");
  assert.match(text(r, "age"), /only 0\.3 hours old/);
});

test("the 24 hour window is found even when blocks are not one a second and some heights have no block", async () => {
  const target = HEAD - Math.round(86_400 / 2);
  const r = await assess(makeChain({ blockSec: 2, skipped: [target, target + 1], accounts: { [TO]: { created: 100_000, code: [[0, "HASH_A"], [HEAD - 20_000, "HASH_B"]] } } }));
  assert.match(text(r, "code-change"), /changed within the last 2[34]\.\d hours/);
  assert.equal(sig(r, "code-change").status, "known");
});

test("code change is unknown, and says to use an archival node, when the node no longer holds the earlier block", async () => {
  const r = await assess(makeChain({ accounts: { [TO]: old }, readableFrom: HEAD - 1_000 }));
  assert.equal(sig(r, "code-change").status, "unknown");
  assert.match(text(r, "code-change"), /archival/);
  assert.equal(r.verdict, "warn");
});

test("a named account that does not exist is blocked; an unfunded implicit one only warns; history has nothing to read", async () => {
  const gone = await assess(makeChain());
  assert.equal(gone.verdict, "block");
  assert.match(text(gone, "contract"), /does not exist/);
  assert.equal(sig(gone, "age").status, "known");
  assert.match(text(gone, "age"), /no history to read/);
  const implicit = "a".repeat(64);
  const warn = await assess(makeChain(), { to: implicit, history: [implicit] });
  assert.equal(warn.verdict, "warn");
  assert.match(text(warn, "contract"), /never been funded/);
});

test("when the recipient account cannot be read, every signal that needs it is unknown", async () => {
  const c = makeChain({ accounts: { [TO]: old }, fail: (m, p) => (m === "query" && p.request_type === "view_account" && p.block_id === undefined ? 500 : 0) });
  const r = await assess(c);
  assert.equal(sig(r, "contract").status, "unknown");
  assert.equal(sig(r, "age").status, "unknown");
  assert.equal(sig(r, "code-change").status, "unknown");
  assert.equal(r.verdict, "warn");
});

// ---- 3. past payments -----------------------------------------------------------------------------------------------

test("past payments are unknown, with the reason, when the agent has no record: the chain history is not readable", async () => {
  const r = await assess(makeChain({ accounts: { [TO]: old } }), { history: undefined });
  const s = sig(r, "interactions");
  assert.equal(s.status, "unknown");
  assert.match(s.reasons[0].text, /cannot be read over JSON-RPC/);
  assert.match(s.reasons[0].text, /receipts\(\)/);
  assert.equal(r.verdict, "warn");
  assert.equal(r.unknownCount, 1);
});

test("a recipient the agent's record has never paid is 'first payment', a warning", async () => {
  const r = await assess(makeChain({ accounts: { [TO]: old } }), { history: ["someone.else.near"] });
  assert.equal(sig(r, "interactions").status, "known");
  assert.match(text(r, "interactions"), /first payment/);
  assert.equal(r.verdict, "warn");
});

test("a recipient the agent has paid before is fine, whether the record is an array or a Set", async () => {
  for (const history of [[TO], new Set([TO])]) {
    const r = await assess(makeChain({ accounts: { [TO]: old } }), { history });
    assert.match(text(r, "interactions"), /paid this recipient before/);
    assert.equal(r.verdict, "allow");
  }
});

// ---- 4. blocklist ---------------------------------------------------------------------------------------------------

test("a missing blocklist file means nothing was reported, and the real one is gitignored", () => {
  const b = loadBlocklist(path.join(tmp(), "nope.json"));
  assert.deepEqual([b.entries, b.missing, b.error], [[], true, undefined]);
  const gitignore = fs.readFileSync(path.join(HERE, "..", "..", ".gitignore"), "utf8");
  assert.match(gitignore, /^data\/blocklist\.json$/m);
});

test("a listed account is blocked, with the reason, the evidence, who reported it and when", async () => {
  const dir = tmp();
  const file = path.join(dir, "bl.json");
  const e = addReport({ file, account: TO, reason: "drained three agents", evidence: "https://example.org/report/1", reportedBy: "agent-7", now: new Date("2026-11-07T10:00:00Z") });
  assert.deepEqual(Object.keys(e).sort(), ["account", "evidence", "reason", "reportedAt", "reportedBy"]);
  const r = await assess(makeChain({ accounts: { [TO]: old } }), { blocklist: loadBlocklist(file) });
  assert.equal(r.verdict, "block");
  assert.equal(r.exitCode, 1);
  const t = text(r, "blocklist");
  for (const part of ["drained three agents", "https://example.org/report/1", "agent-7", "2026-11-07T10:00:00.000Z"]) assert.ok(t.includes(part), part);
  const other = await assess(makeChain({ accounts: { [TO]: old } }), { to: TO, blocklist: loadBlocklist(file), history: [TO] });
  assert.equal(other.verdict, "block");
});

test("an unlisted account is not blocked by someone else's listing", async () => {
  const file = path.join(tmp(), "bl.json");
  addReport({ file, account: "evil.near", reason: "scam", evidence: "https://x.test/1" });
  const r = await assess(makeChain({ accounts: { [TO]: old } }), { blocklist: loadBlocklist(file) });
  assert.equal(r.verdict, "allow");
  assert.match(text(r, "blocklist"), /not on the blocklist \(1 report/);
});

test("more than three reports of one account are counted, not all printed", async () => {
  const file = path.join(tmp(), "bl.json");
  for (let i = 0; i < 5; i++) addReport({ file, account: TO, reason: `r${i}`, evidence: `https://x.test/${i}` });
  const r = await assess(makeChain({ accounts: { [TO]: old } }), { blocklist: loadBlocklist(file) });
  assert.equal(sig(r, "blocklist").reasons.length, 4);
  assert.match(text(r, "blocklist"), /and 2 more report/);
});

test("a report without evidence, without a reason or with a bad account is refused and writes nothing", () => {
  const file = path.join(tmp(), "bl.json");
  for (const bad of [{ evidence: "" }, { evidence: "   " }, { evidence: undefined }, { reason: "" }, { account: "Not An Account" }]) {
    assert.throws(() => addReport({ file, account: TO, reason: "scam", evidence: "https://x.test/1", ...bad }), CounterpartyUsage);
  }
  assert.ok(!fs.existsSync(file), "nothing was written");
});

test("reports append, persist as the documented shape, and leave no temp file behind", () => {
  const dir = tmp();
  const file = path.join(dir, "sub", "bl.json");
  addReport({ file, account: "a.near", reason: "one", evidence: "https://x.test/1" });
  addReport({ file, account: "b.near", reason: "two", evidence: "9".repeat(44) });
  const disk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(disk.entries.length, 2);
  assert.deepEqual(disk.entries.map((e) => e.account), ["a.near", "b.near"]);
  assert.equal(disk.entries[0].reportedBy, "unspecified");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["bl.json"]);
});

test("a corrupt blocklist is unknown, never an empty list, and a report refuses to overwrite it", async () => {
  const file = path.join(tmp(), "bl.json");
  for (const bad of ["{not json", '{"entries": "no"}', JSON.stringify({ entries: [{ account: TO, reason: "x", evidence: "", reportedBy: "a", reportedAt: "t" }] })]) {
    fs.writeFileSync(file, bad);
    const b = loadBlocklist(file);
    assert.ok(b.error, bad);
    const r = await assess(makeChain({ accounts: { [TO]: old } }), { blocklist: b });
    assert.equal(sig(r, "blocklist").status, "unknown");
    assert.equal(r.verdict, "warn");
    assert.throws(() => addReport({ file, account: "a.near", reason: "r", evidence: "https://x.test/1" }), /nothing was written/);
    assert.equal(fs.readFileSync(file, "utf8"), bad, "the bad file was left alone");
  }
});

test("a bare array and a BOM are accepted when reading", () => {
  const file = path.join(tmp(), "bl.json");
  fs.writeFileSync(file, `﻿${JSON.stringify([{ account: "a.near", reason: "r", evidence: "https://x.test/1", reportedBy: "x", reportedAt: "t" }])}`);
  assert.equal(loadBlocklist(file).entries.length, 1);
});

test("no blocklist given is unknown", async () => {
  const r = await assess(makeChain({ accounts: { [TO]: old } }), { blocklist: undefined });
  assert.equal(sig(r, "blocklist").status, "unknown");
});

test("evidence shape: a URL or a transaction hash is recognised, anything else is only noted", () => {
  assert.ok(looksLikeEvidence("https://nearblocks.io/txns/9xK"));
  assert.ok(looksLikeEvidence("4WHGvHmt9MA6PiMAdkjNe76gkooaWwYJjqoEmZq65itT"));
  assert.ok(!looksLikeEvidence("trust me"));
});

// ---- 5. the vault's own policy ------------------------------------------------------------------------------------------

test("an enforced vault allowlist blocks a recipient that is not on it; unreadable is unknown", async () => {
  const accounts = { [TO]: old };
  const blocked = await assess(makeChain({ accounts, policy: { enforced: true, accounts: ["x.near"] } }));
  assert.equal(blocked.verdict, "block");
  const onList = await assess(makeChain({ accounts, policy: { enforced: true, accounts: [TO] } }));
  assert.equal(onList.verdict, "allow");
  const unreadable = await assess(makeChain({ accounts, viewFails: true }));
  assert.equal(sig(unreadable, "vault-policy").status, "unknown");
  assert.equal(unreadable.verdict, "warn");
});

// ---- verdict, exit codes, output -------------------------------------------------------------------------------------------

test("exit codes: 0 allow, 1 block, 3 warn or mostly unknown", async () => {
  const accounts = { [TO]: old };
  assert.equal((await assess(makeChain({ accounts }))).exitCode, 0);
  assert.equal((await assess(makeChain({ accounts }), { history: [] })).exitCode, 3);
  assert.equal((await assess(makeChain())).exitCode, 1);
  assert.equal(exitCodeOf({ verdict: "allow", unknownDominated: true }), 3, "mostly-unread is never exit 0");
  assert.equal(exitCodeOf({ verdict: "block", unknownDominated: true }), 1);
});

test("a result with everything read and nothing wrong is the only allow", async () => {
  const r = await assess(makeChain({ accounts: { [TO]: old } }));
  assert.equal(r.verdict, "allow");
  assert.equal(r.unknownCount, 0);
  assert.ok(r.signals.every((s) => s.status === "known" && s.source));
  assert.equal(r.signals.length, 6);
});

test("the printed report names every signal's source and whether it was known or unknown", async () => {
  const r = await assess(makeChain({ accounts: { [TO]: old } }), { history: undefined });
  const out = renderCounterparty(r, { to: TO, vault: VAULT });
  assert.match(out, /VERDICT: WARN/);
  assert.match(out, /1 of 6 signals UNKNOWN/);
  for (const s of r.signals) {
    assert.ok(out.includes(`[${s.status.toUpperCase().padEnd(7)}] ${s.name}`), s.name);
    assert.ok(out.includes(`source: ${s.source}`), s.name);
  }
  assert.match(out, /ADVISORY ONLY/);
});

test("the legacy API still answers as before", async () => {
  const { checkCounterparty } = await import("../src/counterparty.mjs");
  const rpc = { account: async () => ({ code_hash: NO_CODE }), view: async () => ({ enforced: false, accounts: [] }) };
  assert.equal((await checkCounterparty({ rpc, vault: VAULT, to: TO, history: new Set([TO]) })).verdict, "allow");
});

// ---- command line -------------------------------------------------------------------------------------------------------------

test("account id syntax", () => {
  for (const ok of ["a.near", "shop.test.near", "supplier.kaigen-funder-a00266.testnet", "0x" + "a".repeat(40), "f".repeat(64)]) assert.ok(isAccountId(ok), ok);
  for (const bad of ["", "a", "A.near", "a..near", "-a.near", "a b.near", "a".repeat(65) + ".near", "x;rm.near"]) assert.ok(!isAccountId(bad), bad);
});

test("counterparty arguments: two accounts, known options only", () => {
  assert.deepEqual(parseCounterpartyArgs([VAULT, TO]), { vault: VAULT, to: TO, rpc: undefined, archival: undefined, history: undefined, json: false });
  assert.equal(parseCounterpartyArgs([VAULT, TO, "--rpc", "http://x", "--json"]).rpc, "http://x");
  for (const bad of [[], [VAULT], [VAULT, TO, "extra.near"], [VAULT, "Bad Name"], [VAULT, TO, "--nope"], [VAULT, TO, "--rpc"], [VAULT, TO, "--rpc", "a", "--rpc", "b"], [VAULT, TO, "--history", path.join(tmp(), "missing.json")]]) {
    assert.throws(() => parseCounterpartyArgs(bad), CounterpartyUsage, JSON.stringify(bad));
  }
  const file = path.join(tmp(), "h.json");
  fs.writeFileSync(file, '{"not": "an array"}');
  assert.throws(() => parseCounterpartyArgs([VAULT, TO, "--history", file]), /JSON array/);
  fs.writeFileSync(file, `["${TO}"]`);
  assert.deepEqual(parseCounterpartyArgs([VAULT, TO, "--history", file]).history, [TO]);
});

test("counterparty-report arguments require a reason and evidence", () => {
  assert.deepEqual(parseReportArgs([TO, "--reason", "scam", "--evidence", "https://x.test/1", "--by", "me"]), { account: TO, reason: "scam", evidence: "https://x.test/1", reportedBy: "me" });
  for (const bad of [[], [TO], [TO, "--reason", "scam"], [TO, "--evidence", "https://x.test/1"], [TO, "--reason", "scam", "--evidence", "  "], ["Bad Name", "--reason", "r", "--evidence", "e"], [TO, "--reason", "r", "--evidence", "e", "--zzz", "1"]]) {
    assert.throws(() => parseReportArgs(bad), CounterpartyUsage, JSON.stringify(bad));
  }
});

/** Runs the real bin.mjs as a child process, so the exit code is the one a shell sees. */
const run = (args, env) =>
  new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, KAIGEN_DEPLOYMENTS: path.join(tmp(), "none.json"), ...env }, timeout: 60_000 }, (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }));
  });

/** The fake chain as a local HTTP JSON-RPC server. */
async function serve(chain) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const { method, params } = JSON.parse(body);
      const r = chain.handle(method, params);
      res.writeHead(r.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: "kaigen", ...r.body }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test("the command line: exit 0 allow, 3 warn, 1 block (listed or missing), 2 usage; report then check", async () => {
  const chain = makeChain({ accounts: { [TO]: old, "newbie.test.near": { created: HEAD - 600 } } });
  const srv = await serve(chain);
  const dir = tmp();
  const env = { KAIGEN_BLOCKLIST: path.join(dir, "bl.json"), KAIGEN_DATA: dir };
  const history = path.join(dir, "paid.json");
  fs.writeFileSync(history, JSON.stringify([TO, "newbie.test.near"]));
  try {
    const allow = await run(["counterparty", VAULT, TO, "--rpc", srv.url, "--history", history], env);
    assert.equal(allow.code, 0, allow.stdout + allow.stderr);
    assert.match(allow.stdout, /VERDICT: ALLOW/);
    assert.equal((allow.stdout.match(/\[KNOWN {2}\]/g) ?? []).length, 6);

    const unknown = await run(["counterparty", VAULT, TO, "--rpc", srv.url], env);
    assert.equal(unknown.code, 3);
    assert.match(unknown.stdout, /\[UNKNOWN\] past payments/);

    const young = await run(["counterparty", VAULT, "newbie.test.near", "--rpc", srv.url, "--history", history], env);
    assert.equal(young.code, 3);
    assert.match(young.stdout, /only 0\.2 hours old/);

    const ghost = await run(["counterparty", VAULT, "ghost.test.near", "--rpc", srv.url, "--history", history], env);
    assert.equal(ghost.code, 1);
    assert.match(ghost.stdout, /VERDICT: BLOCK/);

    const noEvidence = await run(["counterparty-report", TO, "--reason", "scam"], env);
    assert.equal(noEvidence.code, 2);
    assert.match(noEvidence.stderr, /--evidence is required/);
    assert.ok(!fs.existsSync(env.KAIGEN_BLOCKLIST));

    const reported = await run(["counterparty-report", TO, "--reason", "drained agents", "--evidence", "https://example.org/r/1", "--by", "tester"], env);
    assert.equal(reported.code, 0, reported.stderr);
    assert.equal(JSON.parse(fs.readFileSync(env.KAIGEN_BLOCKLIST, "utf8")).entries[0].reportedBy, "tester");

    const listed = await run(["counterparty", VAULT, TO, "--rpc", srv.url, "--history", history], env);
    assert.equal(listed.code, 1);
    assert.match(listed.stdout, /drained agents \(evidence: https:\/\/example\.org\/r\/1\)/);

    const noteOnly = await run(["counterparty-report", "other.test.near", "--reason", "odd", "--evidence", "trust me"], env);
    assert.equal(noteOnly.code, 0);
    assert.match(noteOnly.stderr, /neither an http\(s\) URL nor a transaction hash/);

    for (const bad of [["counterparty"], ["counterparty", VAULT], ["counterparty", VAULT, TO, "--bogus"], ["counterparty-report"]]) {
      const r = await run(bad, env);
      assert.equal(r.code, 2, JSON.stringify(bad));
      assert.match(r.stderr, /usage: kaigen-jobs counterparty/);
    }
  } finally {
    await srv.close();
  }
});
