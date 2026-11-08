// X-ray's verdict: is the cage around an account intact? A pure port of jobs/src/cage.mjs (docs/v3/ARCHITECTURE.md 2.8
// and ATTEST-CHECK.md), so the browser and the command line grade an account by the same rows: ARCH-2.8-1 to 8 and
// ATTEST-1 to 7, fifteen in all. Nothing here reads the network; lib/xray.ts reads, this decides.
//
// Differences from the command line, all in the direction of saying less:
//  * No stand-in admin: the sandbox mode of cage-check is for rehearsals and is never offered to a visitor.
//  * The code-hash row has no pin unless one is given. The page knows the published production build (KNOWN_PINS); a
//    hash that is not one of those is UNKNOWN, not RED, because someone else's vault may run code this page was never
//    told about. Only a pin the visitor typed in makes a different hash RED.
//  * Reads are made at one final block, as the command line does, but a row that needs something this page cannot read
//    (a view that failed, a field the vault's build lacks) is UNKNOWN. UNKNOWN is never shown as green.
//
// Verdict and exit semantics mirror cage-check: GREEN (exit 0), RED (1), UNKNOWN (3).

export type Status = "GREEN" | "RED" | "UNKNOWN";

export interface Condition {
  id: string;
  name: string;
  status: Status;
  detail: string;
  offenders: string[];
}

/** A view that may not exist or may fail: its value, or the error. Never a throw. */
export interface ViewResult {
  value?: unknown;
  error?: string;
}

export interface AttestRead {
  status: "present" | "absent" | "error";
  raw?: unknown;
  error?: string;
}

/** One entry of view_access_key_list. `permission` is "FullAccess" or { FunctionCall: { allowance, receiver_id, method_names } }. */
export interface RpcKey {
  public_key: string;
  access_key: { nonce: number; permission: unknown };
}

export interface AccountInfo {
  code_hash: string;
  global_contract_hash?: string | null;
  global_contract_account_id?: string | null;
}

export interface CageFacts {
  account: string;
  block: { height: number; hash: string };
  acc: AccountInfo;
  keys: RpcKey[];
  recorded: { daily: ViewResult; intents: ViewResult; revoked: ViewResult };
  config: ViewResult;
  attest: AttestRead;
}

export interface PinnedHash {
  hash: string;
  label: string;
}

export interface Policy {
  /** The admin key as the chain lists it. When given, the one ML-DSA full-access key must be it. */
  admin?: string;
  /** Hashes the visitor typed in. When any is given, the account must run one of them. */
  userPins?: string[];
  /** Hashes the page knows (the published production build). A match is GREEN; no match proves nothing, so UNKNOWN. */
  knownPins?: PinnedHash[];
  /** Most a function-call key may hold (default: Mamori's own 0.25 NEAR). */
  maxAllowanceYocto?: bigint;
}

export interface CageResult {
  account: string;
  block: { height: number; hash: string };
  verdict: Status;
  conditions: Condition[];
  info: {
    era: string | null;
    delay_secs: number | null;
    attest: string;
    attest_cross_check: string;
    allowlist_enforced: boolean | null;
    max_strikes: number | null;
  };
  limits: string[];
}

const NEAR = 10n ** 24n;
/** Mamori's own default allowance for a daily key (DEFAULT_ALLOWANCE, 250 mNEAR). */
export const DEFAULT_MAX_ALLOWANCE_YOCTO = NEAR / 4n;
/** The two methods a daily key may call (DAILY_METHODS in contracts/mamori/src/lib.rs). */
export const DAILY_METHODS: readonly string[] = ["send_small", "request_withdraw"];

/** The production build of Mamori that the project published and its testnet production vault runs (docs/v3/TESTNET-REHEARSAL.md). */
export const KNOWN_PINS: readonly PinnedHash[] = [{ hash: "AoxPd3zABfzDRoPsE14ReAzMrzq5o5rMFj8FZXn9zKoQ", label: "the published Mamori production build" }];

export const IDS = {
  classicalFullAccess: "ARCH-2.8-1",
  oneMlDsaAdmin: "ARCH-2.8-2",
  allowance: "ARCH-2.8-3",
  methodNames: "ARCH-2.8-4",
  scope: "ARCH-2.8-5",
  unrecorded: "ARCH-2.8-6",
  intentsKey: "ARCH-2.8-7",
  codeHash: "ARCH-2.8-8",
  attestAgrees: "ATTEST-1",
  productionBuild: "ATTEST-2",
  safeAccount: "ATTEST-3",
  policyActors: "ATTEST-4",
  emergencyWindow: "ATTEST-5",
  safeChange: "ATTEST-6",
  proposals: "ATTEST-7",
} as const;

