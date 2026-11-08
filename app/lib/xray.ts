// Reads what X-ray needs from the configured RPC (never an address the visitor typed), all at one final block, and
// hands it to lib/cage.ts. Read-only: view_account, view_access_key_list, status/block and view calls. No key, no signing.
import { evaluateCage, KNOWN_PINS, type AccountInfo, type AttestRead, type CageFacts, type CageResult, type Policy, type RpcKey, type ViewResult } from "./cage.ts";
import { rpc, rpcNetworkProblem } from "./near.ts";
import { errorText } from "./errors.ts";

const NO_ACCOUNT = /does not exist while viewing|UNKNOWN_ACCOUNT/;
const NO_VIEW = /MethodNotFound|MethodResolveError|method .*not found|CodeDoesNotExist|no contract code/i;

export class NoSuchAccount extends Error {}

async function viewAt(account: string, method: string, blockHash: string, signal?: AbortSignal): Promise<unknown> {
  const r = await rpc<{ result: number[] }>(
    "query",
    { request_type: "call_function", block_id: blockHash, account_id: account, method_name: method, args_base64: btoa("{}") },
    signal,
  );
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result))) as unknown;
}

/** A view that may not exist or may fail: `{ value }` or `{ error }`, never a throw (an aborted read is rethrown). */
async function tryView(account: string, method: string, blockHash: string, signal?: AbortSignal): Promise<ViewResult> {
  try {
    return { value: await viewAt(account, method, blockHash, signal) };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { error: errorText(e, "the view failed") };
  }
}

async function readAttest(account: string, blockHash: string, signal?: AbortSignal): Promise<AttestRead> {
  const r = await tryView(account, "attest", blockHash, signal);
  if ("value" in r) return { status: "present", raw: r.value };
  return NO_VIEW.test(r.error ?? "") ? { status: "absent", error: r.error } : { status: "error", error: r.error };
}

/**
 * Everything one run reads, pinned to one final block. Throws NoSuchAccount when the account does not exist, and the
 * network problem (as an Error) when the RPC does not serve the network this site is set up for.
 */
export async function readCageFacts(account: string, signal?: AbortSignal): Promise<CageFacts> {
  const wrongNetwork = await rpcNetworkProblem(signal);
  if (wrongNetwork) throw new Error(wrongNetwork);
  const block = await rpc<{ header: { height: number; hash: string } }>("block", { finality: "final" }, signal);
  const at = { block_id: block.header.hash };
  try {
    const [acc, keys] = await Promise.all([
      rpc<AccountInfo>("query", { request_type: "view_account", account_id: account, ...at }, signal),
      rpc<{ keys: RpcKey[] }>("query", { request_type: "view_access_key_list", account_id: account, ...at }, signal),
    ]);
    const [daily, intents, revoked, config, attest] = await Promise.all([
      tryView(account, "daily_keys", block.header.hash, signal),
      tryView(account, "intents_keys", block.header.hash, signal),
      tryView(account, "revoked_keys", block.header.hash, signal),
      tryView(account, "config", block.header.hash, signal),
      readAttest(account, block.header.hash, signal),
    ]);
    return { account, block: { height: block.header.height, hash: block.header.hash }, acc, keys: keys.keys, recorded: { daily, intents, revoked }, config, attest };
  } catch (e) {
    if (NO_ACCOUNT.test(e instanceof Error ? e.message : String(e))) throw new NoSuchAccount(`${account} does not exist on this network, so there is no cage to check.`);
    throw e;
  }
}

export interface XrayOptions {
  /** A code hash the visitor expects (base58). Optional. */
  expectedCodeHash?: string;
  /** The admin key the visitor expects, as the chain spells it. Optional. */
  expectedAdmin?: string;
}

export interface Xray {
  facts: CageFacts;
  result: CageResult;
}

export async function xray(account: string, options: XrayOptions = {}, signal?: AbortSignal): Promise<Xray> {
  const facts = await readCageFacts(account, signal);
  const policy: Policy = {
    admin: options.expectedAdmin || undefined,
    userPins: options.expectedCodeHash ? [options.expectedCodeHash] : [],
    knownPins: [...KNOWN_PINS],
  };
  return { facts, result: evaluateCage(facts, policy) };
}
