// Read-only NEAR access: view calls over JSON-RPC. No keys, no signing, no third-party SDK.
import { DEPLOYMENTS } from "./config.ts";
import { NETWORK, networkProblem } from "./network.ts";

export const RPC_URL = DEPLOYMENTS.rpc;
/** Empty while the production Kizashi is not deployed. */
export const KIZASHI_ID = DEPLOYMENTS.kizashi ?? "";
/** Empty while there is no drill Kizashi. */
export const DRILL_KIZASHI_ID = DEPLOYMENTS.drillKizashi ?? "";

export type Era = "Calm" | "Warning" | "Kaigen";

export interface Omen {
  id: string;
  curve: "Ed25519" | "Secp256k1";
  level: Era;
  public_key: string;
  death: null | { block: string; claimant: string; signature: string };
}

export interface Bounty {
  near: string; // yoctoNEAR
  usdc_token: string | null;
}

export interface VaultConfig {
  kizashi: string;
  era: Era;
  daily_limit: string; // yoctoNEAR
  delay_secs: number;
  effective_delay_secs: number;
}

export interface QueuedWithdrawal {
  id: string;
  token: string | null;
  amount: string;
  to: string;
  requested_at: string;
  unlocks_at: string; // ns
}

export async function rpc<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "kaigen", method, params }),
    signal,
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.data ?? body.error.message ?? "RPC error");
  if (body.result?.error) throw new Error(body.result.error);
  return body.result as T;
}

export async function view<T>(contract: string, method: string, args: object = {}, signal?: AbortSignal): Promise<T> {
  const result = await rpc<{ result: number[] }>(
    "query",
    {
      request_type: "call_function",
      finality: "final",
      account_id: contract,
      method_name: method,
      args_base64: btoa(JSON.stringify(args)),
    },
    signal,
  );
  return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result))) as T;
}

const NO_CODE = "11111111111111111111111111111111";

export interface AccountView {
  code_hash: string;
  global_contract_hash?: string | null;
  global_contract_account_id?: string | null;
}

export const viewAccount = (accountId: string, signal?: AbortSignal) =>
  rpc<AccountView>("query", { request_type: "view_account", finality: "final", account_id: accountId }, signal);

/** The chain id the RPC serves ("mainnet", "testnet"), so a page can tell which network it is really reading. */
export async function chainId(signal?: AbortSignal): Promise<string> {
  return (await rpc<{ chain_id: string }>("status", [], signal)).chain_id;
}

/** A sentence when the RPC does not serve the network this deployment is set up for, or null when it does. Checked before a page shows anything it read. */
export async function rpcNetworkProblem(signal?: AbortSignal): Promise<string | null> {
  return networkProblem(NETWORK, await chainId(signal));
}

export interface AccessKey {
  /** A full key, or an ml-dsa-65-hash: handle for an ML-DSA key. */
  public_key: string;
  access_key: { nonce: number; permission: unknown };
}

export async function accessKeys(accountId: string, signal?: AbortSignal): Promise<AccessKey[]> {
  const r = await rpc<{ keys: AccessKey[] }>("query", { request_type: "view_access_key_list", finality: "final", account_id: accountId }, signal);
  return r.keys;
}

/**
 * Whether an account runs a contract: its own code, or a global contract it points to (which is how
 * Mamori vaults may be deployed). Returns false only when the account has no code or does not exist.
 * A network failure is thrown, never reported as "no contract", so an outage is not mistaken for a verdict.
 */
export async function hasContract(accountId: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const acc = await viewAccount(accountId, signal);
    return acc.code_hash !== NO_CODE || Boolean(acc.global_contract_hash) || Boolean(acc.global_contract_account_id);
  } catch (e) {
    if (/does not exist while viewing|UNKNOWN_ACCOUNT/.test((e as Error).message)) return false;
    throw e;
  }
}

const ERAS: readonly Era[] = ["Calm", "Warning", "Kaigen"];

/** Narrows a value from the chain: a contract that returns something unexpected must not crash the page. */
export const isEra = (v: unknown): v is Era => typeof v === "string" && (ERAS as readonly string[]).includes(v);

export const yoctoToNear = (yocto: string, digits = 4): string => {
  const y = BigInt(yocto || "0");
  const whole = y / 10n ** 24n;
  const frac = (y % 10n ** 24n).toString().padStart(24, "0").slice(0, digits);
  return `${whole.toLocaleString("en-US")}.${frac}`;
};