const NS_PER_SEC = 10n ** 9n;
const MAX_EMERGENCY_NS = 7n * 86_400n * NS_PER_SEC;
const MAX_WATCHERS = 4;
const MAX_PROPOSALS = 8;
export const ATTEST_VERSION = 1;
const ZERO_HASH = "11111111111111111111111111111111";

/** What this check cannot see; shown with every verdict so a GREEN is not read as more than it is. */
export const LIMITS: readonly string[] = [
  "point in time: one final block; a key added after it is not seen",
  "a key added on intents.near without register_intents_key is not visible here (only recorded intents keys are)",
  "attest() is only as honest as the code that answers it: it can add a red, never clear one, and the code hash row is what ties it to known code",
  "the admin is compared by its on-chain spelling; without an expected admin, the row only checks that there is exactly one ML-DSA full-access key, not whose it is",
];

// ---- small helpers -------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObject = (x: unknown): x is Obj => x !== null && typeof x === "object" && !Array.isArray(x);
const isCount = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;
const isKey = (x: unknown): x is string => typeof x === "string" && x !== "";
const isU64 = (x: unknown): x is string => typeof x === "string" && /^\d+$/.test(x);
const isKeyList = (x: unknown): x is string[] => Array.isArray(x) && x.every(isKey);

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 to bytes; null for a character outside the alphabet. */
export function base58Decode(text: string): Uint8Array | null {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  const bytes: number[] = [];
  for (const ch of text) {
    let carry = BASE58.indexOf(ch);
    if (carry < 0) return null;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes.reverse()]);
}

/** A code hash typed by a visitor: base58 of a 32-byte sha256. Null when it is not one. */
export const isCodeHash = (text: string): boolean => base58Decode(text)?.length === 32;

const isFull = (k: RpcKey): boolean => k.access_key.permission === "FullAccess";
const isFc = (k: RpcKey): boolean => !isFull(k) && isObject(k.access_key.permission) && Boolean(k.access_key.permission.FunctionCall);

export const keyKind = (publicKey: string): "post-quantum" | "classical" => (publicKey.startsWith("ml-dsa-65") ? "post-quantum" : "classical");

export interface FcPermission {
  key: string;
  allowance: string | null;
  receiver: string;
  methods: string[];
}

/** A function-call permission's fields, with the omissions the RPC allows made explicit. */
export function fcOf(k: RpcKey): FcPermission {
  const p = (k.access_key.permission as { FunctionCall: Obj }).FunctionCall;
  return {
    key: k.public_key,
    allowance: typeof p.allowance === "string" ? p.allowance : null,
    receiver: typeof p.receiver_id === "string" ? p.receiver_id : "",
    methods: Array.isArray(p.method_names) ? p.method_names.filter((m): m is string => typeof m === "string") : [],
  };
}

export type KeyRow =
  | { kind: "full"; key: string; curve: "post-quantum" | "classical" }
  | ({ kind: "function-call"; curve: "post-quantum" | "classical" } & FcPermission)
  | { kind: "unknown"; key: string; curve: "post-quantum" | "classical" };

/** Every access key as a row for display: type, and for a function-call key its receiver, methods and allowance. */
export function keyRows(keys: readonly RpcKey[]): KeyRow[] {
  return keys.map((k): KeyRow => {
    const curve = keyKind(k.public_key);
    if (isFull(k)) return { kind: "full", key: k.public_key, curve };
    if (isFc(k)) return { kind: "function-call", curve, ...fcOf(k) };
    return { kind: "unknown", key: k.public_key, curve };
  });
}

// ---- attest() ------------------------------------------------------------------------------------------------------

interface SafeView {
  current: string | null;
  pending: { account: string; effective_at: string } | null;
}
interface Proposal {
  id?: unknown;
  proposed_at: string;
  executable_at: string;
}
interface Attested {
  account_id: string;
  drill_build: boolean;
  min_delay_secs: number;
  config: Obj & { delay_secs: number };
  daily: string[];
  intents: string[];
  revoked: string[];
  allowlist_enforced: boolean | null;
  block_timestamp?: bigint;
  policy_account?: string | null;
  safe_account?: SafeView;
  watchers?: string[];
  emergency_until?: bigint;
  proposals?: Proposal[];
}

type ParsedAttest = { state: "ok"; problems: string[]; a: Attested } | { state: "absent" | "unreadable" | "malformed" | "unsupported"; problems: string[] };

const isSafeView = (x: unknown): x is SafeView =>
  isObject(x) && (x.current === null || isKey(x.current)) && (x.pending === null || (isObject(x.pending) && isKey(x.pending.account) && isU64(x.pending.effective_at)));
