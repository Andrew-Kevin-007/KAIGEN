// Fire test: the weekly rehearsal of the whole lockdown on drill omens and drill vaults.
//
//   claim with a drill omen key -> trip the drill vaults -> confirm classical keys are gone
//   -> confirm a post-quantum send still works -> reset and re-arm for next week
//
// `runFireTest` is the orchestration only. Every on-chain action goes through `chain`, so the
// sequence can be tested without a network and the same record is produced either way. Drill
// objects are labelled drill everywhere; nothing here implies the production omen died.
import { classifyKeys } from "./classify.mjs";

export class FireTestError extends Error {
  constructor(step, message, record) {
    super(`fire test failed at "${step}": ${message}`);
    this.name = "FireTestError";
    this.step = step;
    this.record = record;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns a truthy value or the tries run out. */
export async function waitFor(fn, { tries = 30, delayMs = 2000, wait = sleep } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await wait(delayMs);
  }
  return null;
}

/** True when the vault has no classical full-access key and no function-call key left. */
export const lockedDown = (keys) => {
  const c = classifyKeys(keys);
  return c.classicalFullAccess.length === 0 && c.functionCall.length === 0 && c.postQuantumFullAccess.length > 0;
};

/**
 * @param chain  { era, vaultEra, dailyKeys, accessKeys, blockHeight, claim, trip, pqSend, reset, rearm }
 * @param cfg    { kizashi, vaults: string[], omenId, seq }
 * @param opts   { wait } to stub sleeping in tests
 * @returns the record to publish. Throws FireTestError (carrying the partial record) on any failed step.
 */
export async function runFireTest({ chain, cfg, opts = {} }) {
  try {
    return await sequence({ chain, cfg, opts });
  } catch (e) {
    // After a claim the drill is in kaigen. Leave it there and the next run dies at preflight, so
    // the rehearsal would silently stop. Try to put it back, and record what happened either way.
    if (e instanceof FireTestError && e.record?.claim_tx) e.record.cleanup = await recover({ chain, cfg, opts });
    throw e;
  }
}

/** Best effort: reset the drill Kizashi and re-arm every drill vault. Never throws. */
async function recover({ chain, cfg, opts }) {
  const out = { reset_tx: null, rearm_txs: {}, errors: [] };
  const tryDo = async (label, fn) => {
    try {
      return await fn();
    } catch (e) {
      out.errors.push(`${label}: ${String(e.message ?? e)}`);
      return null;
    }
  };
  out.reset_tx = await tryDo("reset", () => chain.reset());
  for (const v of cfg.vaults) out.rearm_txs[v] = await tryDo(`re-arm ${v}`, () => chain.rearm(v));
  return out;
}

async function sequence({ chain, cfg, opts = {} }) {
  const rec = { seq: cfg.seq, drill: true, submitter: cfg.submitter, kizashi: cfg.kizashi, omen_id: cfg.omenId, vaults: cfg.vaults, steps: [] };
  const step = async (name, fn) => {
    try {
      const out = await fn();
      rec.steps.push({ step: name, ok: true });
      return out;
    } catch (e) {
      rec.steps.push({ step: name, ok: false, error: String(e.message ?? e) });
      throw e instanceof FireTestError ? e : new FireTestError(name, String(e.message ?? e), rec);
    }
  };
  const need = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };

  await step("preflight: drill is armed", async () => {
    need((await chain.era(cfg.kizashi)) === "Calm", "drill Kizashi is not calm; it needs a reset");
    for (const v of cfg.vaults) {
      need((await chain.vaultEra(v)) === "Calm", `${v} is not calm`);
      need((await chain.dailyKeys(v)).length > 0, `${v} has no daily key to delete`);
    }
  });

  rec.claim_tx = await step("claim with the drill omen key", () => chain.claim(cfg.omenId));
  rec.claim_block = await chain.blockHeight();
  await step("era is kaigen", async () => need((await chain.era(cfg.kizashi)) === "Kaigen", "claim did not raise the era"));

  rec.trip_txs = {};
  for (const v of cfg.vaults) rec.trip_txs[v] = await step(`trip ${v}`, () => chain.trip(v));

  await step("classical keys are gone", async () => {
    for (const v of cfg.vaults) {
      const ok = await waitFor(async () => lockedDown(await chain.accessKeys(v)), opts);
      need(ok, `${v} still has classical keys after trip`);
      need((await chain.dailyKeys(v)).length === 0, `${v} still records daily keys`);
    }
    // Published so `make verify` can re-read the keys at exactly this block.
    rec.verified_block = await chain.blockHeight();
  });

  rec.pq_send_txs = {};
  for (const v of cfg.vaults) rec.pq_send_txs[v] = await step(`post-quantum send from ${v}`, () => chain.pqSend(v));

  rec.reset_tx = await step("reset the drill Kizashi", () => chain.reset());
  rec.rearm_txs = {};
  for (const v of cfg.vaults) {
    rec.rearm_txs[v] = await step(`re-arm ${v}`, async () => {
      const tx = await chain.rearm(v);
      const back = await waitFor(async () => (await chain.vaultEra(v)) === "Calm" && (await chain.dailyKeys(v)).length > 0, opts);
      need(back, `${v} did not return to calm with a daily key`);
      return tx;
    });
  }
  return rec;
}
