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

// ---- zero-key Kizashi ---------------------------------------------------------------------------------------
//
//   delete Kizashi's own full-access key -> confirm the account has no keys left -> confirm its views still
//   answer -> confirm the deleted key can no longer sign -> claim from an unrelated account with a drill omen
//   -> reset from an unrelated account -> confirm there are still no keys
//
// A Kizashi with no key cannot be upgraded, re-initialised or redeployed by anyone: that is the point. `claim`,
// `reset` (drill only) and the views need no key of Kizashi's, only the caller's, so they must keep working.
// Same shape as `runFireTest`: the orchestration only, every on-chain action goes through `chain`.

export class ZeroKeyError extends Error {
  constructor(step, message, record) {
    super(`zero-key step failed at "${step}": ${message}`);
    this.name = "ZeroKeyError";
    this.step = step;
    this.record = record;
  }
}

/** True for a list of access keys that is empty. `null` (the account does not exist) is not "no keys". */
export const hasNoKeys = (keys) => Array.isArray(keys) && keys.length === 0;

/**
 * Read-only. Throws when the rehearsal is not in a state this step can start from; otherwise returns what it found.
 * @param chain  { views, accessKeys }
 * @param cfg    { kizashi, omenId, ownKey }
 */
export async function zeroKeyPreflight({ chain, cfg }) {
  const v = await chain.views(cfg.kizashi);
  if (v.era !== "Calm") throw new Error("drill Kizashi is not calm; it needs a reset");
  const omen = v.omens?.find((o) => o.id === cfg.omenId);
  if (!omen) throw new Error(`drill Kizashi has no omen ${cfg.omenId}`);
  if (omen.death) throw new Error(`omen ${cfg.omenId} is already claimed; drill Kizashi needs a reset`);
  const keys = await chain.accessKeys(cfg.kizashi);
  if (keys === null) throw new Error(`${cfg.kizashi} does not exist`);
  if (keys.length === 0) return { keys, alreadyKeyless: true };
  const ours = keys.length === 1 && keys[0].public_key === cfg.ownKey && keys[0].access_key.permission === "FullAccess";
  // A key this step cannot delete would leave the account with keys, so the step could never end green: say so now.
  if (!ours) throw new Error(`${cfg.kizashi} holds keys other than its own full-access key ${cfg.ownKey}: ${keys.map((k) => k.public_key).join(", ")}`);
  return { keys, alreadyKeyless: false };
}

/** What a node says when a transaction names an access key the account no longer has. */
const KEY_GONE = /access.?key|AccessKeyNotFound|UNKNOWN_ACCESS_KEY/i;
export const isKeyGoneError = (message) => KEY_GONE.test(String(message ?? ""));

/**
 * @param chain  { views, accessKeys, deleteOwnKey, probeDeletedKey, claim, reset, blockHeight }
 * @param cfg    { kizashi, submitter, omenId, ownKey }
 * @param opts   { wait, tries } to stub sleeping in tests
 * @returns the record to publish. Throws ZeroKeyError (carrying the partial record) on any failed step.
 */
export async function runZeroKey({ chain, cfg, opts = {} }) {
  try {
    return await zeroKeySequence({ chain, cfg, opts });
  } catch (e) {
    // After a claim the drill Kizashi is in kaigen with a dead omen. Leave it there and the next run dies at
    // preflight. Try to put it back; Kizashi's key is not needed for that. Recorded either way.
    if (e instanceof ZeroKeyError && e.record?.claim_tx && !e.record.reset_tx) {
      try {
        e.record.cleanup = { reset_tx: await chain.reset(), errors: [] };
      } catch (err) {
        e.record.cleanup = { reset_tx: null, errors: [`reset: ${String(err.message ?? err)}`] };
      }
    }
    throw e;
  }
}

async function zeroKeySequence({ chain, cfg, opts }) {
  const rec = { zero_key: true, drill: true, ok: false, kizashi: cfg.kizashi, submitter: cfg.submitter, omen_id: cfg.omenId, deleted_key: cfg.ownKey, steps: [], warnings: [] };
  const step = async (name, fn) => {
    try {
      const out = await fn();
      rec.steps.push({ step: name, ok: true });
      return out;
    } catch (e) {
      rec.steps.push({ step: name, ok: false, error: String(e.message ?? e) });
      throw e instanceof ZeroKeyError ? e : new ZeroKeyError(name, String(e.message ?? e), rec);
    }
  };
  const need = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };

  const before = await step("preflight: calm, omen alive, Kizashi holds only its own key", () => zeroKeyPreflight({ chain, cfg }));
  rec.already_keyless = before.alreadyKeyless;

  if (!before.alreadyKeyless) rec.delete_tx = await step("delete Kizashi's own full-access key", () => chain.deleteOwnKey());
  rec.delete_block = await chain.blockHeight();

  await step("Kizashi has no access keys left", async () => {
    const gone = await waitFor(async () => hasNoKeys(await chain.accessKeys(cfg.kizashi)), opts);
    need(gone, `${cfg.kizashi} still has access keys after the delete`);
    rec.keys_after_delete = 0;
  });

  await step("the views still answer", async () => {
    const v = await chain.views(cfg.kizashi);
    need(v.era === "Calm", `era view answered ${JSON.stringify(v.era)}, expected "Calm"`);
    need(Array.isArray(v.omens) && v.omens.some((o) => o.id === cfg.omenId), `omens view does not list ${cfg.omenId}`);
    need(typeof v.bounty?.claimable === "boolean", "bounty view did not answer");
  });

  await step("the deleted key can no longer sign", async () => {
    const probe = await chain.probeDeletedKey();
    need(!probe.accepted, `a transaction signed with the deleted key was accepted (${probe.hash ?? "no hash"})`);
    rec.probe_error = String(probe.error ?? "").slice(0, 300);
    // The key list above is the proof. This probe is a second, protocol-level look, so a refusal worded in a way we
    // do not recognise (or a node that was just unreachable) is a warning to read, not a failure.
    if (!isKeyGoneError(probe.error)) rec.warnings.push(`the probe transaction was rejected, but not with an access-key error: ${rec.probe_error}`);
  });

  rec.claim_tx = await step("a third party claims with a valid drill omen", () => chain.claim(cfg.omenId));
  rec.claim_block = await chain.blockHeight();
  await step("the claim raised the era and killed the omen", async () => {
    const ok = await waitFor(async () => {
      const v = await chain.views(cfg.kizashi);
      return v.era === "Kaigen" && v.omens.find((o) => o.id === cfg.omenId)?.death ? v : null;
    }, opts);
    need(ok, "the claim did not raise the era to Kaigen and mark the omen dead");
  });

  rec.reset_tx = await step("a third party resets the drill Kizashi", () => chain.reset());
  await step("Kizashi is calm again and still has no access keys", async () => {
    const calm = await waitFor(async () => (await chain.views(cfg.kizashi)).era === "Calm", opts);
    need(calm, "the reset did not return the era to Calm");
    need(hasNoKeys(await chain.accessKeys(cfg.kizashi)), `${cfg.kizashi} has access keys again`);
  });

  rec.ok = true;
  return rec;
}

export function renderZeroKey(rec) {
  const lines = [`zero-key Kizashi ${rec.kizashi}${rec.already_keyless ? " (it had no keys already: nothing was deleted)" : ""}`, ""];
  for (const s of rec.steps) lines.push(`${s.ok ? "PASS" : "FAIL"}  ${s.step}${s.ok ? "" : `  (${s.error})`}`);
  for (const w of rec.warnings ?? []) lines.push(`WARN  ${w}`);
  return lines.join("\n");
}
