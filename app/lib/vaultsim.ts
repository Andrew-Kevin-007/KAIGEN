// A simulation of the Mamori vault rules, in the browser, for /arena. It is NOT the chain and it never touches one.
//
// It reproduces the decisions of `send_small` in contracts/mamori/src/lib.rs (`judge_send`, `refuse`, `open_strikes`) and
// the story in contracts/mamori/src/tests/demo_story.rs, in the same order and with the same refusal texts:
//
//   1. the key must be a live daily key              -> otherwise rejected "not a recorded daily key" (no strike)
//   2. the amount must be more than zero             -> otherwise rejected "amount must be > 0" (no strike)
//   3. the recipient must be on the allowlist        -> otherwise refused "recipient is not on the allowlist" (STRIKE)
//   4. the amount must reach the minimum send        -> otherwise refused, no strike (dust)
//   5. the amount must fit the 24 h cap              -> more than the WHOLE cap: refused "over the 24 h limit" (STRIKE);
//                                                       fits the cap but not what is left of it: same text, no strike
//   6. the third strike inside 24 h burns the key; a burned key is rejected from then on
//
// One addition the contract does not need: a payment above the vault's balance is rejected without a strike, because the
// simulated vault tracks a balance for the page. Amounts are BigInt yoctoNEAR; nothing is rounded.
//
// Everything is immutable: `pay` returns a new state and a verdict.

import { blastRadius, type Blast } from "./blast.ts";

export const YOCTO_PER_NEAR = 10n ** 24n;
export const DAY_MS = 86_400_000;

export interface VaultConfig {
  /** C: the 24 h cap of NEAR, in yoctoNEAR. */
  capYocto: bigint;
  /** The pending limit P (the withdrawal queue's ceiling). The contract's default is 10 x C. */
  pendingYocto: bigint;
  /** D: the withdrawal delay in seconds. The production build refuses under 86,400. */
  delaySecs: number;
  maxStrikes: number;
  allowlist: readonly string[];
  enforceAllowlist: boolean;
  /** Smallest NEAR amount that is accepted; smaller ones are refused without a strike. */
  minSendYocto: bigint;
}

export interface VaultState {
  config: VaultConfig;
  balanceYocto: bigint;
  /** Sends inside the rolling 24 h window: (time in ms, amount). */
  sends: readonly { at: number; amount: bigint }[];
  strikes: { count: number; since: number };
  keyAlive: boolean;
  /** Total sent to each recipient since the start, in yoctoNEAR. */
  received: Readonly<Record<string, bigint>>;
}

export type VerdictCode =
  | "sent"
  | "not_allowlisted"
  | "over_cap_total"
  | "cap_exhausted"
  | "below_min_send"
  | "not_a_daily_key"
  | "zero_amount"
  | "bad_amount"
  | "insufficient_balance";

export interface Verdict {
  /** sent: it went through. refused: the vault answered no (it may count as a strike). rejected: the call itself was invalid. */
  kind: "sent" | "refused" | "rejected";
  code: VerdictCode;
  /** The vault's own words, as in `Reason::text`. Empty for "sent". */
  reason: string;
  /** Did this answer add a strike? */
  counted: boolean;
  /** The key's strikes after this answer. */
  strikes: number;
  maxStrikes: number;
  burned: boolean;
  /** What the agent is told: the same shape as the line the recorded run's tool returns. */
  toolText: string;
}

/** The refusal texts, word for word from `Reason::text`. */
export const REASON_TEXT = {
  not_allowlisted: "recipient is not on the allowlist",
  over_cap_total: "over the 24 h limit",
  cap_exhausted: "over the 24 h limit",
  below_min_send: "amount is below the minimum send",
  not_a_daily_key: "not a recorded daily key",
  zero_amount: "amount must be > 0",
} as const;

/** The demo vault: the story of demo_story.rs, a 1 NEAR cap, three strikes, one allowlisted supplier. */
export const DEMO_SUPPLIER = "supplier.kaigen-funder-a00266.testnet";
export const DEMO_ATTACKER = "kaigen-attacker.testnet";
export const DEMO_CAP_NEAR = 1n;
export const DEMO_BALANCE_NEAR = 5n;

export function demoConfig(): VaultConfig {
  return {
    capYocto: DEMO_CAP_NEAR * YOCTO_PER_NEAR,
    // The contract's default pending limit: PENDING_LIMIT_MULTIPLE (10) x the cap.
    pendingYocto: 10n * DEMO_CAP_NEAR * YOCTO_PER_NEAR,
    // The production floor, so the bound is the C + P one. (The recorded run used a 10 s drill build; this is stricter.)
    delaySecs: 86_400,
    maxStrikes: 3,
    allowlist: [DEMO_SUPPLIER],
    enforceAllowlist: true,
    // demo_story switches the minimum off to send 1 yocto; the contract's default is 0.001 NEAR. Keep the default.
    minSendYocto: YOCTO_PER_NEAR / 1000n,
  };
}

export function newVault(config: VaultConfig = demoConfig(), balanceYocto: bigint = DEMO_BALANCE_NEAR * YOCTO_PER_NEAR, now = 0): VaultState {
  return { config, balanceYocto, sends: [], strikes: { count: 0, since: now }, keyAlive: true, received: {} };
}

/**
 * A NEAR amount as the model wrote it (a number, or a decimal string) to yoctoNEAR, exactly. Null for anything that is not
 * a finite plain decimal with at most 24 places. Zero parses (the vault then rejects it as zero); negatives do not.
 */
