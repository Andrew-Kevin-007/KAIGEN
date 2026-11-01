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
  if ((await rpc.view(vault, "daily_keys")).length > 0) return "it still records daily keys";
  if (keys !== null && classifyKeys(keys).functionCall.length > 0) return "a function-call key is still live on the account";
  return null;
}

/**
 * One pass. `sendTrip(vault)` submits the transaction and returns its hash; it is injected so the
 * logic can be tested without keys and so the keeper can be swapped for any other submitter.
 * A vault counts as "tripped" only after its keys and era were re-read and the lockdown is there;
 * a submitted transaction that did not achieve it is "unconfirmed" and retried on the next pass.
 */
export async function tripOnce({ rpc, kizashi, vaults = [], sendTrip, concurrency = 4 }) {
  const era = await rpc.view(kizashi, "era");
  const target = rank(era, kizashi);
  if (vaults.length === 0) throw new Error(NO_VAULTS);
  if (target === 0) return { era, results: [] };

  const results = await pool(vaults, concurrency, async (vault) => {
    try {
      if ((await stillNeedsTrip(rpc, vault, target)) === null) return { vault, action: "up to date" };
      const hash = await sendTrip(vault);
      const why = await stillNeedsTrip(rpc, vault, target);
      if (why !== null) return { vault, action: "unconfirmed", hash, error: `trip ${hash} was submitted but ${why}` };
      return { vault, action: "tripped", hash };
    } catch (e) {
      return { vault, action: "error", error: String(e.message ?? e) };
    }
  });
  return { era, results };
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
