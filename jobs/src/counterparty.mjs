// Agent-side guard: the check an AI agent runs before it signs a payment, and the wrapper that refuses to
// sign when the answer is "block" or a human says no to a "warn".
//
// This is the first line. The vault (Mamori) is the last: even if an agent ignores every verdict here, its
// access key can only send within the 24 hour limit, to allowed recipients if the policy is on, and anything
// larger waits in a queue the admin can cancel. Both layers are needed: this one saves gas and tells the
// human why; the contract is the one that cannot be talked out of it.
//
// ADVISORY ONLY. Nothing in this file is read by the vault, and the vault's on-chain enforcement (allowlist, 24 h cap,
// delay queue, strikes) does not depend on it. A wrong answer here costs a wasted gas fee or a missed warning, never
// the vault's loss bound. Full write-up: docs/v3/COUNTERPARTY.md.
//
// DATA SOURCES of `assessCounterparty` (the full check; `checkCounterparty` below is the original, smaller one).
// Every signal comes back "known" (read from the source named) or "unknown" (could not be read, and then it counts as
// a warning, never as a pass). Nothing is guessed. Every read is a JSON-RPC read through jobs/src/rpc.mjs: no signing,
// no writes. The only write anywhere is `counterparty-report`, which appends to a local file.
//
//  signal         source                                             how                                          limits
//  -------------  -------------------------------------------------  -------------------------------------------  ------------------------------------------------------------
//  account age    view_account at past block heights + block header  read a block just older than the threshold,   Only reaches back as far as the RPC node keeps state: a normal
//                 timestamps                                         then step back by doubling and halve, to the  node keeps about a day and a half on testnet (5 epochs; 34.8 h measured); an archival node (--archival)
//                                                                    first block with the account (60 s budget)    reaches further but has gaps and rate limits (429). Beyond that: "at least X", never a guessed age.
//                                                                                                                 An account deleted and re-created is dated from the last
//                                                                                                                 creation the search lands on. Threshold: warn under 168 h.
//  contract?      view_account at the latest final block:            code_hash is 1111... for no contract;        A contract is a warning, not a block (a token or a shop
//                 code_hash, global_contract_hash/_account_id        a global contract has no code_hash of its    contract is a legitimate payee). A missing named account blocks.
//                                                                    own, so those fields count too
//  code change    view_account at the latest block and at a block    compare the code identity at the two          Window 24 h, found by estimating from block time and refined to
//                 about 24 h earlier                                 blocks; a change is a warning only           within 15 minutes; the real window is printed. Needs the node to
//                                                                                                                 still hold that block (a normal node does). A change that was
//                                                                                                                 made and reverted inside the window is not seen. Never a block.
//  past payments  (1) the agent's own record, passed in as           the recipient is in the record or it is not  The vault's history is NOT readable over JSON-RPC: the methods
//                 `history`; (2) the vault's own events: NOT         ("warn: first payment" when it is not)       rpc.mjs wraps have no "list receipts/logs of an account" call, and
//                 readable, so reported "unknown" without (1)                                                     Mamori has no receipts() view by design (docs/v3/ATTEST-CHECK.md 5).
//                                                                                                                 So the record is only as complete as the agent keeps it.
//  blocklist      a local JSON file, KAIGEN_BLOCKLIST, default       an exact account match; each entry carries   "Shared" means every agent pointed at the same file. No signatures,
//                 data/blocklist.json (gitignored)                   reason, evidence, reporter, time             no registry contract: anyone who can write the file can add (or
//                                                                                                                 delete) an entry, and a listing is a claim, not a proof. The
//                                                                                                                 file ships EMPTY. A missing file is "no reports"; an unreadable
//                                                                                                                 or malformed file is "unknown", never an empty list.
//  vault policy   call_function `allowlist` on the vault             allowlist enforced and recipient not on it   Only meaningful for a Mamori vault; any other account is "unknown".
//                                                                    is a block
//
// The only built-in blocklist entry in the project is the SAMPLE passed in jobs/src/demo.mjs for the attack demo
// ("reported for draining agent vaults"). It is a scripted sample for that demo, not a real report, and it is never
// written to the blocklist file.
import fs from "node:fs";
import path from "node:path";

