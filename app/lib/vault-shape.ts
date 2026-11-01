import { isEra } from "./near.ts";

export const NOT_A_VAULT = "That contract does not look like a KAIGEN vault.";

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isWhole = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);
const isSeconds = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * Null when the answers from a contract's views have the shape a Mamori vault gives; otherwise the sentence to show.
 * Checked before any field is read, so an account with some other contract on it gets this message instead of a
 * TypeError, and before the page renders, so a malformed queue entry cannot crash it half way.
 */
export function vaultShapeProblem(answers: { config: unknown; keys: unknown; queue: unknown; spent: unknown }): string | null {
  const { config, keys, queue, spent } = answers;
  if (!isObject(config)) return NOT_A_VAULT;
  if (typeof config.kizashi !== "string" || config.kizashi === "") return NOT_A_VAULT;
  if (!isEra(config.era)) return NOT_A_VAULT;
  if (!isWhole(config.daily_limit) || !isSeconds(config.delay_secs) || !isSeconds(config.effective_delay_secs)) return NOT_A_VAULT;
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== "string")) return NOT_A_VAULT;
  if (!isWhole(spent)) return NOT_A_VAULT;
  if (!Array.isArray(queue)) return NOT_A_VAULT;
  for (const w of queue) {
    if (!isObject(w)) return NOT_A_VAULT;
    if (!isWhole(w.id) || !isWhole(w.amount) || !isWhole(w.unlocks_at) || typeof w.to !== "string") return NOT_A_VAULT;
    if (w.token != null && typeof w.token !== "string") return NOT_A_VAULT;
  }
  return null;
}
