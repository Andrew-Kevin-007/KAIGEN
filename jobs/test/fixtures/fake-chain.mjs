// A small in-memory chain for the prodvault / plant-key tests: accounts, keys, one Mamori-like contract per account, and a
// sender that applies the action descriptors of globaltx.mjs the way the chain would (or throws what the chain would fail with).
// No network, no real funds; every key is generated in memory by the test.
import { publicKeyToHandle } from "@fastnear/ml-dsa-65";
import { toBase58 } from "@fastnear/utils";
import { sha256 } from "@noble/hashes/sha2.js";

export const NEAR = 10n ** 24n;
const EMPTY = "11111111111111111111111111111111";
const DEFAULT_ALLOWANCE = (NEAR / 4n).toString();
export const listedKey = (full) => (full.startsWith("ml-dsa-65:") ? publicKeyToHandle(full) : full);
export const codeHashOfBytes = (bytes) => toBase58(sha256(bytes));

export function makeWorld({ funderId, funderPublic, funderYocto = 60n * NEAR, chain = "testnet", extraAccounts = [] } = {}) {
  const accounts = new Map([[funderId, { amount: funderYocto.toString(), storage_usage: 182, code_hash: EMPTY }]]);
  for (const id of extraAccounts) accounts.set(id, { amount: (10n * NEAR).toString(), storage_usage: 182, code_hash: EMPTY });
  return {
    chain_id: chain,
    protocol_version: 88,
    height: 1_000,
    accounts,
    keys: new Map([[funderId, [{ listed: funderPublic, full: funderPublic, nonce: 5, permission: "FullAccess" }]]]),
    contracts: new Map(),
    requests: [],
    sent: [],
  };
}

const sizeOf = (acc) => acc.storage_usage;

/** Applies descriptors to a staged copy; commits only if every action succeeds (a failed action fails the whole transaction). */
export function applyActions(w, signerId, signer, receiverId, list) {
  const staged = {
    accounts: new Map([...w.accounts].map(([k, v]) => [k, { ...v }])),
    keys: new Map([...w.keys].map(([k, v]) => [k, v.map((x) => ({ ...x }))])),
    contracts: new Map([...w.contracts].map(([k, v]) => [k, structuredClone(v)])),
  };
  const signerKeys = w.keys.get(signerId) ?? [];
  if (!signerKeys.some((k) => k.full === signer.publicKey && k.permission === "FullAccess")) throw new Error(`AccessKeyNotFound: ${signer.publicKey} is not a full-access key of ${signerId}`);
  for (const a of list) {
    const acc = staged.accounts.get(receiverId);
    if (a.type === "CreateAccount") {
      if (acc) throw new Error("AccountAlreadyExists");
      staged.accounts.set(receiverId, { amount: "0", storage_usage: 182, code_hash: EMPTY });
    } else if (a.type === "Transfer") {
      const from = staged.accounts.get(signerId);
      if (BigInt(from.amount) < BigInt(a.yocto)) throw new Error("LackBalanceForState");
      from.amount = (BigInt(from.amount) - BigInt(a.yocto)).toString();
      const to = staged.accounts.get(receiverId);
      to.amount = (BigInt(to.amount) + BigInt(a.yocto)).toString();
    } else if (a.type === "AddKey") {
      staged.keys.set(receiverId, [...(staged.keys.get(receiverId) ?? []), { listed: listedKey(a.publicKey), full: a.publicKey, nonce: 1, permission: "FullAccess" }]);
    } else if (a.type === "AddKeyFunctionCall") {
      staged.keys.set(receiverId, [
        ...(staged.keys.get(receiverId) ?? []),
        { listed: a.publicKey, full: a.publicKey, nonce: 1, permission: { FunctionCall: { allowance: a.allowanceYocto === null ? null : String(a.allowanceYocto), receiver_id: a.receiverId, method_names: a.methods } } },
      ]);
    } else if (a.type === "DeleteKey") {
      const list2 = staged.keys.get(receiverId) ?? [];
      if (!list2.some((k) => k.listed === listedKey(a.publicKey) || k.full === a.publicKey)) throw new Error("DeleteKeyDoesNotExist");
      staged.keys.set(receiverId, list2.filter((k) => !(k.listed === listedKey(a.publicKey) || k.full === a.publicKey)));
    } else if (a.type === "DeployContract") {
      if (signerId !== receiverId && !w.allowForeignDeploy) throw new Error("only the account itself deploys here");
      acc.code_hash = codeHashOfBytes(a.code);
      acc.storage_usage = 182 + a.code.length;
      if (BigInt(acc.amount) < BigInt(acc.storage_usage) * 10n ** 19n) throw new Error("LackBalanceForState (storage of the code)");
    } else if (a.type === "FunctionCall") {
      if (acc.code_hash === EMPTY) throw new Error("CodeDoesNotExist");
      if (signerId !== receiverId) throw new Error(`Smart contract panicked: Method ${a.method} is private`);
      const c = staged.contracts.get(receiverId);
      if (a.method === "init") {
        if (c) throw new Error("Smart contract panicked: The contract has already been initialized");
        if (a.args.delay_secs < 86_400) throw new Error("Smart contract panicked: withdrawal delay must be at least 24 hours");
        staged.contracts.set(receiverId, { config: { kizashi: a.args.kizashi, era: "Calm", daily_limit: a.args.daily_limit, delay_secs: a.args.delay_secs }, daily: [], allow: [], enforced: false });
      } else if (!c) throw new Error("Smart contract panicked: not initialized");
      else if (a.method === "allow_recipient") c.allow.push(a.args.account);
      else if (a.method === "enforce_allowlist") c.enforced = a.args.on;
      else if (a.method === "add_daily_key") {
        c.daily.push(a.args.public_key);
        staged.keys.set(receiverId, [...(staged.keys.get(receiverId) ?? []), { listed: a.args.public_key, full: a.args.public_key, nonce: 1, permission: { FunctionCall: { allowance: DEFAULT_ALLOWANCE, receiver_id: receiverId, method_names: ["send_small", "request_withdraw"] } } }]);
      } else throw new Error(`the test world does not know ${a.method}`);
    } else throw new Error(`unhandled action ${a.type}`);
  }
  w.accounts = staged.accounts;
  w.keys = staged.keys;
  w.contracts = staged.contracts;
}

