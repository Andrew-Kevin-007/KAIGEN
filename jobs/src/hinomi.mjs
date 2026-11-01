// Hinomi (火の見): the daily quantum-exposure index. How much NEAR sits behind classical-only keys,
// and how much is already post-quantum.
//
// Timestamps come from the chain (block height and hash), never the local clock, so a run can be
// reproduced and audited against a block.
import fs from "node:fs";
import path from "node:path";
import { classifyKeys, exposure } from "./classify.mjs";
import { pool } from "./rpc.mjs";

const CLASSES = ["classical-only", "mixed", "post-quantum", "locked"];

/**
 * @param rpc        from makeRpc
 * @param accounts   top NEAR accounts to sample (source still open: gate G7)
 * @param vaults     every known KAIGEN vault
 */
export async function snapshot({ rpc, accounts, vaults = [], concurrency = 8 }) {
  // Every read below is pinned to this one final block, so the snapshot is auditable against it.
  const block = await rpc.finalBlock();
  const vaultSet = new Set(vaults);
  const ids = [...new Set([...accounts, ...vaults])];

  const rows = await pool(ids, concurrency, async (id) => {
    let acc, keys;
    try {
      [acc, keys] = await Promise.all([rpc.account(id, block.hash), rpc.accessKeys(id, block.hash)]);
    } catch (e) {
      // One unreadable account (rate limit, bad node) must not lose the other rows.
      return { id, error: String(e.message ?? e) };
    }
    if (!acc || !keys) return { id, missing: true };
    const c = classifyKeys(keys);
    return {
      id,
      balance: acc.amount, // liquid balance only: staked and locked NEAR are not counted
      exposure: exposure(keys),
      vault: vaultSet.has(id),
      truncated: keys.truncated === true, // more keys than Hinomi will page through; exposure is a lower bound
      classicalFullAccess: c.classicalFullAccess,
    };
  });

  const present = rows.filter((r) => !r.missing && !r.error);
  const byClass = Object.fromEntries(CLASSES.map((c) => [c, { accounts: 0, yocto: 0n }]));
  for (const r of present) {
    byClass[r.exposure].accounts += 1;
    byClass[r.exposure].yocto += BigInt(r.balance);
  }
  const exposedYocto = byClass["classical-only"].yocto + byClass.mixed.yocto;
  const pqYocto = byClass["post-quantum"].yocto;

  // A vault with its own classical full-access key bypasses the model: the app and Hinomi flag it.
  const flagged = present.filter((r) => r.vault && r.classicalFullAccess.length > 0).map((r) => r.id);

  return {
    block_height: block.height,
    block_hash: block.hash,
    sampled: present.length,
    missing: rows.filter((r) => r.missing).map((r) => r.id),
    errors: rows.filter((r) => r.error).map((r) => ({ id: r.id, error: r.error })),
    truncated: present.filter((r) => r.truncated).map((r) => r.id),
    exposed_yocto: exposedYocto.toString(),
    post_quantum_yocto: pqYocto.toString(),
    classes: Object.fromEntries(CLASSES.map((c) => [c, { accounts: byClass[c].accounts, yocto: byClass[c].yocto.toString() }])),
    flagged_vaults: flagged,
    rows: present.map((r) => ({ ...r })),
  };
}

/**
 * Writes `latest.json` (full detail) and appends one summary line to `history.jsonl`.
 * Returns "appended", "duplicate" (same block) or "partial". A snapshot with unreadable accounts is
 * never added to history: it would show a false drop in exposure.
 */
export function record(dir, snap) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(snap, null, 2));
  if (snap.errors.length > 0) return "partial";
  const { rows, ...summary } = snap;
  const file = path.join(dir, "history.jsonl");
  const last = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split(String.fromCharCode(10)).pop() : "";
  // The same block twice would just duplicate a line.
  if (last && JSON.parse(last).block_hash === summary.block_hash) return "duplicate";
  fs.appendFileSync(file, JSON.stringify(summary) + String.fromCharCode(10));
  return "appended";
}
