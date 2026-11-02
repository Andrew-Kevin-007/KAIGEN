// The one place the app learns which contracts it talks to. It reads the same deployments.json the tooling under
// jobs/ reads (see deployments.example.json), as a JSON string in NEXT_PUBLIC_DEPLOYMENTS, and never throws: an
// unset field is "not deployed yet", a malformed one is a problem the pages say out loud. Nothing here is a default
// that looks like a real address.
import { isAccountId } from "./account.ts";
import type { Network } from "./network.ts";

export type { Network };

/** A recorded fire drill, in the shape `kaigen-jobs firetest` writes to fire-tests/NNNN.json. */
export interface DrillRecord {
  seq: number;
  /** Read from the Kizashi account's suffix: a record never claims a network its accounts are not on. */
  network: Network | null;
  kizashi: string;
  omenId: string;
  vaults: string[];
  /** The first recorded step that failed, or null when every step passed. The page does not describe a lockdown that did not finish. */
  failedStep: string | null;
  claimTx: string;
  claimBlock: number;
  tripTxs: Record<string, string>;
  verifiedBlock: number;
  pqSendTxs: Record<string, string>;
  resetTx: string | null;
  rearmTxs: Record<string, string>;
}

export interface Deployments {
  network: Network;
  rpc: string;
  /** The production Kizashi, or null while it is not deployed. */
  kizashi: string | null;
  /** The drill Kizashi (weekly fire test), or null. */
  drillKizashi: string | null;
  /** The account that holds the audited Mamori code, which Create vault copies onto a new vault. */
  mamoriReference: string | null;
  /** base58 sha-256 of that code. Create vault refuses code that does not match it. */
  mamoriCodeHash: string | null;
  drillRecord: DrillRecord | null;
  /** What is wrong with the configuration, in sentences. Empty when it is sound or simply absent. */
  problems: string[];
}

export const DEFAULT_RPC: Record<Network, string> = {
  mainnet: "https://rpc.mainnet.near.org",
  testnet: "https://rpc.testnet.near.org",
};

const BASE58_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
/** deployments.example.json is full of REPLACE-... placeholders; copied unchanged it must read as "not deployed". */
const isPlaceholder = (v: string) => /REPLACE/i.test(v);

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Which network an account id belongs to, by its top-level name; null for a name that says neither. */
export const networkOfAccount = (id: string): Network | null => (id.endsWith(".testnet") ? "testnet" : id.endsWith(".near") ? "mainnet" : null);

export type KizashiRole = "production" | "drill" | "other";

/**
 * How a vault's Kizashi relates to this deployment. A vault that follows any other Kizashi reports an era this site
 * cannot vouch for (anyone can deploy a Kizashi that says Calm), so the pages say so. With nothing deployed, every
 * Kizashi is "other".
 */
export function kizashiRole(id: string, d: Pick<Deployments, "kizashi" | "drillKizashi">): KizashiRole {
  if (d.kizashi && id === d.kizashi) return "production";
  if (d.drillKizashi && id === d.drillKizashi) return "drill";
  return "other";
}

function account(raw: unknown, name: string, problems: string[]): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") {
    problems.push(`${name} must be a NEAR account name.`);
    return null;
  }
  if (isPlaceholder(raw)) return null;
  // Built before the guard: `isAccountId` is a type guard, so on its false branch an already-string `raw` narrows to never.
  const shown = JSON.stringify(raw.slice(0, 80));
  if (!isAccountId(raw)) {
    problems.push(`${name} is not a valid NEAR account name (${shown}).`);
    return null;
  }
  return raw;
}

function txMap(raw: unknown, vaults: string[]): Record<string, string> | null {
  if (!isObject(raw)) return null;
  const out: Record<string, string> = {};
  for (const v of vaults) {
    const h = raw[v];
    if (typeof h !== "string" || !TX_HASH.test(h)) return null;
    out[v] = h;
  }
  return out;
}

const firstFailure = (steps: { ok: boolean; step?: unknown }[]): string | null => {
  const failed = steps.find((s) => !s.ok);
  return failed ? (typeof failed.step === "string" ? failed.step : "unnamed step") : null;
};

/**
 * Reads one fire-test record. Anything missing or malformed makes the whole record unusable (a table with a hole in it
 * would be a made-up drill), and the reason comes back so the page can say so instead of showing nothing.
 */