/** A sender that applies descriptor actions to the world and records each call (the signer object included). */
export function fakeSender(w, events = [], { before } = {}) {
  let n = 0;
  return async ({ signerId, signer, receiverId, actions }) => {
    events.push({ kind: "send", signerId, receiverId, actions, signer });
    if (before) await before({ signerId, receiverId, actions, signer, index: n });
    applyActions(w, signerId, signer, receiverId, actions);
    w.height += 3;
    w.sent.push({ signerId, receiverId, types: actions.map((a) => a.type) });
    return { hash: `TX${++n}`, outcome: { status: { SuccessValue: "" } } };
  };
}

const attestOf = (w, vault) => {
  const c = w.contracts.get(vault);
  return {
    attest_version: 1,
    contract: "mamori",
    drill_build: false,
    account_id: vault,
    block_height: String(w.height),
    block_timestamp: "1",
    config: c.config,
    min_delay_secs: 86_400,
    allowlist_enforced: c.enforced,
    allowlist_len: c.allow.length,
    daily_keys: c.daily.map((public_key) => ({ public_key, strikes: 0 })),
    intents_keys: [],
    revoked_keys: [],
    queue_len: 0,
    note: "informational",
    policy_account: null,
    safe_account: { current: null, pending: null },
    watchers: [],
    emergency_until: "0",
    proposals: [],
  };
};

/** The read half of rpc.mjs (`status`, `account`, `accessKeys`, `finalBlock`, `view`), recording every call so a test can show a run read only. */
export function fakeRpc(w) {
  const log = (name, args) => w.requests.push({ name, args });
  return {
    async status() {
      log("status", []);
      return { chain_id: w.chain_id, protocol_version: w.protocol_version };
    },
    async finalBlock() {
      log("finalBlock", []);
      return { height: w.height, hash: toBase58(new Uint8Array(32).fill(9)) };
    },
    async account(id) {
      log("account", [id]);
      const a = w.accounts.get(id);
      return a ? { locked: "0", ...a } : null;
    },
    async accessKeys(id) {
      log("accessKeys", [id]);
      if (!w.accounts.has(id)) return null;
      return (w.keys.get(id) ?? []).map((k) => ({ public_key: k.listed, access_key: { nonce: k.nonce, permission: k.permission } }));
    },
    async view(id, method) {
      log("view", [id, method]);
      const c = w.contracts.get(id);
      if (!c) throw new Error("wasm execution failed with error: FunctionCallError(MethodResolveError(MethodNotFound))");
      const views = { config: c.config, daily_keys: c.daily, intents_keys: [], revoked_keys: [], attest: attestOf(w, id) };
      if (!(method in views)) throw new Error("MethodNotFound");
      return views[method];
    },
  };
}

export const READ_METHODS = new Set(["status", "finalBlock", "account", "accessKeys", "view"]);