const isProposalList = (x: unknown): x is Proposal[] => Array.isArray(x) && x.every((q) => isObject(q) && isU64(q.proposed_at) && isU64(q.executable_at));

/** Checks what the view returned against the shape of ATTEST-CHECK.md 2.1 and keeps only the fields the cross-check uses. */
export function parseAttestation(attest: AttestRead | null | undefined): ParsedAttest {
  if (!attest || attest.status === "absent") return { state: "absent", problems: ["no attest() view: a v2 build, or no Mamori on the account"] };
  if (attest.status === "error") return { state: "unreadable", problems: [`attest() could not be read: ${attest.error ?? "unknown error"}`] };
  const raw = attest.raw;
  if (!isObject(raw)) return { state: "malformed", problems: ["the answer is not an object"] };
  if (raw.contract !== "mamori") return { state: "malformed", problems: [`contract is ${JSON.stringify(raw.contract)}, not "mamori"`] };
  const version = raw.attest_version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return { state: "malformed", problems: [`attest_version ${JSON.stringify(version)} is not a version number`] };
  if (version > ATTEST_VERSION) return { state: "unsupported", problems: [`attest_version ${version}, this check reads ${ATTEST_VERSION}`] };
  const problems: string[] = [];
  const need = (ok: boolean, what: string) => {
    if (!ok) problems.push(what);
  };
  const config = raw.config;
  need(isKey(raw.account_id), "account_id is not a string");
  need(typeof raw.drill_build === "boolean", "drill_build is not a boolean");
  need(isCount(raw.min_delay_secs), "min_delay_secs is not a count");
  need(isObject(config) && isCount(config.delay_secs), "config.delay_secs is not a count");
  need(Array.isArray(raw.daily_keys) && raw.daily_keys.every((k) => isObject(k) && isKey(k.public_key)), "daily_keys is not a list of { public_key, strikes }");
  need(isKeyList(raw.intents_keys), "intents_keys is not a list of keys");
  need(isKeyList(raw.revoked_keys), "revoked_keys is not a list of keys");
  // The stretch fields: absent is allowed (an older vault; the rows say UNKNOWN), present must have the documented shape.
  const has = (name: string) => raw[name] !== undefined;
  const optional = (name: string, ok: (x: unknown) => boolean, what: string) => {
    if (has(name)) need(ok(raw[name]), what);
  };
  optional("block_timestamp", isU64, "block_timestamp is not a decimal string");
  optional("policy_account", (x) => x === null || isKey(x), "policy_account is neither null nor an account");
  optional("safe_account", isSafeView, "safe_account is not { current: account or null, pending: { account, effective_at } or null }");
  optional("watchers", isKeyList, "watchers is not a list of accounts");
  optional("emergency_until", isU64, "emergency_until is not a decimal string");
  optional("proposals", isProposalList, "proposals is not a list of { proposed_at, executable_at, ... } with decimal strings");
  if (problems.length) return { state: "malformed", problems };
  const a: Attested = {
    account_id: raw.account_id as string,
    drill_build: raw.drill_build as boolean,
    min_delay_secs: raw.min_delay_secs as number,
    config: config as Obj & { delay_secs: number },
    daily: (raw.daily_keys as Obj[]).map((k) => k.public_key as string),
    intents: raw.intents_keys as string[],
    revoked: raw.revoked_keys as string[],
    allowlist_enforced: typeof raw.allowlist_enforced === "boolean" ? raw.allowlist_enforced : null,
    block_timestamp: has("block_timestamp") ? BigInt(raw.block_timestamp as string) : undefined,
    policy_account: has("policy_account") ? (raw.policy_account as string | null) : undefined,
    safe_account: has("safe_account") ? (raw.safe_account as SafeView) : undefined,
    watchers: has("watchers") ? (raw.watchers as string[]) : undefined,
    emergency_until: has("emergency_until") ? BigInt(raw.emergency_until as string) : undefined,
    proposals: has("proposals") ? (raw.proposals as Proposal[]) : undefined,
  };
  return { state: "ok", problems: [], a };
}

interface Finding {
  id: string;
  detail: string;
  offenders: string[];
}
interface Unchecked {
  id: string;
  detail: string;
}
export interface CrossCheck {
  status: string;
  problems: string[];
  findings: Finding[];
  unchecked: Unchecked[];
  attest: Attested | null;
}

const list = (xs: readonly string[]) => xs.join(", ");
const asList = (r: ViewResult | undefined): string[] | null => (r && Array.isArray(r.value) ? (r.value as string[]) : null);

/**
 * Compares what attest() records with what the chain and the vault's own views show. attest() adds evidence only: the
 * account's own full-access key can deploy an attest() that lies, so nothing here clears a row.
 */
