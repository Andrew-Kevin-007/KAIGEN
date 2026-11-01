import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { TopupError, assertTopupSafe, guardConfigFromEnv, type GuardConfig } from "./topup-guard.ts";

const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const HASH = "9sCzkLpyHCmZeEMQK4oTUeFP7kjpzbRUBr6RRNUQJVCM";
const KIZASHI = "kizashi.example.near";

const CFG: GuardConfig = { network: "mainnet", allowTestnet: false, recipient: KIZASHI, expectedCodeHash: HASH };

interface Chain {
  chain_id?: string;
  account?: object | null;
  bounty?: object;
  era?: unknown;
  down?: boolean;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A tiny JSON-RPC node: answers `status`, `view_account` and the two Kizashi views the guard reads. */
function node(chain: Chain): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body));
    calls.push(`${req.method}:${req.params?.request_type ?? ""}:${req.params?.method_name ?? ""}`);
    if (chain.down) throw new TypeError("network down");
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }));
    if (req.method === "status") return ok({ chain_id: chain.chain_id ?? "mainnet" });
    if (req.params.request_type === "view_account") {
      if (chain.account === null) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { name: "HANDLER_ERROR", code: -32000, message: "Server error", data: `account ${req.params.account_id} does not exist while viewing` } }),
        );
      }
      return ok(chain.account ?? { amount: "1", code_hash: HASH });
    }
    if (req.params.request_type === "call_function") {
      const value = req.params.method_name === "bounty" ? (chain.bounty ?? { near: "0", usdc_token: USDC }) : (chain.era ?? "Calm");
      return ok({ result: Array.from(Buffer.from(JSON.stringify(value))), logs: [] });
    }
    throw new Error(`unexpected rpc ${req.method}`);
  }) as typeof fetch;
  return calls;
}

async function refusal(cfg: GuardConfig, destination: string): Promise<TopupError> {
  try {
    await assertTopupSafe(cfg, destination);
  } catch (e) {
    assert.ok(e instanceof TopupError, `expected a TopupError, got ${String(e)}`);
    return e;
  }
  assert.fail("expected the guard to refuse");
}

test("APP-2: a mainnet Kizashi with the expected code, the same USDC and a calm era passes", async () => {
  const calls = node({});
  await assertTopupSafe(CFG, `nep141:${USDC}`);
  assert.deepEqual(calls.map((c) => c.split(":")[0]), ["status", "query", "query", "query"]);
});

test("APP-2: a global-contract recipient is recognised by its global hash", async () => {
  node({ account: { amount: "1", code_hash: "11111111111111111111111111111111", global_contract_hash: HASH } });
  await assertTopupSafe(CFG, `nep141:${USDC}`);
});

test("APP-2: a deployment that is not on mainnet refuses before any chain call, unless a testnet override is set", async () => {
  const calls = node({ chain_id: "testnet" });
  const e = await refusal({ ...CFG, network: "testnet" }, `nep141:${USDC}`);
  assert.equal(e.status, 503);
  assert.match(e.message, /not on mainnet/);
  assert.equal(calls.length, 0, "no RPC call is made once the config is refused");
  await assertTopupSafe({ ...CFG, network: "testnet", allowTestnet: true }, `nep141:${USDC}`);
});

test("APP-2: an RPC that answers as the wrong network is refused", async () => {
  node({ chain_id: "testnet" });
  const e = await refusal(CFG, `nep141:${USDC}`);
  assert.equal(e.status, 503);
  assert.match(e.message, /testnet/);
});

test("APP-2: no recipient, or no expected code hash, means no deposit address", async () => {
  const calls = node({});
  assert.match((await refusal({ ...CFG, recipient: "" }, `nep141:${USDC}`)).message, /not deployed/);
  assert.match((await refusal({ ...CFG, expectedCodeHash: "" }, `nep141:${USDC}`)).message, /KIZASHI_CODE_HASH/);
  assert.equal(calls.length, 0);
});

test("APP-2: a recipient that does not exist, or runs other code, is refused", async () => {
  node({ account: null });
  assert.match((await refusal(CFG, `nep141:${USDC}`)).message, /does not exist/);
  node({ account: { amount: "1", code_hash: "3xhGSkbLdrKkcPFuN3q5BMTGUfRDQoB2WYB2vXgDqVC9" } });
  assert.match((await refusal(CFG, `nep141:${USDC}`)).message, /not the Kizashi build/);
  node({ account: { amount: "1", code_hash: "11111111111111111111111111111111" } });
  assert.match((await refusal(CFG, `nep141:${USDC}`)).message, /not the Kizashi build/);
});

test("APP-2: the 1Click destination must be exactly the USDC Kizashi reports", async () => {
  node({});
  assert.match((await refusal(CFG, "nep141:usdc.other.near")).message, /not the USDC Kizashi counts/);
  assert.match((await refusal(CFG, USDC)).message, /not the USDC Kizashi counts/, "an asset id without the nep141 prefix is not a match");
  assert.match((await refusal(CFG, `nep245:v2_1.omni.hot.tg:${USDC}`)).message, /not the USDC Kizashi counts/);
  node({ bounty: { near: "0", usdc_token: null } });
  assert.match((await refusal(CFG, `nep141:${USDC}`)).message, /no USDC token/);
});

test("APP-2: once the era is Kaigen, or unreadable, no deposit address is given", async () => {
  node({ era: "Kaigen" });
  const e = await refusal(CFG, `nep141:${USDC}`);
  assert.equal(e.status, 409);
  assert.match(e.message, /Kaigen/);
  node({ era: "Mystery" });
  assert.equal((await refusal(CFG, `nep141:${USDC}`)).status, 502);
  node({ era: "Warning" });
  await assertTopupSafe(CFG, `nep141:${USDC}`);
});

test("APP-2: a node that cannot be reached fails closed", async () => {
  node({ down: true });
  const e = await refusal(CFG, `nep141:${USDC}`);
  assert.equal(e.status, 502);
  assert.match(e.message, /no deposit address/);
});

test("APP-2: the config reads the network and the override from the environment", () => {
  const base = { NEXT_PUBLIC_KIZASHI_ID: KIZASHI, KIZASHI_CODE_HASH: HASH };
  assert.deepEqual(guardConfigFromEnv(base), { network: "mainnet", allowTestnet: false, recipient: KIZASHI, expectedCodeHash: HASH });
  assert.equal(guardConfigFromEnv({ ...base, NEXT_PUBLIC_NETWORK: "testnet", TOPUP_ALLOW_TESTNET: "1" }).allowTestnet, true);
  assert.equal(guardConfigFromEnv({ ...base, NEXT_PUBLIC_NETWORK: "testnet" }).network, "testnet");
  assert.equal(guardConfigFromEnv({ ...base, TOPUP_ALLOW_TESTNET: "true" }).allowTestnet, false, "only 1 switches it on");
  assert.equal(guardConfigFromEnv({}).recipient, "");
});
