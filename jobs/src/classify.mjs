// Classifies an account's access keys for Hinomi and the verifiers.
//
// Only full-access keys can move funds directly, so they decide exposure. Function-call keys are
// reported separately: Mamori's daily keys are function-call keys and are bounded by design.

export const keyKind = (publicKey) =>
  publicKey.startsWith("ml-dsa-65") ? "post-quantum" : "classical";

const isFullAccess = (k) => k.access_key.permission === "FullAccess";

/**
 * @param keys the `keys` array of view_access_key_list
 * @returns {{ classicalFullAccess: string[], postQuantumFullAccess: string[], functionCall: string[] }}
 */
export function classifyKeys(keys) {
  const out = { classicalFullAccess: [], postQuantumFullAccess: [], functionCall: [] };
  for (const k of keys) {
    if (isFullAccess(k)) {
      (keyKind(k.public_key) === "post-quantum" ? out.postQuantumFullAccess : out.classicalFullAccess).push(k.public_key);
    } else {
      out.functionCall.push(k.public_key);
    }
  }
  return out;
}

/**
 * exposed:       a classical full-access key exists, so a broken curve can take the funds
 * post-quantum:  full access is post-quantum only
 * locked:        no full-access key at all (nothing can move funds directly)
 */
export function exposure(keys) {
  const c = classifyKeys(keys);
  if (c.classicalFullAccess.length > 0) return c.postQuantumFullAccess.length > 0 ? "mixed" : "classical-only";
  return c.postQuantumFullAccess.length > 0 ? "post-quantum" : "locked";
}