const NO_CODE = "11111111111111111111111111111111";
const IMPLICIT = /^[0-9a-f]{64}$/;

/** @typedef {{ verdict: "allow" | "warn" | "block", reasons: { level: "info" | "warn" | "block", text: string }[] }} Verdict */

/**
 * @param rpc        from makeRpc
 * @param vault      the vault the agent pays from (its allowlist is read from the chain)
 * @param to         the recipient account
 * @param blocklist  Map<account, evidence> shared among agents; entries carry the reason they were reported
 * @param history    Set of recipients this agent has paid before
 * @returns Verdict. Every signal that was not checked says so: "could not check" is a warning, never a pass.
 */
export async function checkCounterparty({ rpc, vault, to, blocklist = new Map(), history = new Set() }) {
  const reasons = [];
  const add = (level, text) => reasons.push({ level, text });

  if (blocklist.has(to)) add("block", `reported as bad: ${blocklist.get(to)}`);

  let account;
  try {
    account = await rpc.account(to);
  } catch (e) {
    add("warn", `could not read the recipient account (${e.message ?? e})`);
  }
  if (account === null) {
    // An unfunded implicit account is a normal first payment; a named account that does not exist cannot receive.
    if (IMPLICIT.test(to)) add("warn", "this implicit account has never been funded");
    else add("block", "this account does not exist, so the transfer would fail");
  } else if (account) {
    const isContract = account.code_hash !== NO_CODE || Boolean(account.global_contract_hash);
    if (isContract) add("warn", "the recipient is a contract, not a person's account");
  }

  try {
    const policy = await rpc.view(vault, "allowlist");
    if (policy.enforced && !policy.accounts.includes(to)) add("block", "the vault only pays allowlisted recipients and this is not one");
    else if (!policy.enforced) add("info", "the vault has no recipient allowlist switched on");
  } catch (e) {
    add("warn", `could not read the vault's allowlist (${e.message ?? e})`);
  }

  if (!history.has(to)) add("warn", "this agent has never paid this recipient before");

  const verdict = reasons.some((r) => r.level === "block") ? "block" : reasons.some((r) => r.level === "warn") ? "warn" : "allow";
  return { verdict, reasons };
}

/**
 * Signs only if the verdict allows it. On "block" nothing is signed. On "warn" a human decides.
 * @param send     () => Promise<string>, signs and sends, returns the tx hash
 * @param confirm  (verdict) => Promise<boolean>, asks a human; absent means "no"
 */
export async function guardedSend({ check, send, confirm = async () => false, log = () => {} }) {
  const v = await check();
  log({ step: "check", verdict: v.verdict, reasons: v.reasons.map((r) => `${r.level}: ${r.text}`) });
  if (v.verdict === "block") return { sent: false, verdict: v.verdict, reasons: v.reasons };
  if (v.verdict === "warn" && !(await confirm(v))) return { sent: false, verdict: v.verdict, reasons: v.reasons, declined: true };
  const hash = await send();
  log({ step: "sent", hash });
  return { sent: true, verdict: v.verdict, reasons: v.reasons, hash };
}

// ---- the full check: five signals, each known or unknown ----------------------------------------------------------

/** Warn when the account is younger than this. A choice, not a standard: a week is long enough that a throwaway account made for one scam has usually been reported. */
export const MIN_AGE_HOURS = 7 * 24;
/** Warn when the recipient's code changed over this window. */
export const CODE_CHANGE_HOURS = 24;
/** The window is found by estimate and is accepted when its block is this close to the target. */
const WINDOW_TOLERANCE_S = 900;
/** Heights with no block (skipped) are stepped over, at most this far either side. */
const SKIP_REACH = 6;
/** The search steps back from the head by this many heights first (a few hours of blocks), then doubles. */
const GALLOP_START = 20_000;
const MAX_PROBES = 80;
/** The age search stops after this long and reports what it has: a node that errors slowly on old heights must not hold a payment for minutes. */
const SEARCH_BUDGET_MS = 60_000;
const HOUR_NS = 3_600_000_000_000n;
const SECOND_NS = 1_000_000_000n;