export function crossCheckAttest(attest: AttestRead | null | undefined, facts: CageFacts): CrossCheck {
  const p = parseAttestation(attest);
  if (p.state !== "ok") return { status: p.state, problems: p.problems, findings: [], unchecked: [], attest: null };
  const a = p.a;
  const findings: Finding[] = [];
  const unchecked: Unchecked[] = [];
  const found = (id: string, detail: string, offenders: string[] = []) => findings.push({ id, detail, offenders });

  // ARCH-2.8-6: a function-call key on the account that the vault does not record, by attest()'s books.
  const notRecorded = facts.keys.filter(isFc).map((k) => k.public_key).filter((k) => !a.daily.includes(k));
  if (notRecorded.length) found(IDS.unrecorded, `not in attest().daily_keys: ${list(notRecorded)}`, notRecorded);

  // ARCH-2.8-7: a recorded intents key. It is not visible in RPC, so attest() is the only source besides intents_keys().
  if (a.intents.length) found(IDS.intentsKey, `attest().intents_keys records: ${list(a.intents)}`, a.intents);

  // ATTEST-1: attest() against the account asked about and against the views that read the same state.
  if (a.account_id !== facts.account) found(IDS.attestAgrees, `attest() answered as ${a.account_id}, the account asked about is ${facts.account}`, [a.account_id]);
  const config = facts.config.value;
  if (!isObject(config)) unchecked.push({ id: IDS.attestAgrees, detail: `config() could not be read: ${facts.config.error ?? "not an object"}` });
  else {
    const names = [...new Set([...Object.keys(a.config), ...Object.keys(config)])].sort();
    const differ = names.filter((n) => JSON.stringify(a.config[n]) !== JSON.stringify(config[n]));
    if (differ.length) found(IDS.attestAgrees, `attest().config differs from config(): ${differ.map((n) => `${n} ${JSON.stringify(a.config[n])} against ${JSON.stringify(config[n])}`).join(", ")}`, differ.map((n) => `config.${n}`));
  }
  const pairs: [string, string[], ViewResult][] = [
    ["daily_keys", a.daily, facts.recorded.daily],
    ["intents_keys", a.intents, facts.recorded.intents],
    ["revoked_keys", a.revoked, facts.recorded.revoked],
  ];
  for (const [name, fromAttest, view] of pairs) {
    const fromView = asList(view);
    if (fromView === null) {
      unchecked.push({ id: IDS.attestAgrees, detail: `${name}() could not be read: ${view.error ?? "not a list"}` });
      continue;
    }
    const onlyAttest = fromAttest.filter((k) => !fromView.includes(k));
    const onlyView = fromView.filter((k) => !fromAttest.includes(k));
    if (onlyAttest.length || onlyView.length) {
      const parts = [onlyAttest.length > 0 && `only in attest(): ${list(onlyAttest)}`, onlyView.length > 0 && `only in ${name}(): ${list(onlyView)}`];
      found(IDS.attestAgrees, `${name} differ, ${parts.filter(Boolean).join("; ")}`, [...onlyAttest, ...onlyView]);
    }
  }

  // ATTEST-2: the conditions of the loss bound that live in the contract's own build and config (ATTEST-CHECK.md 2.3).
  if (a.drill_build) found(IDS.productionBuild, "attest().drill_build is true: a drill build allows a delay under the production floor and lets the cached era fall again", ["drill_build"]);
  if (a.config.delay_secs < a.min_delay_secs) found(IDS.productionBuild, `config.delay_secs ${a.config.delay_secs} is under min_delay_secs ${a.min_delay_secs}`, ["config.delay_secs"]);

  stretchChecks(a, facts, found, (id, detail) => unchecked.push({ id, detail }));

  return { status: findings.length ? "disagree" : unchecked.length ? "partial" : "agree", problems: [], findings, unchecked, attest: a };
}

/** The account a key names as an implicit account (ed25519 only: the 64 hex digits of the key), or null. */
export function implicitAccountOf(publicKey: string): string | null {
  if (!publicKey.startsWith("ed25519:")) return null;
  const bytes = base58Decode(publicKey.slice("ed25519:".length));
  return bytes && bytes.length === 32 ? Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("") : null;
}

