// cage-check (docs/v3/ARCHITECTURE.md section 2.8, milestone M4): is the cage around a Mamori vault intact?
//
// Mamori's loss bound holds only while the account's access keys are what the design says: one ML-DSA full-access
// admin key, and function-call "daily keys" the vault itself records. The contract cannot read the key list, so this
// off-chain checker does, over RPC, and says RED or GREEN per condition. It is READ-ONLY (block, view_account,
// view_access_key_list and view calls; nothing is signed or sent) and it reports one block: a key added a block
// later is not seen.
//
// Condition ids. The docs do not number the red conditions, so the id is the row of the table "Fails (red) if any
// of these hold" in docs/v3/ARCHITECTURE.md section 2.8: ARCH-2.8-1 .. ARCH-2.8-8, in that order. LOSS-BOUND.md
// derives the same list as assumptions A1 (rows 1, 2, 6), A2 (row 7) and A3 (row 3).
//
// attest() (docs/v3/ATTEST-CHECK.md) is read as a cross-check and can only ADD red or unchecked, never turn either
// green: a full-access key can deploy an attest() that lies, so the eight rows still stand on RPC (and, for rows 6
// and 7, on the vault's own views). It adds evidence to two of the eight rows, and two rows of its own that the
// ARCHITECTURE.md table has no row for. Those two are NOT part of the doc's eight and are named ATTEST-1 and
// ATTEST-2 so nobody reads them as such:
//   ARCH-2.8-6  also red for a function-call key on the account that attest().daily_keys does not record
//   ARCH-2.8-7  also red for any key in attest().intents_keys
//   ATTEST-1    attest() agrees with the account and with the vault's own views: it has the shape of section 2.1,
//               answered as the account asked about, and its config, daily_keys, intents_keys and revoked_keys equal
//               what config(), daily_keys(), intents_keys() and revoked_keys() return at the same block
//   ATTEST-2    the vault is a production build: attest().drill_build is false and config.delay_secs is not under
//               min_delay_secs (docs/v3/LOSS-BOUND.md E4: a delay under a day breaks the cap bound)
// With no attest() (a v2 build) ATTEST-1 and ATTEST-2 are UNKNOWN, so such a vault is never GREEN (exit 3).
//
// Exit: 0 all GREEN, 1 at least one RED, 3 nothing RED but something could not be checked (not a clean bill, the
// same meaning as `watch`), 2 bad usage (bin.mjs).
import fs from "node:fs";
import { base58 } from "@scure/base";
import { keyKind } from "./classify.mjs";
import { codeHashOf } from "./verify.mjs";

const NEAR = 10n ** 24n;
/** Mamori's own default allowance for a daily key (DEFAULT_ALLOWANCE, 250 mNEAR): the default "configured maximum". */
export const DEFAULT_MAX_ALLOWANCE_YOCTO = NEAR / 4n;
/** The two methods a daily key may call (DAILY_METHODS in contracts/mamori/src/lib.rs). */
export const DAILY_METHODS = ["send_small", "request_withdraw"];

export const IDS = {
  classicalFullAccess: "ARCH-2.8-1",
  oneMlDsaAdmin: "ARCH-2.8-2",
  allowance: "ARCH-2.8-3",
  methodNames: "ARCH-2.8-4",
  scope: "ARCH-2.8-5",
  unrecorded: "ARCH-2.8-6",
  intentsKey: "ARCH-2.8-7",
  codeHash: "ARCH-2.8-8",
  // Not rows of the ARCHITECTURE.md table: what attest() brings that the table has no row for.
  attestAgrees: "ATTEST-1",
  productionBuild: "ATTEST-2",
};

/** What this check cannot see; printed with every report so a GREEN is not read as more than it is. */
export const LIMITS = [
  "point in time: one final block; a key added after it is not seen",
  "a key added on intents.near without register_intents_key is not visible here (only recorded intents keys are)",
  "attest() is only as honest as the code that answers it: it can add a red, never clear one, and the code hash row is what ties it to the pinned code",
  "the admin is compared by its on-chain spelling; deriving ml-dsa-65-hash from a full public key is not implemented (ARCHITECTURE.md 2.8 gives no hashing rule)",
];

