// Minimal NEAR JSON-RPC client. Read-only, with retry on transient failures. Everything the jobs read
// goes through here so tests can swap in a fake `fetch`.

export class RpcError extends Error {
  constructor(message, { kind = "RPC", data } = {}) {
    super(message);
    this.name = "RpcError";
    this.kind = kind;
    this.data = data;
  }
}

const MAX_KEY_PAGES = 50;
const REQUEST_TIMEOUT_MS = 20_000;
/** Node-side errors that say "try again", as opposed to "your request is wrong". */
const TRANSIENT_NAMES = /TIMEOUT_ERROR|UNAVAILABLE_SHARD|INTERNAL_ERROR|NO_SYNCED_BLOCKS|REQUEST_TIMEOUT/;
const describe = (v) => (typeof v === "string" ? v : JSON.stringify(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");

export function makeRpc(url, { fetchImpl = fetch, retries = 5, backoffMs = 500 } = {}) {
  async function call(method, params) {
    let last;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "kaigen", method, params }),
          // A stalled connection must not hold a whole pass for undici's multi-minute default.
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (res.status === 429 || res.status >= 500) throw new RpcError(`HTTP ${res.status}`, { kind: "TRANSIENT" });
        const body = await res.json();
        if (body.error) {
          const name = `${body.error.cause?.name ?? ""} ${body.error.name ?? ""}`;
          const kind = /UNKNOWN_ACCOUNT|UNKNOWN_ACCESS_KEY|TOO_MANY_ACCESS_KEYS/.test(name)
            ? name.match(/UNKNOWN_ACCOUNT|UNKNOWN_ACCESS_KEY|TOO_MANY_ACCESS_KEYS/)[0]
            : TRANSIENT_NAMES.test(name)
              ? "TRANSIENT"
              : "RPC";
          throw new RpcError(describe(body.error.data ?? body.error.message ?? body.error), { kind, data: body.error });
        }
        // Query failures come back as result.error with a 200.
        if (body.result?.error) {
          const msg = String(body.result.error);
          // A missing key and a missing account both read "... does not exist while viewing"; the leading noun tells them apart.
          const kind = /^access key .* does not exist/.test(msg) ? "UNKNOWN_ACCESS_KEY" : /does not exist while viewing/.test(msg) ? "UNKNOWN_ACCOUNT" : "RPC";
          throw new RpcError(msg, { kind, data: body.result });
        }
        return body.result;
      } catch (e) {
        last = e;
        const transient = e.kind === "TRANSIENT" || !(e instanceof RpcError);
        if (!transient || attempt === retries) throw e;
        await sleep(backoffMs * 2 ** attempt);
      }
    }
    throw last;
  }

  /** Calls a view method and parses its JSON result. `blockId` (a hash or height) pins the read to one block. */
  async function view(contract, method, args = {}, blockId) {
    const r = await call("query", {
      request_type: "call_function",
      ...(blockId === undefined ? { finality: "final" } : { block_id: blockId }),
      account_id: contract,
      method_name: method,
      args_base64: b64(args),
    });
    return JSON.parse(Buffer.from(r.result).toString("utf8"));
  }

  /** Account state, or null when the account does not exist. */
  async function account(id, blockId) {
    try {
      const at = blockId === undefined ? { finality: "final" } : { block_id: blockId };
      return await call("query", { request_type: "view_account", ...at, account_id: id });
    } catch (e) {
      if (e.kind === "UNKNOWN_ACCOUNT") return null;
      throw e;
    }
  }

  /**
   * `[{ public_key, access_key: { nonce, permission } }]`, or null when the account does not exist.
   * `blockId` needs an archival node once it is old. Accounts with more than 100 keys are read in
   * pages of 100 (`limit` + `after_key`); past MAX_KEY_PAGES the list is cut and `.truncated` is true.
   */
  async function accessKeys(id, blockId) {
    const at = blockId === undefined ? { finality: "final" } : { block_id: blockId };
    const list = (extra = {}) => call("query", { request_type: "view_access_key_list", ...at, account_id: id, ...extra });
    try {
      const { keys } = await list();
      // A node answers an account that does not exist with an empty list, exactly as it does for an account whose keys are
      // all gone (a locked Kizashi): only view_account tells the two apart.
      return keys.length === 0 && (await account(id, blockId)) === null ? null : keys;
    } catch (e) {
      if (e.kind === "UNKNOWN_ACCOUNT") return null;
      if (e.kind !== "TOO_MANY_ACCESS_KEYS") throw e;
    }
    const keys = [];
    let afterKey;
    for (let page = 0; page < MAX_KEY_PAGES; page++) {
      const r = await list({ limit: 100, ...(afterKey ? { after_key: afterKey } : {}) });
      keys.push(...r.keys);
      if (r.keys.length < 100 || !r.last_key) return keys;
      afterKey = r.last_key;
    }
    return Object.assign(keys, { truncated: true });
  }

  const status = () => call("status", []);
  /** The latest final block, so every read of one pass can be pinned to the same block. */
  const finalBlock = async () => {
    const b = await call("block", { finality: "final" });
    return { height: b.header.height, hash: b.header.hash };
  };
  const tx = (hash, signerId) => call("tx", { tx_hash: hash, sender_account_id: signerId, wait_until: "FINAL" });

  return { call, view, account, accessKeys, status, finalBlock, tx };
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}