const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
/** NEAR account syntax: 2 to 64 characters, or a 0x + 40 hex Ethereum-style implicit account. */
export const isAccountId = (s) => typeof s === "string" && ((s.length >= 2 && s.length <= 64 && ACCOUNT_ID.test(s)) || /^0x[0-9a-f]{40}$/.test(s));

const causeName = (e) => e?.data?.cause?.name ?? "";
const garbageCollected = (e) => causeName(e) === "GARBAGE_COLLECTED_BLOCK" || /garbage collected/i.test(String(e?.message ?? e));
const unknownBlock = (e) => causeName(e) === "UNKNOWN_BLOCK" || /DB Not Found Error: BLOCK/i.test(String(e?.message ?? e));

const isoOf = (ns) => new Date(Number(ns / 1_000_000n)).toISOString();
const hoursOf = (ns) => Number(ns) / Number(HOUR_NS);
/** "5.2 hours" under two days, else "12.3 days". */
function span(ns) {
  const h = hoursOf(ns);
  return h < 48 ? `${h.toFixed(1)} hours` : `${(h / 24).toFixed(1)} days`;
}

/** { height, tsNs } of a block: "final" or a height. Throws what the node throws. */
async function blockAt(rpc, at) {
  const b = await rpc.call("block", at === "final" ? { finality: "final" } : { block_id: at });
  return { height: Number(b.header.height), tsNs: BigInt(b.header.timestamp_nanosec) };
}

/**
 * "exists" | "absent" | "unreadable" | "skipped" at one height. "unreadable" is state this node no longer has (garbage
 * collected) or a 5xx that survived the retries (an archival node answers some old heights that way); "skipped" is a height
 * with no block. Anything else throws, a 429 included: a rate limit says nothing about the height.
 */
async function stateAt(rpc, id, height) {
  try {
    return (await rpc.account(id, height)) ? "exists" : "absent";
  } catch (e) {
    if (garbageCollected(e) || /^HTTP 5\d\d$/.test(e?.message ?? "")) return "unreadable";
    if (unknownBlock(e)) return "skipped";
    throw e;
  }
}

/** The first height at or around `want` (0, +1, -1, +2, ...) that has a block, strictly inside (lo, hi); null if none. */
async function probeNear(rpc, id, want, lo, hi) {
  for (let k = 0; k <= SKIP_REACH; k++) {
    for (const h of k === 0 ? [want] : [want + k, want - k]) {
      if (h <= lo || h >= hi) continue;
      const state = await stateAt(rpc, id, h);
      if (state !== "skipped") return { height: h, state };
    }
  }
  return null;
}

/**
 * When the account first showed up, by `view_account` at past heights. `head` is { height, tsNs } of the latest block, where
 * the account exists. `threshold` (optional) is a real block { height, tsNs } as old as the age the caller cares about: it is
 * read first, so that an old account is known to be old after one read, whatever happens to the rest of the search. Then:
 * step back from the head by doubling distances until a block where the account is absent (or one the node cannot read) is
 * found, and halve the gap. Result kinds:
 *   exact      the account is absent at a block just before `height` and present at it: `height` is its first block
 *   at-least   the block before could not be read, or the search was cut short (`interrupted` says why): the account existed
 *              at `height` and may be older, so the date is a lower bound
 * Searching back from the head, not from the genesis, keeps the reads inside the stretch of history the node serves.
 */