const ZERO_HASH = "11111111111111111111111111111111";
const RED = "RED";
const GREEN = "GREEN";
const UNKNOWN = "UNKNOWN";

// ---- reading -------------------------------------------------------------------------------------------------------

/** A view that may not exist or may fail: `{ value }` or `{ error }`, never a throw. */
async function tryView(rpc, account, method, blockId) {
  try {
    return { value: await rpc.view(account, method, {}, blockId) };
  } catch (e) {
    return { error: String(e.message ?? e) };
  }
}

/**
 * Calls the `attest()` view and keeps its raw answer; `crossCheckAttest` reads it (ARCHITECTURE.md 2.8: attest() is a
 * cross-check only, the code hash and the key list come from RPC).
 * "absent" is a view that does not exist: a v2 build, or an account without Mamori. Any other failure is "error".
 * @returns {Promise<{ status: "present" | "absent" | "error", raw?: unknown, error?: string }>}
 */
export async function readAttest({ rpc, account, blockId }) {
  const r = await tryView(rpc, account, "attest", blockId);
  if ("value" in r) return { status: "present", raw: r.value };
  // A v2 build, or an account without Mamori, has no such method.
  if (/MethodNotFound|MethodResolveError|method .*not found|CodeDoesNotExist|no contract code/i.test(r.error)) return { status: "absent", error: r.error };
  return { status: "error", error: r.error };
}

/** The `attest_version` this code reads (ATTEST_VERSION in contracts/mamori/src/lib.rs). A higher one means a field was removed or changed meaning. */
export const ATTEST_VERSION = 1;

const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isCount = (x) => Number.isInteger(x) && x >= 0;
const isKey = (x) => typeof x === "string" && x !== "";

/**
 * Checks what `readAttest` kept against the shape of docs/v3/ATTEST-CHECK.md section 2.1, and keeps only the fields the
 * cross-check uses. `state` is one of:
 *   "absent"      no attest() view (a v2 build, or no Mamori on the account)
 *   "unreadable"  the view failed for another reason
 *   "malformed"   it answered, but not as Mamori's attest of the version this code reads
 *   "unsupported" a newer attest_version: a field may be gone or mean something else, so it is not read
 *   "ok"          `a` holds the fields
 * @returns {{ state: string, problems: string[], a?: object }}
 */
export function parseAttestation(attest) {
  if (!attest || attest.status === "absent") return { state: "absent", problems: ["no attest() view: a v2 build, or no Mamori on the account"] };
  if (attest.status === "error") return { state: "unreadable", problems: [`attest() could not be read: ${attest.error}`] };
  const raw = attest.raw;
  if (!isObject(raw)) return { state: "malformed", problems: ["the answer is not an object"] };
  if (raw.contract !== "mamori") return { state: "malformed", problems: [`contract is ${JSON.stringify(raw.contract)}, not "mamori"`] };
  if (!Number.isInteger(raw.attest_version) || raw.attest_version < 1) return { state: "malformed", problems: [`attest_version ${JSON.stringify(raw.attest_version)} is not a version number`] };
  if (raw.attest_version > ATTEST_VERSION) return { state: "unsupported", problems: [`attest_version ${raw.attest_version}, this check reads ${ATTEST_VERSION}`] };
  const problems = [];
  const need = (ok, what) => ok || problems.push(what);
  need(isKey(raw.account_id), "account_id is not a string");
  need(typeof raw.drill_build === "boolean", "drill_build is not a boolean");
  need(isCount(raw.min_delay_secs), "min_delay_secs is not a count");
  need(isObject(raw.config) && isCount(raw.config.delay_secs), "config.delay_secs is not a count");
  need(Array.isArray(raw.daily_keys) && raw.daily_keys.every((k) => isObject(k) && isKey(k.public_key)), "daily_keys is not a list of { public_key, strikes }");
  need(Array.isArray(raw.intents_keys) && raw.intents_keys.every(isKey), "intents_keys is not a list of keys");
  need(Array.isArray(raw.revoked_keys) && raw.revoked_keys.every(isKey), "revoked_keys is not a list of keys");
  if (problems.length) return { state: "malformed", problems };
  const a = {
    account_id: raw.account_id,
    drill_build: raw.drill_build,
    min_delay_secs: raw.min_delay_secs,
    config: raw.config,
    daily: raw.daily_keys.map((k) => k.public_key),
    intents: raw.intents_keys,
    revoked: raw.revoked_keys,
    allowlist_enforced: typeof raw.allowlist_enforced === "boolean" ? raw.allowlist_enforced : null,
  };
  return { state: "ok", problems: [], a };
}