/** ATTEST-3 .. ATTEST-7. A row runs only when every field it reads is in attest(); otherwise it is UNKNOWN. */
function stretchChecks(a: Attested, facts: CageFacts, found: (id: string, detail: string, offenders?: string[]) => void, missing: (id: string, detail: string) => void): void {
  const vaults = new Set([facts.account, a.account_id]);
  const delayNs = BigInt(a.config.delay_secs) * NS_PER_SEC;
  const now = a.block_timestamp;
  const ready = (id: string, fields: [string, unknown][]): boolean => {
    const absent = fields.filter(([, v]) => v === undefined).map(([n]) => n);
    if (absent.length) missing(id, `attest() lacks ${absent.join(", ")} (a vault built before the stretch items)`);
    return absent.length === 0;
  };

  if (ready(IDS.safeAccount, [["safe_account", a.safe_account], ["emergency_until", a.emergency_until], ["block_timestamp", now]]) && a.safe_account && a.emergency_until !== undefined && now !== undefined) {
    const { current, pending } = a.safe_account;
    for (const [what, acct] of [["safe account in force", current], ["pending safe account", pending?.account]] as const) {
      if (acct && vaults.has(acct)) found(IDS.safeAccount, `the ${what} is the vault itself (${acct}): a sweep would move nothing anywhere`, [acct]);
    }
    if (current === null && a.emergency_until > now) found(IDS.safeAccount, "an emergency window is open but no safe account is in force: the watchers are armed with nowhere to sweep to", ["safe_account.current"]);
  }

  if (ready(IDS.policyActors, [["policy_account", a.policy_account], ["watchers", a.watchers]]) && a.watchers) {
    const dailyAccounts = new Map<string, string>();
    for (const k of [...a.daily, ...facts.keys.filter(isFc).map((x) => x.public_key)]) {
      const acct = implicitAccountOf(k);
      if (acct) dailyAccounts.set(acct, k);
    }
    const actors: [string, string][] = [];
    if (a.policy_account) actors.push(["policy account", a.policy_account]);
    for (const w of a.watchers) actors.push(["watcher", w]);
    for (const [who, acct] of actors) {
      if (vaults.has(acct)) found(IDS.policyActors, `the ${who} is the vault itself (${acct}): every key of the vault would act as it`, [acct]);
      const daily = dailyAccounts.get(acct);
      if (daily) found(IDS.policyActors, `the ${who} ${acct} is the implicit account of the daily key ${daily}: its holder would hold both roles`, [acct]);
    }
    if (a.watchers.length > MAX_WATCHERS) found(IDS.policyActors, `${a.watchers.length} watchers, the contract allows at most ${MAX_WATCHERS}`, a.watchers);
    const twice = a.watchers.filter((w, i) => a.watchers!.indexOf(w) !== i);
    if (twice.length) found(IDS.policyActors, `watcher listed twice: ${list(twice)}`, twice);
  }

  if (ready(IDS.emergencyWindow, [["emergency_until", a.emergency_until], ["block_timestamp", now]]) && a.emergency_until !== undefined && now !== undefined && a.emergency_until - now > MAX_EMERGENCY_NS) {
    const days = Number((a.emergency_until - now) / (86_400n * NS_PER_SEC));
    found(IDS.emergencyWindow, `the emergency window ends ${days} days after the block, the longest allowed is 7`, ["emergency_until"]);
  }

  if (ready(IDS.safeChange, [["safe_account", a.safe_account], ["block_timestamp", now]]) && a.safe_account?.pending && now !== undefined) {
    const at = BigInt(a.safe_account.pending.effective_at);
    const who = a.safe_account.pending.account;
    if (at <= now) found(IDS.safeChange, `the change to ${who} unlocks at ${at}, not after the block time ${now}: it did not wait its delay`, [who]);
    else if (at > now + delayNs) found(IDS.safeChange, `the change to ${who} unlocks at ${at}, more than delay_secs ${a.config.delay_secs} after the block time: not a change this contract can have recorded`, [who]);
  }

  if (ready(IDS.proposals, [["proposals", a.proposals]]) && a.proposals) {
    if (a.proposals.length > MAX_PROPOSALS) found(IDS.proposals, `${a.proposals.length} proposals wait, the contract allows at most ${MAX_PROPOSALS}`, [`${a.proposals.length} proposals`]);
    for (const q of a.proposals) {
      const waited = BigInt(q.executable_at) - BigInt(q.proposed_at);
      const id = typeof q.id === "string" || typeof q.id === "number" ? String(q.id) : "?";
      if (waited < delayNs) found(IDS.proposals, `proposal ${id} can run ${waited} ns after it was proposed, under delay_secs ${a.config.delay_secs}`, [`proposal ${id}`]);
    }
  }
}

// ---- the eight rows of ARCHITECTURE.md 2.8 ------------------------------------------------------------------------

const cond = (id: string, name: string, status: Status, detail: string, offenders: string[] = []): Condition => ({ id, name, status, detail, offenders });
const red = (id: string, name: string, offenders: string[], detail: string): Condition => cond(id, name, "RED", detail, offenders);