export async function firstSeen({ rpc, id, head, threshold, budgetMs = SEARCH_BUDGET_MS }) {
  const deadline = Date.now() + budgetMs;
  let probes = 0;
  const step = () => {
    if (++probes > MAX_PROBES) throw new Error(`gave up after ${MAX_PROBES} reads`);
    if (Date.now() > deadline) throw new Error(`gave up after ${budgetMs / 1000} s of reading old blocks`);
  };
  // The search assumes "present at the head"; a node a block behind the one that answered earlier would break that quietly.
  if ((await stateAt(rpc, id, head.height)) !== "exists") throw new Error("the account is not visible at this node's latest block");
  // The oldest block seen to have the account, with its time: the answer if the rest of the search fails.
  let proof = head;
  let hi = head.height;
  let low;
  if (threshold && threshold.height < head.height) {
    const s = await stateAt(rpc, id, threshold.height);
    if (s === "exists") {
      proof = threshold;
      hi = threshold.height;
    } else low = { height: threshold.height, state: s === "skipped" ? "unreadable" : s };
  }
  try {
    for (let offset = threshold && proof === threshold ? 2 * (head.height - threshold.height) : GALLOP_START; !low; offset *= 2) {
      step();
      const want = Math.max(1, head.height - offset);
      const p = await probeNear(rpc, id, want, 0, hi);
      if (!p) low = { height: want, state: "unreadable" };
      else if (p.state === "exists") hi = p.height;
      else low = p;
    }
    while (hi - low.height > 1) {
      step();
      const mid = low.height + Math.floor((hi - low.height) / 2);
      const p = await probeNear(rpc, id, mid, low.height, hi);
      if (!p) {
        // Only heights without blocks are left between the two ends (adjacent blocks), or a stretch the node has no blocks for.
        if (hi - low.height <= 2 * SKIP_REACH + 1) break;
        low = { height: mid, state: "unreadable" };
      } else if (p.state === "exists") hi = p.height;
      else low = p;
    }
    const tsNs = hi === proof.height ? proof.tsNs : (await blockAt(rpc, hi)).tsNs;
    return { kind: low.state === "absent" ? "exact" : "at-least", height: hi, tsNs, before: low.height };
  } catch (e) {
    if (proof === head) throw e;
    return { kind: "at-least", height: proof.height, tsNs: proof.tsNs, interrupted: why(e) };
  }
}

/** A block about `target` ns, found by estimating from the block rate and correcting; returns { height, tsNs }. */
async function blockNear(rpc, head, targetNs) {
  let height = Math.max(1, head.height - Number((head.tsNs - targetNs) / SECOND_NS));
  let best;
  for (let i = 0; i < 5; i++) {
    let b;
    for (let k = 0; k <= SKIP_REACH && !b; k++) {
      try {
        b = await blockAt(rpc, height + k);
      } catch (e) {
        if (!unknownBlock(e)) throw e;
      }
    }
    if (!b) throw new Error(`no block near height ${height}`);
    best = b;
    const errS = Number((b.tsNs - targetNs) / SECOND_NS);
    if (Math.abs(errS) <= WINDOW_TOLERANCE_S) break;
    const spanS = Number((head.tsNs - b.tsNs) / SECOND_NS);
    const rate = spanS > 0 ? (head.height - b.height) / spanS : 1;
    height = Math.max(1, b.height - Math.round(errS * rate));
  }
  return best;
}

const codeIdOf = (a) => [a.code_hash, a.global_contract_hash ?? "", a.global_contract_account_id ?? ""].join("|");
const isContractAccount = (a) => a.code_hash !== NO_CODE || Boolean(a.global_contract_hash) || Boolean(a.global_contract_account_id);
const describeCode = (a) => (!a ? "no account" : !isContractAccount(a) ? "no contract" : a.global_contract_hash ? `global contract ${a.global_contract_hash}` : a.global_contract_account_id ? `global contract of ${a.global_contract_account_id}` : `code ${a.code_hash}`);
const why = (e) => String(e?.message ?? e).split("\n")[0].slice(0, 200);

/** A signal: what was read, from where, and what it means. */
const signal = (id, name, status, source, reasons) => ({ id, name, status, source, reasons });
const unknown = (id, name, source, text) => signal(id, name, "unknown", source, [{ level: "warn", text }]);

/** Blocklist entries are all-or-nothing: one malformed entry makes the file unreadable rather than silently skipping a listing. */
function readEntries(parsed) {
  const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
  if (!Array.isArray(entries)) throw new Error('expected {"entries": [...]}');
  entries.forEach((e, i) => {
    const bad = ["account", "reason", "evidence", "reportedBy", "reportedAt"].find((k) => typeof e?.[k] !== "string" || e[k].trim() === "");
    if (bad) throw new Error(`entry ${i} has no ${bad}`);
  });
  return entries;
}