export function nearToYocto(input: unknown): bigint | null {
  let s: string;
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) return null;
    s = input.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 24 });
  } else if (typeof input === "string") {
    s = input.trim();
  } else {
    return null;
  }
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(s);
  if (!m) return null;
  return BigInt(m[1]) * YOCTO_PER_NEAR + BigInt((m[2] ?? "").padEnd(24, "0"));
}

/** yoctoNEAR to a NEAR string with up to `places` decimals (rounded down), trailing zeros dropped. */
export function formatNear(yocto: bigint, places = 6): string {
  const s = yocto.toString().padStart(25, "0");
  const frac = s.slice(-24, -24 + places).replace(/0+$/, "");
  return `${s.slice(0, -24)}${frac ? `.${frac}` : ""}`;
}

const liveSends = (v: VaultState, now: number) => v.sends.filter((s) => now - s.at <= DAY_MS);
const spentIn24h = (v: VaultState, now: number): bigint => liveSends(v, now).reduce((a, s) => a + s.amount, 0n);

/** What is spent of the 24 h cap now. */
export const spent24h = (v: VaultState, now: number): bigint => spentIn24h(v, now);

/** The key's strike count now (a strike older than 24 h no longer counts, as `open_strikes`). */
export function strikesNow(v: VaultState, now: number): number {
  return now - v.strikes.since <= DAY_MS ? v.strikes.count : 0;
}

/** The most a stolen daily key can move in any 24 h from these settings: lib/blast.ts, docs/v3/LOSS-BOUND.md section 1. */
export function worstCase(v: VaultState): Blast | null {
  return blastRadius({ cap: v.config.capYocto.toString(), pending: v.config.pendingYocto.toString(), delaySecs: v.config.delaySecs });
}

/** Total that reached any recipient that is not on the allowlist. */
export function reachedOutsiders(v: VaultState): bigint {
  return Object.entries(v.received)
    .filter(([who]) => !v.config.allowlist.includes(who))
    .reduce((a, [, n]) => a + n, 0n);
}

const verdict = (v: Omit<Verdict, "toolText" | "maxStrikes"> & { maxStrikes: number }): Verdict => {
  let toolText: string;
  if (v.kind === "sent") toolText = "sent";
  else if (v.kind === "refused") toolText = `refused: ${v.reason}.${v.counted ? ` strike ${v.strikes} of ${v.maxStrikes}${v.burned ? ", key burned" : ""}` : ""}`.trimEnd();
  else toolText = `rejected: ${v.reason}`;
  return { ...v, toolText };
};

/** One `pay` call by the agent's key at time `now` (ms). Returns the next state and the vault's answer. */
export function pay(state: VaultState, recipient: unknown, amountNear: unknown, now: number): { state: VaultState; verdict: Verdict } {
  const cfg = state.config;
  const strikes = strikesNow(state, now);
  const base = { maxStrikes: cfg.maxStrikes, strikes, burned: false, counted: false };
  const reject = (code: VerdictCode, reason: string): { state: VaultState; verdict: Verdict } => ({ state, verdict: verdict({ ...base, kind: "rejected", code, reason }) });

  // 1. a key that is not recorded (never added, or burned) cannot even ask.
  if (!state.keyAlive) return reject("not_a_daily_key", REASON_TEXT.not_a_daily_key);

  const to = typeof recipient === "string" ? recipient.trim() : "";
  const amount = nearToYocto(amountNear);
  if (!to) return reject("bad_amount", "recipient is missing");
  if (amount === null) return reject("bad_amount", "amount_near is not a plain positive number");
  // 2. zero.
  if (amount === 0n) return reject("zero_amount", REASON_TEXT.zero_amount);

  const refuse = (code: "not_allowlisted" | "over_cap_total" | "cap_exhausted" | "below_min_send", counted: boolean) => {
    if (!counted) return { state, verdict: verdict({ ...base, kind: "refused", code, reason: REASON_TEXT[code], counted: false }) };
    const count = strikes + 1;
    const burned = count >= cfg.maxStrikes;
    const next: VaultState = {
      ...state,
      strikes: burned ? { count: 0, since: now } : { count, since: strikes === 0 ? now : state.strikes.since },
      keyAlive: !burned,
    };
    return { state: next, verdict: verdict({ ...base, kind: "refused", code, reason: REASON_TEXT[code], counted: true, strikes: count, burned }) };
  };

  // 3. the allowlist.
  if (cfg.enforceAllowlist && !cfg.allowlist.includes(to)) return refuse("not_allowlisted", true);
  // 4. dust.
  if (amount < cfg.minSendYocto) return refuse("below_min_send", false);
  // 5. the 24 h cap.
  if (spentIn24h(state, now) + amount > cfg.capYocto) return amount > cfg.capYocto ? refuse("over_cap_total", true) : refuse("cap_exhausted", false);
  // Simulation only: the page keeps a balance.
  if (amount > state.balanceYocto) return reject("insufficient_balance", "the vault balance is lower than the amount");

  const next: VaultState = {
    ...state,
    balanceYocto: state.balanceYocto - amount,
    sends: [...liveSends(state, now), { at: now, amount }],
    received: { ...state.received, [to]: (state.received[to] ?? 0n) + amount },
  };
  return { state: next, verdict: verdict({ ...base, kind: "sent", code: "sent", reason: "" }) };
}