interface Ctx extends CageFacts {
  policy: Policy;
  maxAllowance: bigint;
  allowedMethods: ReadonlySet<string>;
  fullAccess: string[];
  fcKeys: FcPermission[];
  unknownPermission: string[];
}

function contextOf(facts: CageFacts, policy: Policy): Ctx {
  return {
    ...facts,
    policy,
    maxAllowance: policy.maxAllowanceYocto ?? DEFAULT_MAX_ALLOWANCE_YOCTO,
    allowedMethods: new Set(DAILY_METHODS),
    fullAccess: facts.keys.filter(isFull).map((k) => k.public_key),
    fcKeys: facts.keys.filter(isFc).map(fcOf),
    // A permission that is neither FullAccess nor FunctionCall is a shape this code does not know: never read it as harmless.
    unknownPermission: facts.keys.filter((k) => !isFull(k) && !isFc(k)).map((k) => k.public_key),
  };
}

// 1. Any classical (ed25519, secp256k1) full-access key. The guard is void.
function classicalFullAccess({ fullAccess }: Ctx): Condition {
  const name = "no classical full-access key";
  const classical = fullAccess.filter((k) => keyKind(k) === "classical");
  return classical.length ? red(IDS.classicalFullAccess, name, classical, `classical full-access key(s): ${list(classical)}`) : cond(IDS.classicalFullAccess, name, "GREEN", "none");
}

// 2. Anything other than exactly one ML-DSA full-access key.
function oneAdmin({ fullAccess, policy }: Ctx): Condition {
  const name = "exactly one ML-DSA full-access key";
  const admins = fullAccess.filter((k) => keyKind(k) === "post-quantum");
  if (admins.length !== 1) return red(IDS.oneMlDsaAdmin, name, admins, `${admins.length} ML-DSA full-access key(s), expected exactly 1${admins.length ? `: ${list(admins)}` : ""}`);
  const want = policy.admin;
  // The chain lists an ML-DSA key as ml-dsa-65-hash:...; a full public key cannot be compared with it until the hash is derived.
  if (want?.startsWith("ml-dsa-65:") && admins[0].startsWith("ml-dsa-65-hash:")) {
    return cond(IDS.oneMlDsaAdmin, name, "UNKNOWN", `the expected admin is a full public key but the chain lists ${admins[0]}; give the on-chain spelling (ml-dsa-65-hash:...)`);
  }
  if (want !== undefined && admins[0] !== want) return red(IDS.oneMlDsaAdmin, name, admins, `the one ML-DSA full-access key is ${admins[0]}, not the expected ${want}`);
  return cond(IDS.oneMlDsaAdmin, name, "GREEN", want === undefined ? `${admins[0]} (not compared with an expected admin)` : `${admins[0]} (the expected admin)`);
}

// 3. A function-call key with allowance null (unlimited) or above the maximum. A zero allowance signs nothing: not red.
function allowanceRow({ fcKeys, maxAllowance }: Ctx): Condition {
  const name = "function-call keys have a non-null allowance within the maximum";
  const bad: string[] = [];
  for (const k of fcKeys) {
    if (k.allowance === null) bad.push(`${k.key} (null = unlimited)`);
    else if (!/^\d+$/.test(k.allowance)) bad.push(`${k.key} (allowance ${JSON.stringify(k.allowance)} is not a number)`);
    else if (BigInt(k.allowance) > maxAllowance) bad.push(`${k.key} (${k.allowance} yocto > maximum ${maxAllowance})`);
  }
  return bad.length ? red(IDS.allowance, name, bad, list(bad)) : cond(IDS.allowance, name, "GREEN", `${fcKeys.length} function-call key(s), maximum ${maxAllowance} yocto`);
}

// 4. A function-call key with empty or omitted method_names: it can call any method.
function methodNames({ fcKeys }: Ctx): Condition {
  const name = "function-call keys list their methods";
  const anyMethod = fcKeys.filter((k) => k.methods.length === 0).map((k) => k.key);
  return anyMethod.length ? red(IDS.methodNames, name, anyMethod, `empty or omitted method_names (any method): ${list(anyMethod)}`) : cond(IDS.methodNames, name, "GREEN", `${fcKeys.length} function-call key(s)`);
}

