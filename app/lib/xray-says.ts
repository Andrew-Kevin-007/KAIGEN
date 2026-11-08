// What an account's access keys mean, in plain sentences. Each sentence states only what the key list proves: who holds
// a key is not on chain, so it never says an account is safe or unsafe, only what a holder of that key can do.
import type { KeyRow } from "./cage.ts";

const short = (k: string) => (k.length > 30 ? `${k.slice(0, 22)}...${k.slice(-6)}` : k);

export function plainFindings(rows: readonly KeyRow[], mamori: boolean): string[] {
  const out: string[] = [];
  const full = rows.filter((r) => r.kind === "full");
  const classical = full.filter((r) => r.curve === "classical");
  const pq = full.filter((r) => r.curve === "post-quantum");
  const fcs = rows.filter((r) => r.kind === "function-call");
  const odd = rows.filter((r) => r.kind === "unknown");
  if (classical.length) {
    out.push(
      `This account has ${classical.length === 1 ? "a full-access key" : `${classical.length} full-access keys`} of a classical type (${classical.map((r) => short(r.key)).join(", ")}). Whoever holds ${classical.length === 1 ? "it" : "one"} can take everything in the account, with no limit and no delay.`,
    );
  }
  if (pq.length) {
    out.push(
      `It has ${pq.length === 1 ? "a post-quantum full-access key" : `${pq.length} post-quantum full-access keys`}. Whoever holds ${pq.length === 1 ? "it" : "one"} can do anything the account can; the key type resists quantum attack, but holding it is still total control.`,
    );
  }
  if (fcs.length) {
    out.push(`${fcs.length === 1 ? "One function-call key limits its holder" : `${fcs.length} function-call keys limit their holders`} to the receivers and methods listed below; a function-call key cannot transfer the account's balance by itself.`);
  }
  if (odd.length) out.push(`${odd.length} key(s) have a permission this page does not know, so what they can do is not stated.`);
  if (rows.length === 0) out.push("This account has no access keys at all, so nothing can sign for it right now.");
  if (!mamori) {
    out.push("It does not answer as a Mamori vault (no attest() view in Mamori's shape), so the vault rows below could not be graded. Nothing here says whether the code on it is safe: only the keys are read.");
  }
  return out;
}
