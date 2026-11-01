// The pure parts of Create vault: the fallback that works without a post-quantum wallet. The connected wallet
// creates and funds the vault account and gives it a temporary key that lives only in this browser tab; that
// key adds the ML-DSA admin key and then deletes itself. Only the admin's PUBLIC key is ever needed here.
import { toUnits } from "./units.ts";

/** Off unless NEXT_PUBLIC_VAULT_CREATE=1, until gates G1 and G3 have passed on mainnet. */
export const VAULT_CREATE_ENABLED = process.env.NEXT_PUBLIC_VAULT_CREATE === "1";

export type StepId = "create" | "admin" | "cleanup" | "check";
export const STEP_ORDER: readonly StepId[] = ["create", "admin", "cleanup", "check"];

export type StepStatus = "todo" | "running" | "done" | "failed";
export interface StepState {
  id: StepId;
  status: StepStatus;
  /** Transaction hash, shown so each step can be checked on an explorer. */
  tx?: string;
  error?: string;
}

export const initialSteps = (): StepState[] => STEP_ORDER.map((id) => ({ id, status: "todo" }));

/** "Part 2 of 3": a place in a list, counted from 1. */
export const placeCaption = (noun: string, index: number, total: number): string => `${noun} ${index + 1} of ${total}`;

/** "Step 2 of 4", read from the real step list, so adding or dropping a step cannot leave a stale count behind. */
export const stepCaption = (id: StepId): string => placeCaption("Step", STEP_ORDER.indexOf(id), STEP_ORDER.length);

/** Which step (counted from 1) removes the temporary key, after which closing the tab no longer strands the vault. */
export const TEMP_KEY_GONE_AT = STEP_ORDER.indexOf("cleanup") + 1;

/** The step to run next: the first one not done (a failed one comes round again), and none while a step runs. */
export function nextStep(steps: readonly StepState[]): StepId | null {
  if (steps.some((s) => s.status === "running")) return null;
  return steps.find((s) => s.status !== "done")?.id ?? null;
}

const replace = (steps: readonly StepState[], next: StepState): StepState[] => steps.map((s) => (s.id === next.id ? next : s));

export function begin(steps: readonly StepState[], id: StepId): StepState[] {
  if (nextStep(steps) !== id) throw new Error(`Step ${id} is out of order, or another step is running.`);
  return replace(steps, { id, status: "running" });
}

function running(steps: readonly StepState[], id: StepId) {
  if (steps.find((s) => s.id === id)?.status !== "running") throw new Error(`Step ${id} is not running.`);
}

export function finish(steps: readonly StepState[], id: StepId, tx?: string | null): StepState[] {
  running(steps, id);
  return replace(steps, { id, status: "done", ...(tx ? { tx } : {}) });
}

export function fail(steps: readonly StepState[], id: StepId, error: string): StepState[] {
  running(steps, id);
  return replace(steps, { id, status: "failed", error });
}

/** What to do after a failure, written for someone who has not seen the code. Null when nothing failed. */
export function recoveryNote(steps: readonly StepState[], vault: string, tempKey: string): string | null {
  const failed = steps.find((s) => s.status === "failed");
  if (!failed) return null;
  switch (failed.id) {
    case "create":
      return `The wallet request did not finish. Check whether ${vault} exists before trying again. If it does, it already has this tab's temporary key on it (${tempKey}): use "Check the chain and continue". If it does not, start this step again.`;
    case "admin":
      return `${vault} exists and holds no admin key yet. Its only key is the temporary one (${tempKey}), and only this tab has it. Retry this step and keep this tab open: if the tab closes first, nobody can control ${vault}.`;
    case "cleanup":
      return `Your admin key is on ${vault}, but the temporary full-access key ${tempKey} is still there. Retry this step. If this tab closes first, your admin key must delete ${tempKey}; until it is gone, treat ${vault} as not yet safe.`;
    case "check":
      return `The transactions went through, but the final key list is not what was expected: ${failed.error ?? "unknown"}. Do not fund ${vault} until it lists only your admin key.`;
  }
}