/**
 * Compares what `attest()` records with what the chain and the vault's own views show, at the one block the facts were
 * read at. Pure. `findings` are disagreements, each `{ id, detail, offenders }` under the condition it belongs to (a
 * red); `unchecked` are parts that could not be compared (an unreadable view), each `{ id, detail }`. attest() adds
 * evidence only: the account's own full-access key can deploy an `attest()` that lies, so nothing here clears a row.
 * status: "agree", "partial" (nothing disagrees, something could not be compared), "disagree", or the unreadable
 * states of `parseAttestation` ("absent", "unreadable", "malformed", "unsupported"), where nothing was compared.
 * @returns {{ status: string, problems: string[], findings: object[], unchecked: object[], attest: object | null }}
 */
export function crossCheckAttest(attest, facts) {
  const p = parseAttestation(attest);
  if (p.state !== "ok") return { status: p.state, problems: p.problems, findings: [], unchecked: [], attest: null };
  const a = p.a;
  const findings = [];
  const unchecked = [];
  const found = (id, detail, offenders = []) => findings.push({ id, detail, offenders });

  // ARCH-2.8-6: a function-call key on the account that the vault does not record, by attest()'s books.
  const notRecorded = facts.keys.filter(isFc).map((k) => k.public_key).filter((k) => !a.daily.includes(k));
  if (notRecorded.length) found(IDS.unrecorded, `not in attest().daily_keys: ${list(notRecorded)}`, notRecorded);

  // ARCH-2.8-7: a recorded intents key. It is not visible in RPC, so attest() is the only source besides intents_keys().
  if (a.intents.length) found(IDS.intentsKey, `attest().intents_keys records: ${list(a.intents)}`, a.intents);

  // ATTEST-1: attest() against the account asked about and against the views that read the same state.
  if (a.account_id !== facts.account) found(IDS.attestAgrees, `attest() answered as ${a.account_id}, the account asked about is ${facts.account}`, [a.account_id]);
  const config = facts.config?.value;
  if (!isObject(config)) unchecked.push({ id: IDS.attestAgrees, detail: `config() could not be read: ${facts.config?.error ?? "not an object"}` });
  else {
    const names = [...new Set([...Object.keys(a.config), ...Object.keys(config)])].sort();
    const differ = names.filter((n) => JSON.stringify(a.config[n]) !== JSON.stringify(config[n]));
    if (differ.length) found(IDS.attestAgrees, `attest().config differs from config(): ${differ.map((n) => `${n} ${JSON.stringify(a.config[n])} against ${JSON.stringify(config[n])}`).join(", ")}`, differ.map((n) => `config.${n}`));
  }
  for (const [name, fromAttest, view] of [["daily_keys", a.daily, facts.recorded?.daily], ["intents_keys", a.intents, facts.recorded?.intents], ["revoked_keys", a.revoked, facts.recorded?.revoked]]) {
    const fromView = asList(view);
    if (fromView === null) {
      unchecked.push({ id: IDS.attestAgrees, detail: `${name}() could not be read: ${view?.error ?? "not a list"}` });
      continue;
    }
    const onlyAttest = fromAttest.filter((k) => !fromView.includes(k));
    const onlyView = fromView.filter((k) => !fromAttest.includes(k));
    if (onlyAttest.length || onlyView.length) {
      const parts = [onlyAttest.length && `only in attest(): ${list(onlyAttest)}`, onlyView.length && `only in ${name}(): ${list(onlyView)}`];
      found(IDS.attestAgrees, `${name} differ, ${parts.filter(Boolean).join("; ")}`, [...onlyAttest, ...onlyView]);
    }
  }

  // ATTEST-2: the conditions of the loss bound that live in the contract's own build and config (ATTEST-CHECK.md 2.3).
  if (a.drill_build) found(IDS.productionBuild, "attest().drill_build is true: a drill build allows a delay under the production floor and lets the cached era fall again", ["drill_build"]);
  if (a.config.delay_secs < a.min_delay_secs) found(IDS.productionBuild, `config.delay_secs ${a.config.delay_secs} is under min_delay_secs ${a.min_delay_secs}`, ["config.delay_secs"]);

  return { status: findings.length ? "disagree" : unchecked.length ? "partial" : "agree", problems: [], findings, unchecked, attest: a };
}