/** { file, entries } or { file, entries: [], error }. A missing file is an empty list (nothing reported); an unreadable one is not. */
export function loadBlocklist(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { file, entries: [], missing: true };
    return { file, entries: [], error: `cannot read ${file}: ${e.code ?? why(e)}` };
  }
  try {
    return { file, entries: readEntries(JSON.parse(text.replace(/^﻿/, ""))) };
  } catch (e) {
    return { file, entries: [], error: `${file} is not a valid blocklist (${why(e)})` };
  }
}

export class CounterpartyUsage extends Error {}

/**
 * Appends one report to the blocklist file and returns the entry. The evidence (a URL or a transaction hash) is required.
 * A corrupt existing file is refused, not overwritten. The write is a temp file renamed over the old one; two reports at the
 * same instant can still lose one (read, then write), which a single-writer CLI accepts.
 */
export function addReport({ file, account, reason, evidence, reportedBy, now = new Date() }) {
  if (!isAccountId(account)) throw new CounterpartyUsage(`${JSON.stringify(account)} is not a NEAR account id`);
  if (typeof reason !== "string" || reason.trim() === "") throw new CounterpartyUsage("--reason is required: say what the account did");
  if (typeof evidence !== "string" || evidence.trim() === "") throw new CounterpartyUsage("--evidence is required: a URL or a transaction hash that shows it");
  const current = loadBlocklist(file);
  if (current.error) throw new Error(`${current.error}; fix or move it, nothing was written`);
  const entry = { account, reason: reason.trim(), evidence: evidence.trim(), reportedBy: (reportedBy ?? "").trim() || "unspecified", reportedAt: now.toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, entries: [...current.entries, entry] }, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return entry;
}

/** A URL or a 43/44-character base58 transaction hash. Anything else is stored as given, with a warning to the reporter. */
export const looksLikeEvidence = (s) => /^https?:\/\/\S+$/.test(s.trim()) || /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(s.trim());

const SRC = {
  age: (via) => `JSON-RPC query view_account at past block heights, stepping back then halving, plus block headers (${via})`,
  contract: "JSON-RPC query view_account (code_hash, global_contract_hash) at the latest final block",
  code: (via, h) => `JSON-RPC query view_account at the latest block and at a block about ${h} h earlier (${via})`,
  interactions: (given) => (given ? "the agent's own payment record (passed in)" : "the vault's payment history: not readable over JSON-RPC; no agent record was given"),
  blocklist: (b) => (b ? `local blocklist file ${b.file}` : "no blocklist file was given"),
  policy: "JSON-RPC call_function `allowlist` on the vault",
};

function ageSignal({ firstSeenResult: r, head, minAgeHours, via }) {
  const source = SRC.age(via);
  const age = head.tsNs - r.tsNs;
  const where = `block ${r.height}, ${isoOf(r.tsNs)}`;
  if (r.kind === "exact") {
    const young = age < BigInt(Math.round(minAgeHours * 3600)) * SECOND_NS;
    return signal("age", "account age", "known", source, [
      young
        ? { level: "warn", text: `the account is only ${span(age)} old (first seen at ${where}); accounts younger than ${minAgeHours} hours get a warning` }
        : { level: "info", text: `the account is ${span(age)} old (first seen at ${where})` },
    ]);
  }
  // The oldest readable block already has it: all we know is a lower bound.
  if (age >= BigInt(Math.round(minAgeHours * 3600)) * SECOND_NS) return signal("age", "account age", "known", source, [{ level: "info", text: `the account is at least ${span(age)} old (it already existed at ${where}, ${r.interrupted ? `the search for the exact date stopped: ${r.interrupted}` : "the oldest block this node would answer for"}); the exact age is not known` }]);
  return signal("age", "account age", "unknown", source, [
    { level: "warn", text: `account age unknown: it already existed at ${where}, ${r.interrupted ? `where the search stopped (${r.interrupted})` : "the oldest block this node would answer for"}, so it is at least ${span(age)} old, which cannot show it is past the ${minAgeHours} hour threshold. Use an archival node (--archival) for the exact age` },
  ]);
}

