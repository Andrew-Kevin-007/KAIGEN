// The blast-radius meter: the most a Mamori vault can lose to a stolen daily key in any 24 hours, per token, from the
// proven bound in docs/v3/LOSS-BOUND.md section 1:
//
//   loss_T(W) <= C_T + P_T     when the withdrawal delay D is at least 24 h
//   loss_T(W) <= C_T + 2 P_T   when D is under 24 h (drill builds only)
//
// C_T is the 24 h cap of the token, P_T its pending limit. Both come from the vault's own views. If either is missing
// or not a whole number the answer is null: nothing is shown rather than a guess.

export const DAY_SECS = 86_400;

export interface BlastInputs {
  /** C: the 24 h cap, in the token's smallest unit, as a decimal string. */
  cap: unknown;
  /** P: the pending limit, same unit. */
  pending: unknown;
  /** D: the withdrawal delay in seconds. */
  delaySecs: unknown;
}

export interface Blast {
  cap: bigint;
  pending: bigint;
  delaySecs: number;
  /** How many pending limits can get through one window: 1 from a 24 h delay up, 2 below it. */
  pendingTimes: 1 | 2;
  /** The bound: cap + pendingTimes * pending. */
  worst: bigint;
}

const isWhole = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);

export function blastRadius(i: BlastInputs): Blast | null {
  if (!isWhole(i.cap) || !isWhole(i.pending)) return null;
  const d = i.delaySecs;
  if (typeof d !== "number" || !Number.isFinite(d) || d < 0) return null;
  const cap = BigInt(i.cap);
  const pending = BigInt(i.pending);
  const pendingTimes = d >= DAY_SECS ? 1 : 2;
  return { cap, pending, delaySecs: d, pendingTimes, worst: cap + BigInt(pendingTimes) * pending };
}

/** The formula with the numbers in it, for the expandable note. `fmt` writes an amount in the token's unit. */
export function blastFormula(b: Blast, fmt: (v: bigint) => string): string {
  return b.pendingTimes === 1 ? `${fmt(b.cap)} + ${fmt(b.pending)} = ${fmt(b.worst)}` : `${fmt(b.cap)} + 2 x ${fmt(b.pending)} = ${fmt(b.worst)}`;
}