/**
 * Everything one run reads, pinned to one final block so the verdict is auditable against it.
 * Throws when the account does not exist: there is no cage to check.
 */
export async function readCageFacts({ rpc, account }) {
  const block = await rpc.finalBlock();
  const [acc, keys] = await Promise.all([rpc.account(account, block.hash), rpc.accessKeys(account, block.hash)]);
  if (acc === null || keys === null) throw new Error(`${account} does not exist at block ${block.height}: there is no cage to check`);
  const [daily, intents, revoked, config, attest] = await Promise.all([
    tryView(rpc, account, "daily_keys", block.hash),
    tryView(rpc, account, "intents_keys", block.hash),
    tryView(rpc, account, "revoked_keys", block.hash),
    tryView(rpc, account, "config", block.hash),
    readAttest({ rpc, account, blockId: block.hash }),
  ]);
  return { account, block, acc, keys, recorded: { daily, intents, revoked }, config, attest };
}

// ---- evaluating ----------------------------------------------------------------------------------------------------

const cond = (id, name, status, detail, offenders = []) => ({ id, name, status, detail, offenders });
const red = (id, name, offenders, detail) => cond(id, name, RED, detail, offenders);
const list = (xs) => xs.join(", ");
const asList = (r) => (r && Array.isArray(r.value) ? r.value : null);
const isFull = (k) => k.access_key.permission === "FullAccess";
const isFc = (k) => !isFull(k) && Boolean(k.access_key.permission?.FunctionCall);

/** A function-call permission's fields, with the omissions the RPC allows made explicit. */
const fcOf = (k) => {
  const p = k.access_key.permission.FunctionCall;
  return { key: k.public_key, allowance: p.allowance ?? null, receiver: p.receiver_id, methods: Array.isArray(p.method_names) ? p.method_names : [] };
};

/** What the rows share: the keys sorted by permission, and the policy with its defaults. */
function contextOf(facts, policy) {
  return {
    ...facts,
    policy,
    stand: policy.standInAdmin,
    maxAllowance: policy.maxAllowanceYocto ?? DEFAULT_MAX_ALLOWANCE_YOCTO,
    allowedMethods: new Set([...DAILY_METHODS, ...(policy.extraMethods ?? [])]),
    fullAccess: facts.keys.filter(isFull).map((k) => k.public_key),
    fcKeys: facts.keys.filter(isFc).map(fcOf),
    // A permission that is neither FullAccess nor FunctionCall is a shape this code does not know: never read it as harmless.
    unknownPermission: facts.keys.filter((k) => !isFull(k) && !isFc(k)).map((k) => k.public_key),
  };
}

// 1. Any classical (ed25519, secp256k1) full-access key. The guard is void.
function classicalFullAccess({ fullAccess, stand }) {
  const name = "no classical full-access key";
  const classical = fullAccess.filter((k) => keyKind(k) === "classical" && k !== stand);
  return classical.length ? red(IDS.classicalFullAccess, name, classical, `classical full-access key(s): ${list(classical)}`) : cond(IDS.classicalFullAccess, name, GREEN, stand ? "none besides the stand-in admin" : "none");
}

// 2. Anything other than exactly one ML-DSA full-access key. In stand-in mode the stand-in key is that one key.
function oneAdmin({ fullAccess, stand, policy }) {
  const name = "exactly one ML-DSA full-access key";
  const kind = stand ? "admin" : "ML-DSA";
  const admins = fullAccess.filter((k) => keyKind(k) === "post-quantum" || k === stand);
  const want = stand ?? policy.admin;
  if (admins.length !== 1) return red(IDS.oneMlDsaAdmin, name, admins, `${admins.length} ${kind} full-access key(s), expected exactly 1${admins.length ? `: ${list(admins)}` : ""}`);
  // The chain lists an ML-DSA key as ml-dsa-65-hash:...; a full public key cannot be compared with it until the hash is derived.
  if (want?.startsWith("ml-dsa-65:") && admins[0].startsWith("ml-dsa-65-hash:")) return cond(IDS.oneMlDsaAdmin, name, UNKNOWN, `the expected admin is a full public key but the chain lists ${admins[0]}; deriving the hash is not implemented, pass the on-chain spelling to --admin`);
  if (want !== undefined && admins[0] !== want) return red(IDS.oneMlDsaAdmin, name, admins, `the one ${kind} full-access key is ${admins[0]}, not the expected ${want}`);
  return cond(IDS.oneMlDsaAdmin, name, GREEN, `${admins[0]}${stand ? " (STAND-IN, sandbox only)" : ""}`);
}

