import { isEra } from "./near.ts";

export const NOT_A_VAULT = "That contract does not look like a KAIGEN vault.";

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isWhole = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);
const isSeconds = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

const isKeyList = (v: unknown): v is string[] => Array.isArray(v) && v.every((k) => typeof k === "string");

/** The error a contract gives for a view it does not have (a vault built before `revoked_keys` existed, say). */
export const isMissingView = (e: unknown): boolean => /MethodNotFound|MethodResolveError/.test(e instanceof Error ? e.message : String(e));

/**
 * Null when the answers from a contract's views have the shape a Mamori vault gives; otherwise the sentence to show.
 * Checked before any field is read, so an account with some other contract on it gets this message instead of a
 * TypeError, and before the page renders, so a malformed queue entry cannot crash it half way.
 */
export function vaultShapeProblem(answers: { config: unknown; keys: unknown; queue: unknown; spent: unknown; revoked?: unknown; intents?: unknown }): string | null {
  const { config, keys, queue, spent, revoked, intents } = answers;
  if (!isObject(config)) return NOT_A_VAULT;
  if (typeof config.kizashi !== "string" || config.kizashi === "") return NOT_A_VAULT;
  if (!isEra(config.era)) return NOT_A_VAULT;
  if (!isWhole(config.daily_limit) || !isSeconds(config.delay_secs) || !isSeconds(config.effective_delay_secs)) return NOT_A_VAULT;
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== "string")) return NOT_A_VAULT;
  if (!isWhole(spent)) return NOT_A_VAULT;
  if (!Array.isArray(queue)) return NOT_A_VAULT;
  // `revoked_keys` and `intents_keys` are optional (null or absent: this build does not offer the view), but an answer must be a key list.
  for (const extra of [revoked, intents]) if (extra != null && !isKeyList(extra)) return NOT_A_VAULT;
  for (const w of queue) {
    if (!isObject(w)) return NOT_A_VAULT;
    if (!isWhole(w.id) || !isWhole(w.amount) || !isWhole(w.unlocks_at) || typeof w.to !== "string") return NOT_A_VAULT;
    if (w.token != null && typeof w.token !== "string") return NOT_A_VAULT;
  }
  return null;
}

export interface Lockdown {
  label: string;
  tone: "valid" | "warning" | "invalid";
}

/**
 * What to call a vault's state. "Post-quantum only" is claimed only when the era is kaigen AND the vault serves no
 * daily key AND no revoked key is still waiting for its deletion to be confirmed AND no key is left on intents.near:
 * a key in `revoked_keys` is no longer served by the contract but may still be on the account. A list the vault does
 * not offer (`null`) is unknown, and an unknown is never read as empty.
 */
export function lockdownOf(v: { era: "Calm" | "Warning" | "Kaigen"; daily: number; revoked: number | null; intents: number | null }): Lockdown {
  if (v.era === "Calm") return { label: "Era: Calm", tone: "valid" };
  if (v.era === "Warning") return { label: "Era: Warning", tone: "warning" };
  if (v.daily > 0) return { label: "Era: Kaigen", tone: "invalid" };
  const left = (v.revoked ?? 0) + (v.intents ?? 0);
  if (left > 0) return { label: `Locking down: ${left} ${left === 1 ? "key" : "keys"} still to delete`, tone: "warning" };
  if (v.revoked === null || v.intents === null) return { label: "Daily keys cleared; deletions not checked", tone: "warning" };
  return { label: "Post-quantum only", tone: "valid" };
}
