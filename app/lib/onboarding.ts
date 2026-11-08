// The pure part of the landing -> connect -> onboarding -> vault flow: given what is known, which step comes next.
// No network and no React here, so every branch is testable (lib/onboarding.test.ts). The page that uses it is
// app/(app)/start/page.tsx; the reads it asks for are in lib/vault-probe.ts.
import { isAccountId } from "./account.ts";
import type { Network } from "./network.ts";
import { createVaultGuard, type CreateGuard } from "./vault-create.ts";

/** What reading one account told us. `none` is a definite answer (no contract, or not a vault); `error` is a read that failed. */
export type ProbeResult = { ok: true } | { ok: false; kind: "none" | "error"; message: string };

export interface OnboardingInput {
  /** The connected wallet account, or null. */
  account: string | null;
  network: Network;
  /** Accounts to try, in order (see vaultCandidates). */
  candidates: readonly string[];
  /** What has been read so far, by account. A candidate with no entry has not been read yet. */
  results: Readonly<Record<string, ProbeResult>>;
}

export type OnboardingStep =
  | { kind: "connect" }
  | { kind: "checking"; account: string }
  | { kind: "open-vault"; account: string }
  /**
   * No candidate is a vault. `unreadable` lists candidates whose read failed: for those the answer is "unknown", never
   * "no vault", so the page must say it could not check them rather than claim they do not exist.
   */
  | { kind: "choose"; create: CreateGuard; unreadable: { account: string; message: string }[] };

/**
 * Accounts a connected account's vault might be, most likely first: the sub-account named `vault` (the name the Create
 * flow suggests in its own text), then the account itself (an account that is a vault). There is no indexer, so the
 * sub-accounts of an account cannot be listed; the person can always type another name.
 */
export function vaultCandidates(account: string | null): string[] {
  if (!account) return [];
  return [`vault.${account}`, account].filter((id, i, all) => isAccountId(id) && all.indexOf(id) === i);
}

/** The next step. The first candidate, in order, that is a vault wins; a candidate not read yet holds the decision. */
export function nextStep({ account, network, candidates, results }: OnboardingInput): OnboardingStep {
  if (!account) return { kind: "connect" };
  const unreadable: { account: string; message: string }[] = [];
  for (const candidate of candidates) {
    const r = results[candidate];
    if (!r) return { kind: "checking", account: candidate };
    if (r.ok) return { kind: "open-vault", account: candidate };
    if (r.kind === "error") unreadable.push({ account: candidate, message: r.message });
  }
  return { kind: "choose", create: createVaultGuard(network), unreadable };
}

/** Where the vault view for an account lives. The account goes in the query string: it is public chain data. */
export const vaultLink = (account: string): string => `/vault?account=${encodeURIComponent(account)}`;

/** The vault named in a `?account=` query, lower-cased, or null when it is missing or not an account name. */
export function accountFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get("account")?.trim().toLowerCase();
  return raw && isAccountId(raw) ? raw : null;
}

/**
 * A vault on NEAR testnet that the project's own run created, offered as something to look at when the connected
 * account has none. Testnet only; mainnet has none to offer. It is a demonstration vault with test funds.
 */
export const TESTNET_DEMO_VAULT = "pv-45cbcb96.kaigen-funder-ee0d56.testnet";

export const demoVaultFor = (network: Network): string | null => (network === "testnet" ? TESTNET_DEMO_VAULT : null);