/**
 * The full counterparty check. Read-only. Resolves with
 *   { verdict, reasons, signals, head, exitCode, unknownDominated, thresholds }
 * where every signal says whether it was "known" or "unknown", from what source, and why it says what it says.
 *
 * @param rpc       from makeRpc: the node used for the current state, the vault's policy and the block head
 * @param archival  a node that still holds old state (defaults to rpc): used for the age and the code-change window
 * @param vault     the vault the agent pays from
 * @param to        the recipient account
 * @param history   the accounts this agent has paid before (Array or Set), or undefined when it has no record: then "past payments" is unknown
 * @param blocklist the result of loadBlocklist; undefined means none was given (unknown)
 * @param searchBudgetMs how long the age search may read old blocks before it gives up (then the age is unknown)
 */
export async function assessCounterparty({ rpc, archival = rpc, vault, to, history, blocklist, minAgeHours = MIN_AGE_HOURS, codeChangeHours = CODE_CHANGE_HOURS, searchBudgetMs = SEARCH_BUDGET_MS }) {
  const signals = [];
  const via = archival === rpc ? "the same node as the other reads" : "the archival node";

  // The recipient at the latest final block: does it exist, is it a contract.
  let account;
  let accountError;
  try {
    account = await rpc.account(to);
  } catch (e) {
    accountError = why(e);
  }
  const contractSource = SRC.contract;
  const contract =
    accountError !== undefined
      ? unknown("contract", "contract or not", contractSource, `could not read the recipient account (${accountError})`)
      : account === null
        ? signal("contract", "contract or not", "known", contractSource, [
            IMPLICIT.test(to)
              ? { level: "warn", text: "this implicit account has never been funded" }
              : { level: "block", text: "this account does not exist, so the transfer would fail" },
          ])
        : signal("contract", "contract or not", "known", contractSource, [
            isContractAccount(account) ? { level: "warn", text: `the recipient is a contract, not a person's account (${describeCode(account)})` } : { level: "info", text: "the recipient is a plain account with no contract code" },
          ]);

  // Block head for the two history reads.
  let head;
  let headError;
  if (accountError === undefined) {
    try {
      head = await blockAt(archival, "final");
    } catch (e) {
      headError = why(e);
    }
  }
  const needsHistory = (id, name, source) => {
    if (accountError !== undefined) return unknown(id, name, source, `${name} unknown: the recipient account could not be read`);
    if (account === null) return signal(id, name, "known", source, [{ level: "info", text: "the account does not exist at the latest block, so there is no history to read" }]);
    if (headError !== undefined) return unknown(id, name, source, `${name} unknown: could not read the latest block (${headError})`);
    return null;
  };

  // 1. Account age.
  const ageSource = SRC.age(via);
  let age = needsHistory("age", "account age", ageSource);
  if (!age) {
    try {
      // A block just older than the threshold is read first (a block time estimate, then one read), so an old account is known to be old even if the exact search is cut short.
      let threshold;
      try {
        threshold = await blockNear(archival, head, head.tsNs - BigInt(Math.round(minAgeHours * 3600) + 2 * WINDOW_TOLERANCE_S) * SECOND_NS);
      } catch {
        // The search runs without it.
      }
      age = ageSignal({ firstSeenResult: await firstSeen({ rpc: archival, id: to, head, threshold, budgetMs: searchBudgetMs }), head, minAgeHours, via });
    } catch (e) {
      age = unknown("age", "account age", ageSource, `account age unknown: ${why(e)}`);
    }
  }

  // 2. Code change over the window.
  const codeSource = SRC.code(via, codeChangeHours);
  let code = needsHistory("code-change", "code change", codeSource);
  if (!code) {
    try {
      const earlier = await blockNear(archival, head, head.tsNs - BigInt(Math.round(codeChangeHours * 3600)) * SECOND_NS);
      const now = await archival.account(to, head.height);
      const then = await archival.account(to, earlier.height);
      const window = span(head.tsNs - earlier.tsNs);
      let level = "info";
      let text;
      if (!now) throw new Error("the account is gone at the head block");
      if (!then) {
        level = isContractAccount(now) ? "warn" : "info";
        text = `the account did not exist ${window} ago (it was created inside the window): ${isContractAccount(now) ? `it now holds ${describeCode(now)}, deployed within ${window}` : "it holds no contract"}`;
      } else if (codeIdOf(now) !== codeIdOf(then)) {
        level = "warn";
        text = `the recipient's code changed within the last ${window}: ${describeCode(then)} -> ${describeCode(now)}`;
      } else text = isContractAccount(now) ? `the code did not change over the last ${window} (${describeCode(now)})` : `no contract code now or ${window} ago`;
      code = signal("code-change", "code change", "known", codeSource, [{ level, text }]);
    } catch (e) {
      const old = garbageCollected(e) ? ": the node no longer holds state that far back (use --archival)" : "";
      code = unknown("code-change", "code change", codeSource, `code change unknown: ${why(e)}${old}`);
    }
  }

  // 3. Past payments by this agent to the receiver.
  const record = history === undefined ? undefined : new Set(history);
  const paid = record?.has(to);
  const interactions =
    record === undefined
      ? unknown("interactions", "past payments", SRC.interactions(false), "past payments unknown: the vault's history cannot be read over JSON-RPC (it has no call that lists an account's receipts or logs, and Mamori keeps no receipts() view), and this agent gave no record of its own")
      : signal("interactions", "past payments", "known", SRC.interactions(true), [paid ? { level: "info", text: "this agent has paid this recipient before" } : { level: "warn", text: "first payment: this agent has never paid this recipient before" }]);

  // 4. Shared blocklist.
  const bsrc = SRC.blocklist(blocklist);
  let list;
  if (!blocklist) list = unknown("blocklist", "blocklist", bsrc, "blocklist unknown: no blocklist file was consulted");
  else if (blocklist.error) list = unknown("blocklist", "blocklist", bsrc, `blocklist unknown: ${blocklist.error}`);
  else {
    const hits = blocklist.entries.filter((e) => e.account === to);
    const shown = hits.slice(0, 3).map((e) => ({ level: "block", text: `reported as bad on ${e.reportedAt} by ${e.reportedBy}: ${e.reason} (evidence: ${e.evidence})` }));
    if (hits.length > 3) shown.push({ level: "block", text: `and ${hits.length - 3} more report(s) of this account in ${blocklist.file}` });
    list = signal("blocklist", "blocklist", "known", bsrc, hits.length > 0 ? shown : [{ level: "info", text: `not on the blocklist (${blocklist.entries.length} report(s) in ${blocklist.file}${blocklist.missing ? ", the file does not exist yet, so nothing has been reported" : ""})` }]);
  }

  // 5. The vault's own allowlist (also advisory here: the contract enforces it again when the payment runs).
  let policy;
  try {
    const p = await rpc.view(vault, "allowlist");
    policy = signal("vault-policy", "vault allowlist", "known", SRC.policy, [
      p.enforced && !p.accounts.includes(to)
        ? { level: "block", text: "the vault only pays allowlisted recipients and this is not one" }
        : p.enforced
          ? { level: "info", text: "the recipient is on the vault's enforced allowlist" }
          : { level: "info", text: "the vault has no recipient allowlist switched on" },
    ]);
  } catch (e) {
    policy = unknown("vault-policy", "vault allowlist", SRC.policy, `could not read the vault's allowlist (${why(e)})`);
  }

  signals.push(age, contract, code, interactions, list, policy);
  const reasons = signals.flatMap((s) => s.reasons.map((r) => ({ ...r, signal: s.id, status: s.status })));
  const verdict = reasons.some((r) => r.level === "block") ? "block" : reasons.some((r) => r.level === "warn") ? "warn" : "allow";
  const unknownCount = signals.filter((s) => s.status === "unknown").length;
  const result = {
    verdict,
    reasons,
    signals,
    head: head ? { height: head.height, time: isoOf(head.tsNs) } : null,
    thresholds: { minAgeHours, codeChangeHours },
    unknownCount,
    unknownDominated: unknownCount > signals.length - unknownCount,
  };
  return { ...result, exitCode: exitCodeOf(result) };
}

