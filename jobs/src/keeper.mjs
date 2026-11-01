// Trip keeper: after an omen dies, call `trip()` on every known vault. Anyone can do this: the
// contracts trust only Kizashi's era, so the keeper needs no special rights, only gas.
import { classifyKeys } from "./classify.mjs";
import { pool } from "./rpc.mjs";

const RANK = { Calm: 0, Warning: 1, Kaigen: 2 };

/** An era this code does not know must stop the pass, never read as "up to date". */
const rank = (era, who) => {
  if (!(era in RANK)) throw new Error(`${who} reported an unknown era ${JSON.stringify(era)}`);
  return RANK[era];
};

/** Said when there is nothing to watch: an empty list must never read as "all vaults are safe". */
/**
 * Mamori's lock_down deletes daily keys first and intents keys second, under a gas cap, so one trip can stop half way.
 * The keeper repeats the trip, this many times at most, and then reports the vault as pending instead of looping.
 */
export const MAX_TRIP_PASSES = 5;
const RETRY_DELAY_MS = 3_000;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const NO_VAULTS = "no vaults configured: the keeper is watching nothing, so a clean pass would mean nothing (set `vaults` in deployments.json)";

/**
 * Why a vault still needs a trip at `target`, or null when it is up to date. Trusts the chain, not the
 * contract's own list: a failed key deletion can leave a live function-call key that the recorded set no
 * longer mentions.
 */
async function stillNeedsTrip(rpc, vault, target) {
  const vaultEra = await rpc.view(vault, "era");
  if (rank(vaultEra, vault) < target) return `it is still at era ${vaultEra}, the chain is at ${target === 2 ? "Kaigen" : "Warning"}`;
  if (target !== 2) return null;
  const keys = await rpc.accessKeys(vault);
  const daily = await rpc.view(vault, "daily_keys");
  if (!Array.isArray(daily)) throw new Error(`${vault} did not answer daily_keys with a list`);
  const intents = await rpc.view(vault, "intents_keys");
  if (!Array.isArray(intents)) throw new Error(`${vault} did not answer intents_keys with a list`);
  if (daily.length > 0) return "it still records daily keys";
  if (intents.length > 0) return "it still records intents keys";
  if (keys !== null && classifyKeys(keys).functionCall.length > 0) return "a function-call key is still live on the account";
  return null;
}

/**
 * One pass. `sendTrip(vault)` submits the transaction and returns its hash; it is injected so the
 * logic can be tested without keys and so the keeper can be swapped for any other submitter.
 * A vault counts as "tripped" only after its keys and era were re-read and the lockdown is there;
 * a submitted transaction that did not achieve it is "unconfirmed" and retried on the next pass.
 */
export async function tripOnce({ rpc, kizashi, vaults = [], sendTrip, concurrency = 4, maxPasses = MAX_TRIP_PASSES, retryDelayMs = RETRY_DELAY_MS, sleep = defaultSleep }) {
  const era = await rpc.view(kizashi, "era");
  const target = rank(era, kizashi);
  if (vaults.length === 0) throw new Error(NO_VAULTS);
  if (target === 0) return { era, results: [], owed: [] };

  const results = await pool(vaults, concurrency, async (vault) => {
    try {
      if ((await stillNeedsTrip(rpc, vault, target)) === null) return { vault, action: "up to date" };
      let hash;
      let why = null;
      let passes = 0;
      while (passes < maxPasses) {
        hash = await sendTrip(vault);
        passes++;
        why = await stillNeedsTrip(rpc, vault, target);
        if (why === null) break;
        if (passes < maxPasses) await sleep(retryDelayMs);
      }
      if (why !== null) return { vault, action: "unconfirmed", pending: true, passes, hash, error: `trip ${hash} was submitted ${passes} time(s) but ${why}: the lockdown is pending` };
      return { vault, action: "tripped", hash, passes };
    } catch (e) {
      return { vault, action: "error", error: String(e.message ?? e) };
    }
  });
  // Payouts owed to claimants are listed with the command that pays them; the keeper never sends one.
  let owed = [];
  let error;
  try {
    owed = await listOwed({ rpc, kizashi });
  } catch (e) {
    error = `could not read owed payouts: ${String(e.message ?? e)}`;
  }
  const rows = owed.map((o) => ({ vault: kizashi, action: "owed", claimant: o.claimant, error: describeOwed(o) }));
  return { era, results: [...results, ...rows], owed, ...(error ? { error } : {}) };
}

const ACCOUNT_ID = /^(?=.{1,64}$)([a-z\d]+([-_][a-z\d]+)*\.)*[a-z\d]+([-_][a-z\d]+)*$/;
const isWhole = (v) => typeof v === "string" && /^\d+$/.test(v);

/** The exact command that pays `claimant` what Kizashi owes. Ids are checked so nothing can be smuggled into a shell line. */
export function retryCommand(kizashi, claimant) {
  for (const id of [kizashi, claimant]) {
    if (typeof id !== "string" || !ACCOUNT_ID.test(id)) throw new Error(`${JSON.stringify(id)} is not a plausible account id, so no command is printed for it`);
  }
  return `near call ${kizashi} retry_payout '{"claimant":"${claimant}"}' --accountId <any funded account> --gas 300000000000000`;
}

/** Every claimant of a broken omen, asked once what Kizashi still owes; only those owed something are returned. */
export async function listOwed({ rpc, kizashi }) {
  const omens = await rpc.view(kizashi, "omens");
  if (!Array.isArray(omens)) throw new Error("omens() did not return a list");
  const claimants = [...new Set(omens.map((o) => o?.death?.claimant).filter((c) => c !== undefined && c !== null))];
  const out = [];
  for (const claimant of claimants) {
    const command = retryCommand(kizashi, claimant);
    const o = await rpc.view(kizashi, "owed", { claimant });
    if (!o || !isWhole(o.near) || !isWhole(o.usdc) || typeof o.usdc_unread !== "boolean") throw new Error(`owed(${claimant}) returned an answer that cannot be read`);
    if (BigInt(o.near) > 0n || BigInt(o.usdc) > 0n || o.usdc_unread) out.push({ claimant, near: o.near, usdc: o.usdc, usdcUnread: o.usdc_unread, command });
  }
  return out;
}

/** One line for a person: what is owed, and the command to run (nothing here sends it). */
export function describeOwed(o) {
  const parts = [];
  if (BigInt(o.near) > 0n) parts.push(`${o.near} yoctoNEAR`);
  if (BigInt(o.usdc) > 0n) parts.push(`${o.usdc} USDC base units`);
  if (o.usdcUnread) parts.push("a USDC balance that could not be read");
  return `${o.claimant} is owed ${parts.join(" and ")}; to pay it run (nothing here sends it): ${o.command}`;
}

/** Repeats `tripOnce` forever. A failed pass never stops the loop. */
export async function runKeeper({ intervalMs = 5 * 60_000, onPass = () => {}, signal, ...opts }) {
  const report = (pass) => {
    try {
      onPass(pass);
    } catch {
      // A broken reporter must not stop the keeper.
    }
  };
  while (!signal?.aborted) {
    try {
      report(await tripOnce(opts));
    } catch (e) {
      report({ era: "unknown", results: [], error: String(e.message ?? e) });
    }
    if (signal?.aborted) break;
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, intervalMs);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}