// 3. A function-call key with allowance null (unlimited) or above the maximum. A zero allowance signs nothing: not red.
function allowance({ fcKeys, maxAllowance }) {
  const name = "function-call keys have a non-null allowance within the maximum";
  const bad = [];
  for (const k of fcKeys) {
    if (k.allowance === null) bad.push(`${k.key} (null = unlimited)`);
    else if (!/^\d+$/.test(String(k.allowance))) bad.push(`${k.key} (allowance ${JSON.stringify(k.allowance)} is not a number)`);
    else if (BigInt(k.allowance) > maxAllowance) bad.push(`${k.key} (${k.allowance} yocto > maximum ${maxAllowance})`);
  }
  return bad.length ? red(IDS.allowance, name, bad, list(bad)) : cond(IDS.allowance, name, GREEN, `${fcKeys.length} function-call key(s), maximum ${maxAllowance} yocto`);
}

// 4. A function-call key with empty or omitted method_names: it can call any method.
function methodNames({ fcKeys }) {
  const name = "function-call keys list their methods";
  const anyMethod = fcKeys.filter((k) => k.methods.length === 0).map((k) => k.key);
  return anyMethod.length ? red(IDS.methodNames, name, anyMethod, `empty or omitted method_names (any method): ${list(anyMethod)}`) : cond(IDS.methodNames, name, GREEN, `${fcKeys.length} function-call key(s)`);
}

// 5. A function-call key whose receiver is not the account, or whose methods go beyond the allowed ones.
function scope({ account, fcKeys, allowedMethods, unknownPermission }) {
  const name = "function-call keys reach only the account and the daily methods";
  const escaped = unknownPermission.map((k) => `${k} (a permission this check does not know)`);
  for (const k of fcKeys) {
    const why = [];
    if (k.receiver !== account) why.push(`receiver ${k.receiver}`);
    const extra = k.methods.filter((m) => !allowedMethods.has(m));
    if (extra.length) why.push(`methods ${list(extra)}`);
    if (why.length) escaped.push(`${k.key} (${why.join(", ")})`);
  }
  return escaped.length ? red(IDS.scope, name, escaped, list(escaped)) : cond(IDS.scope, name, GREEN, `receiver ${account}, methods within ${list([...allowedMethods])}`);
}

// 6. A function-call key not recorded in Mamori (daily_keys()). A burned key whose delete has not landed is one of these.
function unrecorded({ fcKeys, recorded }) {
  const name = "every function-call key is recorded by the vault";
  if (fcKeys.length === 0) return cond(IDS.unrecorded, name, GREEN, "no function-call key on the account");
  const daily = asList(recorded.daily);
  if (daily === null) return cond(IDS.unrecorded, name, UNKNOWN, `daily_keys() could not be read: ${recorded.daily.error ?? "not a list"}`);
  const revoked = asList(recorded.revoked) ?? [];
  const missing = fcKeys.filter((k) => !daily.includes(k.key)).map((k) => (revoked.includes(k.key) ? `${k.key} (in revoked_keys: its DeleteKey has not landed)` : k.key));
  return missing.length ? red(IDS.unrecorded, name, missing, `not in daily_keys(): ${list(missing)}`) : cond(IDS.unrecorded, name, GREEN, `${fcKeys.length} function-call key(s), all in daily_keys()`);
}