export function parseDrillRecord(raw: unknown): { record: DrillRecord } | { problem: string } {
  const bad = (why: string) => ({ problem: `The recorded drill is unusable: ${why}.` });
  if (!isObject(raw)) return bad("it is not an object");
  if (raw.drill !== true) return bad("it is not marked as a drill");
  if (typeof raw.seq !== "number" || !Number.isInteger(raw.seq) || raw.seq < 1) return bad("it has no sequence number");
  if (!isAccountId(raw.kizashi)) return bad("it names no Kizashi account");
  if (typeof raw.omen_id !== "string" || raw.omen_id === "") return bad("it names no omen");
  const vaults = raw.vaults;
  if (!Array.isArray(vaults) || vaults.length === 0 || !vaults.every(isAccountId)) return bad("it lists no valid vaults");
  const steps = raw.steps;
  if (!Array.isArray(steps) || steps.length === 0 || !steps.every((s) => isObject(s) && typeof s.ok === "boolean")) return bad("it has no recorded steps");
  if (typeof raw.claim_tx !== "string" || !TX_HASH.test(raw.claim_tx)) return bad("the claim transaction is missing");
  const isBlock = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;
  if (!isBlock(raw.claim_block) || !isBlock(raw.verified_block)) return bad("a block height is missing");
  const tripTxs = txMap(raw.trip_txs, vaults);
  const pqSendTxs = txMap(raw.pq_send_txs, vaults);
  const rearmTxs = txMap(raw.rearm_txs, vaults);
  if (!tripTxs || !pqSendTxs || !rearmTxs) return bad("a vault has no trip, send or re-arm transaction");
  const resetTx = raw.reset_tx;
  if (resetTx !== undefined && resetTx !== null && (typeof resetTx !== "string" || !TX_HASH.test(resetTx))) return bad("the reset transaction is malformed");
  return {
    record: {
      seq: raw.seq,
      network: networkOfAccount(raw.kizashi),
      kizashi: raw.kizashi,
      omenId: raw.omen_id,
      vaults: [...vaults],
      failedStep: firstFailure(steps as { ok: boolean; step?: unknown }[]),
      claimTx: raw.claim_tx,
      claimBlock: raw.claim_block,
      tripTxs,
      verifiedBlock: raw.verified_block,
      pqSendTxs,
      resetTx: (resetTx as string | null | undefined) ?? null,
      rearmTxs,
    },
  };
}

function rpcUrl(raw: unknown, network: Network, problems: string[]): string {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_RPC[network];
  if (typeof raw === "string" && !isPlaceholder(raw)) {
    try {
      const u = new URL(raw);
      if (u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"))) return raw.replace(/\/+$/, "");
    } catch {
      // falls through to the problem below
    }
    problems.push("rpc must be an https URL.");
  } else if (typeof raw !== "string") {
    problems.push("rpc must be an https URL.");
  }
  return DEFAULT_RPC[network];
}

/** Turns the text of NEXT_PUBLIC_DEPLOYMENTS into settings. Unset, empty and `{}` all mean "nothing deployed yet". */
export function parseDeployments(text: string | undefined): Deployments {
  const problems: string[] = [];
  let doc: Record<string, unknown> = {};
  if (text && text.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isObject(parsed)) doc = parsed;
      else problems.push("The deployments setting must be a JSON object.");
    } catch {
      problems.push("The deployments setting is not valid JSON.");
    }
  }
  if (doc.network !== undefined && doc.network !== "mainnet" && doc.network !== "testnet") {
    problems.push(`network must be "mainnet" or "testnet", not ${JSON.stringify(doc.network)}.`);
  }
  // Anything but an explicit testnet reads as mainnet, the stricter of the two.
  const network: Network = doc.network === "testnet" ? "testnet" : "mainnet";

  const drill = isObject(doc.drill) ? doc.drill : {};
  const kizashi = account(doc.kizashi, "kizashi", problems);
  const drillKizashi = account(drill.kizashi, "drill.kizashi", problems);
  const mamoriReference = account(doc.mamoriReference, "mamoriReference", problems);

  let mamoriCodeHash: string | null = null;
  if (typeof doc.mamoriCodeHash === "string" && doc.mamoriCodeHash !== "" && !isPlaceholder(doc.mamoriCodeHash)) {
    if (BASE58_HASH.test(doc.mamoriCodeHash)) mamoriCodeHash = doc.mamoriCodeHash;
    else problems.push("mamoriCodeHash must be a base58 sha-256 hash.");
  }

  for (const [name, id] of [["kizashi", kizashi], ["drill.kizashi", drillKizashi], ["mamoriReference", mamoriReference]] as const) {
    const on = id ? networkOfAccount(id) : null;
    if (on && on !== network) problems.push(`${name} (${id}) is a ${on} account, but network is ${network}.`);
  }

  let drillRecord: DrillRecord | null = null;
  if (doc.drillRecord !== undefined && doc.drillRecord !== null) {
    const r = parseDrillRecord(doc.drillRecord);
    if ("record" in r) drillRecord = r.record;
    else problems.push(r.problem);
  }

  return { network, rpc: rpcUrl(doc.rpc, network, problems), kizashi, drillKizashi, mamoriReference, mamoriCodeHash, drillRecord, problems };
}
