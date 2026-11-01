// Bounty watchers. Each production omen also holds a bounty at an address on another chain. An
// outflow from one of them means the key is broken, even if nobody has called `claim` yet.
//
// The watcher keeps the last balance it saw. A drop raises an alert; a rise (a top-up) never does.
// Bitcoin is checked by spend count instead, because a Taproot output only disappears when spent.
import fs from "node:fs";
import path from "node:path";
import { nearImplicit, solanaAddress, taprootAddress } from "./addresses.mjs";

/** A source returns `{ balance: bigint }` or `{ spent: number }` for one address. */
export function sources({ rpc, omens, fetchImpl = fetch, solanaUrl = "https://api.mainnet-beta.solana.com", btcApi = "https://mempool.space/api" }) {
  const ed = omens.find((o) => o.curve === "Ed25519");
  const secp = omens.find((o) => o.curve === "Secp256k1");
  const out = [];
  if (ed) {
    const near = nearImplicit(ed.public_key);
    out.push({
      id: `near:${near}`,
      address: near,
      read: async () => {
        const acc = await rpc.account(near);
        // An account that is gone after funds were there is the strongest signal of all.
        return { balance: acc ? BigInt(acc.amount) : 0n };
      },
    });
    const sol = solanaAddress(ed.public_key);
    out.push({
      id: `solana:${sol}`,
      address: sol,
      read: async () => {
        const res = await fetchImpl(solanaUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [sol, { commitment: "finalized" }] }),
        });
        const body = await res.json();
        if (body.error) throw new Error(body.error.message);
        return { balance: BigInt(body.result.value) };
      },
    });
  }
  if (secp) {
    const btc = taprootAddress(secp.public_key);
    out.push({
      id: `bitcoin:${btc}`,
      address: btc,
      read: async () => {
        const res = await fetchImpl(`${btcApi}/address/${btc}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const a = await res.json();
        // A changed or error body must not read as "nothing spent".
        const confirmed = a.chain_stats?.spent_txo_count;
        const pending = a.mempool_stats?.spent_txo_count;
        if (!Number.isInteger(confirmed) || !Number.isInteger(pending)) throw new Error("unexpected address response");
        return { spent: confirmed + pending };
      },
    });
  }
  return out;
}

/**
 * @param state previous `{ [id]: { balance?: string, spent?: number } }`
 * @returns `{ state, alerts }`; the first sighting of an address sets a baseline and never alerts
 */
export async function check(srcs, state = {}) {
  const next = { ...state };
  const alerts = [];
  for (const s of srcs) {
    let now;
    try {
      now = await s.read();
    } catch (e) {
      // An unreadable source is not an alarm: keep the old baseline and report it separately.
      alerts.push({ id: s.id, kind: "unreadable", detail: String(e.message ?? e) });
      continue;
    }
    const before = state[s.id];
    if (now.balance !== undefined) {
      if (before && BigInt(before.balance) > now.balance) {
        alerts.push({ id: s.id, kind: "outflow", detail: `balance fell from ${before.balance} to ${now.balance}` });
      }
      next[s.id] = { balance: (before && BigInt(before.balance) > now.balance ? BigInt(before.balance) : now.balance).toString() };
      // After an outflow the baseline is kept at the higher value, so the alert repeats until a human clears it.
    } else {
      // The baseline never absorbs a spend, so the alert repeats on every run until a human clears
      // the state. (A first sighting with spends already present counts as an outflow too.)
      const baseline = before ? before.spent : 0;
      if (now.spent > baseline) alerts.push({ id: s.id, kind: "outflow", detail: `spent outputs: ${now.spent}, baseline ${baseline}` });
      next[s.id] = { spent: baseline };
    }
  }
  return { state: next, alerts };
}

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Null when `state` is what `check` wrote: `{ [id]: { balance: "<digits>" } | { spent: <count> } }`. */
function stateProblem(state) {
  if (!isPlain(state)) return "expected an object keyed by address id";
  for (const [id, v] of Object.entries(state)) {
    if (!isPlain(v)) return `${id} is not an object`;
    if ("balance" in v) {
      if (typeof v.balance !== "string" || !/^\d+$/.test(v.balance)) return `${id} has a balance that is not a whole number`;
    } else if (!Number.isInteger(v.spent) || v.spent < 0) {
      return `${id} has neither a balance nor a spent count`;
    }
  }
  return null;
}

/**
 * The saved baselines, or `{}` when there is no file yet. A file that cannot be read back is an error and is never
 * treated as "no file": starting over from a fresh baseline would take today's drained balance as the normal one
 * and hide an outflow that is already in the saved state.
 */
export function loadState(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
  let state;
  try {
    state = JSON.parse(text);
  } catch (e) {
    throw new Error(`watcher state ${file} is not valid JSON (${e.message}). Left as it is: a fresh baseline would hide any outflow it holds. Restore it, or delete it to start over on purpose.`);
  }
  const problem = stateProblem(state);
  if (problem) throw new Error(`watcher state ${file} is malformed: ${problem}. Left as it is. Restore it, or delete it to start over on purpose.`);
  return state;
}

/** Writes through a temp file beside the target, then renames it in place, so a crash leaves the old file or the new one, never half of one. */
export function writeFileAtomic(file, data, io = fs) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  let fd;
  try {
    fd = io.openSync(tmp, "w");
    io.writeSync(fd, data);
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = undefined;
    io.renameSync(tmp, file);
  } catch (e) {
    if (fd !== undefined) {
      try {
        io.closeSync(fd);
      } catch {
        // The original error is the one worth reporting.
      }
    }
    try {
      io.rmSync(tmp, { force: true });
    } catch {
      // A leftover .tmp is harmless; the original error is the one worth reporting.
    }
    throw e;
  }
}

export function saveState(file, state, alerts) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(state, null, 2));
  const real = alerts.filter((a) => a.kind === "outflow");
  writeFileAtomic(path.join(path.dirname(file), "alerts.json"), JSON.stringify({ outflows: real, unreadable: alerts.filter((a) => a.kind === "unreadable") }, null, 2));
}