// 7. A recorded intents key: it signs on intents.near with no Mamori cap.
function intentsKey({ recorded }) {
  const name = "no intents key is recorded";
  const intents = asList(recorded.intents);
  if (intents === null) return cond(IDS.intentsKey, name, UNKNOWN, `intents_keys() could not be read: ${recorded.intents.error ?? "not a list"}`);
  return intents.length ? red(IDS.intentsKey, name, intents, `recorded intents key(s): ${list(intents)}`) : cond(IDS.intentsKey, name, GREEN, "intents_keys() is empty");
}

// 8. Code hash from RPC differs from the pinned global-contract hash. A global contract referenced by publisher
// account cannot be pinned (the publisher can change what the account runs), so that is red too.
function codeHash({ acc, policy }) {
  const name = "code hash equals the pinned hash";
  const byPublisher = acc.global_contract_account_id ?? null;
  const onChain = acc.global_contract_hash ?? acc.code_hash;
  if (byPublisher) return red(IDS.codeHash, name, [byPublisher], `the account runs the global contract published by ${byPublisher}, referenced by account, not by hash`);
  if (!policy.pinnedCodeHash) return cond(IDS.codeHash, name, UNKNOWN, `no pinned hash given (--code-hash or --wasm); the account runs ${onChain}`);
  if (onChain === policy.pinnedCodeHash) return cond(IDS.codeHash, name, GREEN, onChain);
  return red(IDS.codeHash, name, [onChain], `on chain ${onChain === ZERO_HASH ? `${onChain} (no code)` : onChain}, pinned ${policy.pinnedCodeHash}`);
}

const ATTEST_NAMES = {
  [IDS.attestAgrees]: "attest() agrees with the account and with the vault's own views",
  [IDS.productionBuild]: "the vault is a production build with the delay floor",
};

/** ATTEST-1 and ATTEST-2: red on a finding, unchecked when attest() or a view it is compared with could not be read. */
function attestRow(id, cross) {
  const name = ATTEST_NAMES[id];
  const mine = cross.findings.filter((f) => f.id === id);
  if (cross.status === "malformed" && id === IDS.attestAgrees) return red(id, name, cross.problems, `attest() is not Mamori's attest: ${list(cross.problems)}`);
  if (cross.status === "malformed") return cond(id, name, UNKNOWN, "attest() is malformed (see ATTEST-1), so this was not checked");
  if (["absent", "unreadable", "unsupported"].includes(cross.status)) return cond(id, name, UNKNOWN, `${cross.problems[0]}; this was not checked`);
  if (mine.length) return red(id, name, mine.flatMap((f) => f.offenders), mine.map((f) => f.detail).join("; "));
  const open = cross.unchecked.filter((u) => u.id === id);
  if (open.length) return cond(id, name, UNKNOWN, `nothing disagrees, but ${open.map((u) => u.detail).join("; ")}`);
  return cond(id, name, GREEN, id === IDS.attestAgrees ? "account_id, config, daily_keys, intents_keys and revoked_keys equal the vault's views" : "drill_build is false and delay_secs is not under min_delay_secs");
}

/** attest() evidence for one of the eight rows: it turns any status into RED, never the other way. */
function withFindings(c, findings) {
  const mine = findings.filter((f) => f.id === c.id);
  if (!mine.length) return c;
  const keyOf = (o) => o.split(" ")[0];
  const seen = new Set(c.offenders.map(keyOf));
  const extra = mine.flatMap((f) => f.offenders).filter((o) => !seen.has(keyOf(o)));
  const detail = [...(c.status === RED ? [c.detail] : []), ...mine.map((f) => f.detail)].join("; ");
  return red(c.id, c.name, [...c.offenders, ...extra], detail);
}

/** Rows 1 to 6 read the key list, so a list cut off at the paging limit cannot certify them: their GREEN becomes UNKNOWN. */
const KEY_LIST_ROWS = new Set([IDS.classicalFullAccess, IDS.oneMlDsaAdmin, IDS.allowance, IDS.methodNames, IDS.scope, IDS.unrecorded]);
const uncertified = (c, n) => (c.status === GREEN && KEY_LIST_ROWS.has(c.id) ? { ...c, status: UNKNOWN, detail: `the account has more keys than were read (list cut at ${n}); ${c.detail}` } : c);