/** 0 allow, 1 block, 3 warn or mostly unknown. (2 is usage and never comes from a result.) */
export const exitCodeOf = (result) => (result.verdict === "block" ? 1 : result.verdict === "warn" || result.unknownDominated ? 3 : 0);

export function renderCounterparty(result, { to, vault }) {
  const lines = [`counterparty check: pay ${to} from ${vault}`, result.head ? `read at block ${result.head.height} (${result.head.time})` : "no block head could be read"];
  lines.push(`VERDICT: ${result.verdict.toUpperCase()}${result.unknownCount > 0 ? `   (${result.unknownCount} of ${result.signals.length} signals UNKNOWN: unread counts as a warning, never as a pass)` : ""}`, "");
  for (const s of result.signals) {
    lines.push(`[${s.status.toUpperCase().padEnd(7)}] ${s.name}`, `    source: ${s.source}`);
    for (const r of s.reasons) lines.push(`    ${r.level}: ${r.text}`);
  }
  lines.push("", "ADVISORY ONLY: the vault enforces its limits on chain whatever this says; see docs/v3/COUNTERPARTY.md.");
  return lines.join("\n");
}

// ---- command line --------------------------------------------------------------------------------------------------

export const COUNTERPARTY_USAGE =
  "usage: kaigen-jobs counterparty <vault> <to> [--rpc <url>] [--archival <url>] [--history <file>] [--json]\n" +
  "       kaigen-jobs counterparty-report <account> --reason <text> --evidence <url-or-tx-hash> [--by <name>]\n" +
  "  --rpc       default: KAIGEN_RPC, then `rpc` in deployments.json, then the testnet node when deployments.json says testnet\n" +
  "  --archival  a node with old state, for the exact account age and the code-change window (KAIGEN_ARCHIVAL_RPC, then `archivalRpc` in deployments.json)\n" +
  "  --history   a JSON array of the accounts this agent has paid before; without it \"past payments\" is UNKNOWN\n" +
  "  blocklist   the file in KAIGEN_BLOCKLIST, default data/blocklist.json (ships empty; `counterparty-report` appends to it)\n" +
  "  exit code   0 allow, 1 block, 3 warn or mostly unknown, 2 usage";

