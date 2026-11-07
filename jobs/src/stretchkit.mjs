// Helpers shared by stretchdrill.mjs (steps 1 to 5) and stretchext.mjs (steps 6 to 8). Pure: nothing here signs or reads a chain.

export const NEAR = 10n ** 24n;
export const STORAGE_YOCTO_PER_BYTE = 10n ** 19n;
export const TGAS_ADMIN = 30;
export const SECRET_FREE = (s) => String(s).replace(/(ed25519|secp256k1|ml-dsa-65(-hash)?):[1-9A-HJ-NP-Za-km-z]{20,}/g, (m) => `${m.slice(0, m.indexOf(":") + 9)}...`);

export const message = (e) => String(e?.message ?? e);
export const call = (method, args = {}, gasTgas = TGAS_ADMIN) => ({ type: "FunctionCall", method, args, gasTgas, depositYocto: 0 });
export const check = (name, ok, detail, tx = null) => ({ name, ok: !!ok, detail, tx });
export const bal = (acc) => (acc ? BigInt(acc.amount) : null);
export const freeYocto = (acc) => BigInt(acc.amount) - BigInt(acc.storage_usage) * STORAGE_YOCTO_PER_BYTE;
export const logsOf = (outcome) => (outcome?.receipts_outcome ?? []).flatMap((r) => r.outcome?.logs ?? []);
export const executorsOf = (outcome) => new Set((outcome?.receipts_outcome ?? []).map((r) => r.outcome?.executor_id).filter(Boolean));

/** Gas burnt by a whole transaction (its own conversion receipt and every receipt it spawned), in gas units. */
export const gasBurntOf = (outcome) => BigInt(outcome?.transaction_outcome?.outcome?.gas_burnt ?? 0) + (outcome?.receipts_outcome ?? []).reduce((a, r) => a + BigInt(r.outcome?.gas_burnt ?? 0), 0n);

/** What a chain-level refusal looks like once the sender has thrown: `transaction <hash> failed: {... panicked: <text> ...}`. */
export function refusalOf(e) {
  const m = message(e);
  const tx = /transaction ([1-9A-HJ-NP-Za-km-z]{32,50}) failed/.exec(m)?.[1] ?? null;
  const text = /panicked: ?([^"\\}]*)/.exec(m)?.[1]?.trim() ?? null;
  return { tx, text, raw: SECRET_FREE(m).slice(0, 300) };
}