/**
 * The eight red conditions of ARCHITECTURE.md 2.8, then ATTEST-1 and ATTEST-2, as a pure function of what was read.
 * policy: { admin?, standInAdmin?, pinnedCodeHash?, maxAllowanceYocto?, extraMethods? }
 *   admin           the admin's key as the chain lists it; when given, the one ML-DSA full-access key must be it
 *   standInAdmin    SANDBOX ONLY: a classical key accepted in place of the ML-DSA admin (the sandbox admin is ed25519)
 *   pinnedCodeHash  base58 sha256 of the code the account must run (the global-contract hash); without it row 8 is UNKNOWN
 *   maxAllowanceYocto  most a function-call key may hold (default: Mamori's own 0.25 NEAR)
 *   extraMethods    methods a function-call key may hold besides the two daily ones (the propose_* and sentinel methods, if they ship)
 */
export function evaluateCage(facts, policy) {
  const ctx = contextOf(facts, policy);
  const attest = facts.attest ?? { status: "absent" };
  const cross = crossCheckAttest(attest, facts);
  const eight = [classicalFullAccess, oneAdmin, allowance, methodNames, scope, unrecorded, intentsKey, codeHash].map((row) => withFindings(row(ctx), cross.findings));
  const rows = [...eight, attestRow(IDS.attestAgrees, cross), attestRow(IDS.productionBuild, cross)];
  const conditions = facts.keys.truncated === true ? rows.map((c) => uncertified(c, facts.keys.length)) : rows;
  const verdict = conditions.some((c) => c.status === RED) ? RED : conditions.some((c) => c.status === UNKNOWN) ? UNKNOWN : GREEN;
  return {
    account: facts.account,
    block: facts.block,
    mode: policy.standInAdmin ? "sandbox-stand-in-admin" : "production",
    verdict,
    conditions,
    info: {
      era: facts.config?.value?.era ?? null,
      delay_secs: facts.config?.value?.delay_secs ?? null,
      daily_keys: asList(facts.recorded.daily),
      revoked_keys: asList(facts.recorded.revoked),
      attest: attest.status,
      attest_cross_check: cross.status,
      // Reported, not graded: neither is a condition of the loss bound (LOSS-BOUND.md A10 for the allowlist).
      allowlist_enforced: cross.attest?.allowlist_enforced ?? null,
      max_strikes: cross.attest?.config.max_strikes ?? null,
    },
    limits: LIMITS,
  };
}

/** Process exit code for a result: 0 clean, 1 any RED, 3 nothing RED but something unchecked. */
export const exitCodeOf = (result) => (result.verdict === GREEN ? 0 : result.verdict === RED ? 1 : 3);

export async function cageCheck({ rpc, account, policy }) {
  return evaluateCage(await readCageFacts({ rpc, account }), policy);
}

// ---- output --------------------------------------------------------------------------------------------------------

export function renderCage(result) {
  const lines = [`cage-check ${result.account} at final block ${result.block.height} (${result.block.hash})`];
  if (result.mode !== "production") lines.push("MODE: SANDBOX STAND-IN ADMIN. A classical key is accepted as the admin. This is NOT a production result.");
  for (const c of result.conditions) lines.push(`${c.status.padEnd(7)} ${c.id}  ${c.name}  (${c.detail})`);
  const i = result.info;
  lines.push(
    "",
    `info (not a verdict): era ${i.era ?? "unreadable"}, delay ${i.delay_secs ?? "unreadable"} s, attest() ${i.attest}, attest cross-check ${i.attest_cross_check}${i.allowlist_enforced === null ? "" : `, allowlist ${i.allowlist_enforced ? "enforced" : "off"}`}${i.max_strikes === null ? "" : `, max strikes ${i.max_strikes}`}`,
    ...result.limits.map((l) => `limit: ${l}`),
  );
  const nRed = result.conditions.filter((c) => c.status === RED).length;
  const nUnknown = result.conditions.filter((c) => c.status === UNKNOWN).length;
  const total = result.conditions.length;
  lines.push(
    "",
    result.verdict === GREEN
      ? `GREEN: all ${total} conditions hold.`
      : result.verdict === RED
        ? `RED: ${nRed} of ${total} conditions fail${nUnknown ? `, ${nUnknown} could not be checked` : ""}.`
        : `UNKNOWN: nothing is red but ${nUnknown} of ${total} conditions could not be checked; this is not a clean bill.`,
  );
  return lines.join("\n");
}