// 5. A function-call key whose receiver is not the account, or whose methods go beyond the allowed ones.
function scope({ account, fcKeys, allowedMethods, unknownPermission }: Ctx): Condition {
  const name = "function-call keys reach only the account and the daily methods";
  const escaped = unknownPermission.map((k) => `${k} (a permission this check does not know)`);
  for (const k of fcKeys) {
    const why: string[] = [];
    if (k.receiver !== account) why.push(`receiver ${k.receiver}`);
    const extra = k.methods.filter((m) => !allowedMethods.has(m));
    if (extra.length) why.push(`methods ${list(extra)}`);
    if (why.length) escaped.push(`${k.key} (${why.join(", ")})`);
  }
  return escaped.length ? red(IDS.scope, name, escaped, list(escaped)) : cond(IDS.scope, name, "GREEN", `receiver ${account}, methods within ${list(DAILY_METHODS)}`);
}

// 6. A function-call key not recorded in Mamori (daily_keys()). A burned key whose delete has not landed is one of these.
function unrecorded({ fcKeys, recorded }: Ctx): Condition {
  const name = "every function-call key is recorded by the vault";
  if (fcKeys.length === 0) return cond(IDS.unrecorded, name, "GREEN", "no function-call key on the account");
  const daily = asList(recorded.daily);
  if (daily === null) return cond(IDS.unrecorded, name, "UNKNOWN", `daily_keys() could not be read: ${recorded.daily.error ?? "not a list"}`);
  const revoked = asList(recorded.revoked) ?? [];
  const missing = fcKeys.filter((k) => !daily.includes(k.key)).map((k) => (revoked.includes(k.key) ? `${k.key} (in revoked_keys: its DeleteKey has not landed)` : k.key));
  return missing.length ? red(IDS.unrecorded, name, missing, `not in daily_keys(): ${list(missing)}`) : cond(IDS.unrecorded, name, "GREEN", `${fcKeys.length} function-call key(s), all in daily_keys()`);
}

// 7. A recorded intents key: it signs on intents.near with no Mamori cap.
function intentsKey({ recorded }: Ctx): Condition {
  const name = "no intents key is recorded";
  const intents = asList(recorded.intents);
  if (intents === null) return cond(IDS.intentsKey, name, "UNKNOWN", `intents_keys() could not be read: ${recorded.intents.error ?? "not a list"}`);
  return intents.length ? red(IDS.intentsKey, name, intents, `recorded intents key(s): ${list(intents)}`) : cond(IDS.intentsKey, name, "GREEN", "intents_keys() is empty");
}

// 8. Code hash against a pinned hash. A global contract referenced by publisher account cannot be pinned (the publisher
// can change what the account runs), so that is red. A hash typed by the visitor decides; the page's own known hashes
// can only confirm.
function codeHash({ acc, policy }: Ctx): Condition {
  const name = "code hash equals a pinned hash";
  const byPublisher = acc.global_contract_account_id ?? null;
  const onChain = acc.global_contract_hash ?? acc.code_hash;
  if (byPublisher) return red(IDS.codeHash, name, [byPublisher], `the account runs the global contract published by ${byPublisher}, referenced by account, not by hash`);
  const user = policy.userPins ?? [];
  if (user.length) {
    return user.includes(onChain) ? cond(IDS.codeHash, name, "GREEN", `${onChain} (the hash you gave)`) : red(IDS.codeHash, name, [onChain], `on chain ${onChain === ZERO_HASH ? `${onChain} (no code)` : onChain}, you pinned ${list(user)}`);
  }
  const known = (policy.knownPins ?? []).find((p) => p.hash === onChain);
  if (known) return cond(IDS.codeHash, name, "GREEN", `${onChain}, ${known.label}`);
  return cond(IDS.codeHash, name, "UNKNOWN", `the account runs ${onChain === ZERO_HASH ? `${onChain} (no code)` : onChain}, which is not a hash this page knows; give the hash you expect to pin it`);
}

// ---- the attest() rows and the verdict ----------------------------------------------------------------------------

const ATTEST_NAMES: Record<string, string> = {
  [IDS.attestAgrees]: "attest() agrees with the account and with the vault's own views",
  [IDS.productionBuild]: "the vault is a production build with the delay floor",
  [IDS.safeAccount]: "the safe account is not the vault and is in force while an emergency window is open",
  [IDS.policyActors]: "the policy account and the watchers are not the vault, not a daily key's account, and within the watcher limit",
  [IDS.emergencyWindow]: "the emergency window is no longer than 7 days",
  [IDS.safeChange]: "a pending safe-account change waits the withdrawal delay",
  [IDS.proposals]: "waiting proposals wait the withdrawal delay and are no more than 8",
};