/** Null when the vault's keys are exactly the admin key. `adminHandle` is how the RPC lists an ML-DSA key. */
export function finalKeysError(keys: readonly { public_key: string }[], adminHandle: string, tempKey: string): string | null {
  const found = keys.map((k) => k.public_key);
  if (found.length === 0) return "The vault has no keys at all.";
  if (found.includes(tempKey)) return "The temporary key is still on the vault.";
  if (!found.includes(adminHandle)) return "The admin key is not on the vault.";
  if (found.length > 1) return "The vault has keys other than your admin key.";
  return null;
}

const failureOf = (status: unknown): string | null =>
  status && typeof status === "object" && "Failure" in status ? JSON.stringify((status as { Failure: unknown }).Failure) : null;

/** A transaction can be accepted and still fail in an action or a later receipt; this finds that. */
export function outcomeFailure(outcome: unknown): string | null {
  const o = outcome as { status?: unknown; receipts_outcome?: { outcome?: { status?: unknown } }[] } | null | undefined;
  if (!o || typeof o !== "object") return null;
  const own = failureOf(o.status);
  if (own) return own;
  for (const r of o.receipts_outcome ?? []) {
    const f = failureOf(r?.outcome?.status);
    if (f) return f;
  }
  return null;
}

export function txHashOf(outcome: unknown): string | null {
  const o = outcome as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } } | null | undefined;
  return o?.transaction?.hash ?? o?.transaction_outcome?.id ?? null;
}

export const txUrl = (network: "mainnet" | "testnet", hash: string) => `https://${network === "testnet" ? "testnet." : ""}nearblocks.io/txns/${hash}`;

const LABEL = /^[a-z0-9]+([-_][a-z0-9]+)*$/;

/** The vault is a sub-account of the connected wallet account, which is the only account allowed to create it. */
export function vaultAccountId(label: string, parent: string): { ok: true; id: string } | { ok: false; error: string } {
  if (label.length < 2 || label.length > 32 || !LABEL.test(label)) {
    return { ok: false, error: "Use 2 to 32 lowercase letters, digits, - or _, starting and ending with a letter or digit." };
  }
  const id = `${label}.${parent}`;
  if (id.length > 64) return { ok: false, error: "That name makes the account id longer than 64 characters." };
  return { ok: true, id };
}

/** 0.05 NEAR: the account's storage and the gas for the next two transactions, which the vault pays itself. */
const MIN_FUNDING = 5n * 10n ** 22n;

/** NEAR as typed to yoctoNEAR, or null if it is not a plain amount of at least the minimum. */
export function fundingYocto(near: string): string | null {
  const y = toUnits(near, 24);
  return y !== null && BigInt(y) >= MIN_FUNDING ? y : null;
}

// The full text of an ML-DSA-65 public key is about 2,600 characters. The library's decoder does the real
// validation when the key is used; this only recognises the shape so the wrong paste is caught early.
const looksLikeAdminKey = (s: string) => /^ml-dsa-65:\S{1000,}$/.test(s);

/** The Protect page links here with the key in the fragment, which the browser never sends to a server. */
export function adminKeyFromHash(hash: string): string | null {
  const m = /^#?key=(.+)$/.exec(hash);
  if (!m) return null;
  try {
    const key = decodeURIComponent(m[1]);
    return looksLikeAdminKey(key) ? key : null;
  } catch {
    return null;
  }
}

/** The backup file holds the public key in the clear next to the encrypted seed; only the public key is read. */
export function adminKeyFromBackupText(text: string): string | null {
  try {
    const f = JSON.parse(text) as { app?: unknown; publicKey?: unknown };
    return f.app === "kaigen" && typeof f.publicKey === "string" && looksLikeAdminKey(f.publicKey) ? f.publicKey : null;
  } catch {
    return null;
  }
}