// ---- command line --------------------------------------------------------------------------------------------------

export class CageUsage extends Error {}

export const CAGE_USAGE =
  "usage: kaigen-jobs cage-check <account> [--rpc <url>] [--admin <key> | --stand-in-admin <classical key>] [--code-hash <base58|hex> | --wasm <file>] [--max-allowance <NEAR>] [--allow-method <name>]... [--json]\n" +
  "  --admin           the admin key exactly as the chain lists it (ml-dsa-65-hash:...); the one ML-DSA full-access key must be it\n" +
  "  --stand-in-admin  SANDBOX ONLY: accept this classical key as the admin (the sandbox admin is ed25519); output is marked as not a production result\n" +
  "  --code-hash/--wasm the pinned code: a base58 or 64-digit hex sha256, or the wasm file to hash. Without one, the code-hash row is UNKNOWN (exit 3)\n" +
  "  --max-allowance   most NEAR a function-call key may hold (default 0.25, Mamori's own default)\n" +
  "  --allow-method    a method besides send_small and request_withdraw that a function-call key may hold (repeatable)\n" +
  "  --rpc             default: KAIGEN_RPC, then `rpc` in deployments.json. Exit 0 all green, 1 any red, 3 unchecked, 2 usage";

/** NEAR as a decimal string ("0.25") to yocto; a bad string throws CageUsage. */
function parseNear(text) {
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(text ?? "");
  if (!m) throw new CageUsage(`--max-allowance ${JSON.stringify(text)} is not an amount in NEAR such as 0.25`);
  return BigInt(m[1]) * NEAR + BigInt((m[2] ?? "").padEnd(24, "0") || "0");
}

/** A code hash as base58: it is accepted as base58 or as 64 hex digits (what `sha256sum` prints). */
export function normalizeCodeHash(text) {
  if (/^[0-9a-fA-F]{64}$/.test(text)) return base58.encode(Buffer.from(text, "hex"));
  let bytes;
  try {
    bytes = base58.decode(text);
  } catch {
    throw new CageUsage(`${JSON.stringify(text)} is neither a base58 nor a 64-digit hex sha256`);
  }
  if (bytes.length !== 32) throw new CageUsage(`${JSON.stringify(text)} decodes to ${bytes.length} bytes, a sha256 is 32`);
  return text;
}

/** `argv` is what follows `cage-check`. Returns `{ account, rpc, policy, json }`; throws CageUsage. */
export function parseCageArgs(argv) {
  const valued = new Set(["--rpc", "--admin", "--stand-in-admin", "--code-hash", "--wasm", "--max-allowance", "--allow-method"]);
  const seen = {};
  const extraMethods = [];
  const positional = [];
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (valued.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new CageUsage(`${a} needs a value`);
      if (a === "--allow-method") extraMethods.push(v);
      else if (a in seen) throw new CageUsage(`${a} given twice`);
      else seen[a] = v;
    } else if (a.startsWith("--")) throw new CageUsage(`unknown option ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 1) throw new CageUsage(positional.length === 0 ? "give the vault account to check" : `one account at a time, got ${positional.length}`);
  if (seen["--admin"] && seen["--stand-in-admin"]) throw new CageUsage("--admin and --stand-in-admin exclude each other");
  if (seen["--code-hash"] && seen["--wasm"]) throw new CageUsage("--code-hash and --wasm exclude each other");
  let pinnedCodeHash;
  if (seen["--code-hash"]) pinnedCodeHash = normalizeCodeHash(seen["--code-hash"]);
  else if (seen["--wasm"]) {
    try {
      pinnedCodeHash = codeHashOf(fs.readFileSync(seen["--wasm"]));
    } catch (e) {
      throw new CageUsage(`cannot read the wasm ${seen["--wasm"]}: ${e.code ?? e.message}`);
    }
  }
  return {
    account: positional[0],
    rpc: seen["--rpc"],
    json,
    policy: {
      admin: seen["--admin"],
      standInAdmin: seen["--stand-in-admin"],
      pinnedCodeHash,
      maxAllowanceYocto: seen["--max-allowance"] === undefined ? DEFAULT_MAX_ALLOWANCE_YOCTO : parseNear(seen["--max-allowance"]),
      extraMethods,
    },
  };
}