const ATTEST_GREEN: Record<string, string> = {
  [IDS.attestAgrees]: "account_id, config, daily_keys, intents_keys and revoked_keys equal the vault's views",
  [IDS.productionBuild]: "drill_build is false and delay_secs is not under min_delay_secs",
  [IDS.safeAccount]: "the safe account is not the vault, and it is in force whenever a window is open",
  [IDS.policyActors]: "the policy account and the watchers are neither the vault nor a daily key's account, and within the limit",
  [IDS.emergencyWindow]: "emergency_until is within 7 days of the block time",
  [IDS.safeChange]: "no safe-account change is waiting, or its unlock is within the delay window after the block time",
  [IDS.proposals]: "every waiting proposal waits at least delay_secs, and no more than 8 wait",
};

const ATTEST_ROWS = [IDS.attestAgrees, IDS.productionBuild, IDS.safeAccount, IDS.policyActors, IDS.emergencyWindow, IDS.safeChange, IDS.proposals];

/** ATTEST-1 to ATTEST-7: red on a finding, unchecked when attest() or a view it is compared with could not be read. */
function attestRow(id: string, cross: CrossCheck): Condition {
  const name = ATTEST_NAMES[id];
  const mine = cross.findings.filter((f) => f.id === id);
  if (cross.status === "malformed" && id === IDS.attestAgrees) return red(id, name, cross.problems, `attest() is not Mamori's attest: ${list(cross.problems)}`);
  if (cross.status === "malformed") return cond(id, name, "UNKNOWN", "attest() is malformed (see ATTEST-1), so this was not checked");
  if (["absent", "unreadable", "unsupported"].includes(cross.status)) return cond(id, name, "UNKNOWN", `${cross.problems[0]}; this was not checked`);
  if (mine.length) return red(id, name, mine.flatMap((f) => f.offenders), mine.map((f) => f.detail).join("; "));
  const open = cross.unchecked.filter((u) => u.id === id);
  if (open.length) return cond(id, name, "UNKNOWN", `nothing disagrees, but ${open.map((u) => u.detail).join("; ")}`);
  return cond(id, name, "GREEN", ATTEST_GREEN[id]);
}

/** attest() evidence for one of the eight rows: it turns any status into RED, never the other way. */
function withFindings(c: Condition, findings: Finding[]): Condition {
  const mine = findings.filter((f) => f.id === c.id);
  if (!mine.length) return c;
  const keyOf = (o: string) => o.split(" ")[0];
  const seen = new Set(c.offenders.map(keyOf));
  const extra = mine.flatMap((f) => f.offenders).filter((o) => !seen.has(keyOf(o)));
  const detail = [...(c.status === "RED" ? [c.detail] : []), ...mine.map((f) => f.detail)].join("; ");
  return red(c.id, c.name, [...c.offenders, ...extra], detail);
}

/**
 * The eight red conditions of ARCHITECTURE.md 2.8, then ATTEST-1 to ATTEST-7, as a pure function of what was read.
 * The verdict is RED if any row is RED, else UNKNOWN if any row is UNKNOWN, else GREEN.
 */
export function evaluateCage(facts: CageFacts, policy: Policy = {}): CageResult {
  const ctx = contextOf(facts, policy);
  const cross = crossCheckAttest(facts.attest, facts);
  const eight = [classicalFullAccess, oneAdmin, allowanceRow, methodNames, scope, unrecorded, intentsKey, codeHash].map((row) => withFindings(row(ctx), cross.findings));
  const conditions = [...eight, ...ATTEST_ROWS.map((id) => attestRow(id, cross))];
  const verdict: Status = conditions.some((c) => c.status === "RED") ? "RED" : conditions.some((c) => c.status === "UNKNOWN") ? "UNKNOWN" : "GREEN";
  const config = isObject(facts.config.value) ? facts.config.value : null;
  return {
    account: facts.account,
    block: facts.block,
    verdict,
    conditions,
    info: {
      era: typeof config?.era === "string" ? config.era : null,
      delay_secs: typeof config?.delay_secs === "number" ? config.delay_secs : null,
      attest: facts.attest.status,
      attest_cross_check: cross.status,
      // Reported, not graded: neither is a condition of the loss bound (LOSS-BOUND.md A10 for the allowlist).
      allowlist_enforced: cross.attest?.allowlist_enforced ?? null,
      max_strikes: typeof cross.attest?.config.max_strikes === "number" ? cross.attest.config.max_strikes : null,
    },
    limits: [...LIMITS],
  };
}

/** The exit code cage-check gives the same verdict: 0 clean, 1 any RED, 3 nothing RED but something unchecked. */
export const exitCodeOf = (result: Pick<CageResult, "verdict">): 0 | 1 | 3 => (result.verdict === "GREEN" ? 0 : result.verdict === "RED" ? 1 : 3);

/** Whether the account answered as a Mamori vault: the attest() view exists and has Mamori's shape. */
export const isMamori = (facts: Pick<CageFacts, "attest">): boolean => parseAttestation(facts.attest).state === "ok";
