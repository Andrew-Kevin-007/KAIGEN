// Release-mode checks added after the first review: owed payouts (K3) and the deployer's key left on the Mamori reference (T3).
import test from "node:test";
import assert from "node:assert/strict";
import { checkDeployerKeyOnReference, checkNothingOwed, DEPLOYER_KEY_CHECK, NOTHING_OWED_CHECK, requiredChecks } from "../src/verify.mjs";
import { retryCommand } from "../src/keeper.mjs";

const full = (k) => ({ public_key: k, access_key: { nonce: 1, permission: "FullAccess" } });
const limited = (k) => ({ public_key: k, access_key: { nonce: 1, permission: { FunctionCall: { allowance: null, receiver_id: "x.near", method_names: [] } } } });
const dep = { kizashi: "kizashi.near", mamoriReference: "mamori.deployer.near", mainnet: { deployer: "deployer.near" } };
const keysRpc = (byId) => ({ accessKeys: async (id) => byId[id] ?? null });

test("release: both new checks are required in the pre-lock and the post-lock gate", () => {
  for (const stage of ["pre-lock", "post-lock"]) {
    assert.ok(requiredChecks(stage).includes(NOTHING_OWED_CHECK), `${stage}: owed payouts`);
    assert.ok(requiredChecks(stage).includes(DEPLOYER_KEY_CHECK), `${stage}: deployer key`);
  }
});

const omens = [{ id: "a", death: { claimant: "bob.near", block: "1", signature: "s" } }, { id: "b", death: null }];
const owedRpc = (owed) => ({ view: async (id, method, args) => (method === "omens" ? omens : owed(args)) });

test("release: verify --release fails when a claimant is owed, and prints the exact retry command", async () => {
  const ok = await checkNothingOwed({ rpc: owedRpc(() => ({ near: "0", usdc: "0", usdc_unread: false })), dep });
  assert.deepEqual([ok.name, ok.ok], [NOTHING_OWED_CHECK, true]);
  const owed = await checkNothingOwed({ rpc: owedRpc(() => ({ near: "0", usdc: "9", usdc_unread: false })), dep });
  assert.equal(owed.ok, false);
  assert.match(owed.detail, /bob\.near is owed 9 USDC base units/);
  assert.ok(owed.detail.includes(retryCommand("kizashi.near", "bob.near")));
  const unread = await checkNothingOwed({ rpc: owedRpc(() => ({ near: "0", usdc: "0", usdc_unread: true })), dep });
  assert.equal(unread.ok, false, "an unread USDC balance is still owed");
});

test("release: a Kizashi that cannot answer owed() fails the check instead of passing it", async () => {
  const r = await checkNothingOwed({
    rpc: { view: async (id, method) => { if (method === "owed") throw new Error("method owed not found"); return omens; } },
    dep,
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /could not check: method owed not found/);
});

test("release: the deployer's full-access key left on the Mamori reference is flagged", async () => {
  const left = await checkDeployerKeyOnReference({ rpc: keysRpc({ "deployer.near": [full("ed25519:D")], "mamori.deployer.near": [full("ed25519:D"), full("ed25519:Z")] }), dep });
  assert.deepEqual([left.name, left.ok], [DEPLOYER_KEY_CHECK, false]);
  assert.match(left.detail, /ed25519:D/);
  assert.ok(!left.detail.includes("ed25519:Z"), "only the deployer's own key is named");
  const gone = await checkDeployerKeyOnReference({ rpc: keysRpc({ "deployer.near": [full("ed25519:D")], "mamori.deployer.near": [] }), dep });
  assert.equal(gone.ok, true);
  const callKey = await checkDeployerKeyOnReference({ rpc: keysRpc({ "deployer.near": [full("ed25519:D")], "mamori.deployer.near": [limited("ed25519:D")] }), dep });
  assert.equal(callKey.ok, true, "a function-call key cannot redeploy the code");
});

test("release: the deployer-key check fails when it cannot compare (missing account, too many keys, no deployer configured)", async () => {
  const cases = [
    [keysRpc({ "deployer.near": [full("ed25519:D")] }), dep, /mamori\.deployer\.near does not exist/],
    [keysRpc({ "mamori.deployer.near": [] }), dep, /deployer\.near does not exist/],
    [keysRpc({ "deployer.near": Object.assign([full("ed25519:D")], { truncated: true }), "mamori.deployer.near": [] }), dep, /more keys than could be read/],
    [keysRpc({ "mamori.deployer.near": [] }), { ...dep, mainnet: {} }, /mainnet\.deployer/],
  ];
  for (const [rpc, d, re] of cases) {
    const r = await checkDeployerKeyOnReference({ rpc, dep: d });
    assert.equal(r.ok, false);
    assert.match(r.detail, re);
  }
});