function parseFlags(argv, valued, flags = []) {
  const seen = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags.includes(a)) seen[a] = true;
    else if (valued.includes(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new CounterpartyUsage(`${a} needs a value`);
      if (a in seen) throw new CounterpartyUsage(`${a} given twice`);
      seen[a] = v;
    } else if (a.startsWith("--")) throw new CounterpartyUsage(`unknown option ${a}`);
    else positional.push(a);
  }
  return { seen, positional };
}

export function parseCounterpartyArgs(argv) {
  const { seen, positional } = parseFlags(argv, ["--rpc", "--archival", "--history"], ["--json"]);
  if (positional.length !== 2) throw new CounterpartyUsage("give the vault account and the recipient account: counterparty <vault> <to>");
  const [vault, to] = positional;
  for (const [name, id] of [["vault", vault], ["recipient", to]]) if (!isAccountId(id)) throw new CounterpartyUsage(`the ${name} ${JSON.stringify(id)} is not a NEAR account id`);
  let history;
  if (seen["--history"]) {
    try {
      history = JSON.parse(fs.readFileSync(seen["--history"], "utf8").replace(/^﻿/, ""));
    } catch (e) {
      throw new CounterpartyUsage(`cannot read --history ${seen["--history"]}: ${e.code ?? why(e)}`);
    }
    if (!Array.isArray(history) || history.some((x) => typeof x !== "string")) throw new CounterpartyUsage("--history must be a JSON array of account ids");
  }
  return { vault, to, rpc: seen["--rpc"], archival: seen["--archival"], history, json: Boolean(seen["--json"]) };
}

export function parseReportArgs(argv) {
  const { seen, positional } = parseFlags(argv, ["--reason", "--evidence", "--by"]);
  if (positional.length !== 1) throw new CounterpartyUsage("give the account to report: counterparty-report <account> --reason <text> --evidence <url-or-tx-hash>");
  if (!isAccountId(positional[0])) throw new CounterpartyUsage(`${JSON.stringify(positional[0])} is not a NEAR account id`);
  if (!seen["--reason"]?.trim()) throw new CounterpartyUsage("--reason is required: say what the account did");
  if (!seen["--evidence"]?.trim()) throw new CounterpartyUsage("--evidence is required: a URL or a transaction hash that shows it");
  return { account: positional[0], reason: seen["--reason"], evidence: seen["--evidence"], reportedBy: seen["--by"] };
}
