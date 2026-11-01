import test from "node:test";
import assert from "node:assert/strict";
import { renderDemo, runInjectionDemo } from "../src/demo.mjs";

const NEAR = 10n ** 24n;

// A vault model just rich enough to answer the demo's calls the way Mamori does, so the demo's own logic
// (not the contract) is under test: it must notice when a defence fails.
function fakeVault({ breakAllowlist = false, breakCap = false, breakCancel = false, breakBurn = false, gasPerCall = 0n } = {}) {
  const s = { balance: 5n * NEAR, queue: [], nextId: 0, limit: NEAR, strikes: 0, keyAlive: true };
  const rpc = {
    // The attacker's account does not exist, as on a fresh chain; everything else is the vault.
    account: async (id) => (id === "attacker.near" ? null : { amount: s.balance.toString(), code_hash: "11111111111111111111111111111111" }),
    view: async (_v, m) => {
      if (m === "allowlist") return { enforced: true, accounts: ["supplier.near"] };
      if (m === "queue") return s.queue.map((q) => ({ ...q }));
      if (m === "daily_keys") return s.keyAlive ? ["ed25519:agent"] : [];
      throw new Error("unexpected view " + m);
    },
  };
  const refuse = (reason) => {
    s.strikes += 1;
    const burned = !breakBurn && s.strikes >= 3;
    if (burned) s.keyAlive = false;
    return { ok: true, hash: "tx-refused", outcome: { sent: false, refused: reason, strikes: s.strikes, burned } };
  };
  const agentCall = async (method, a) => {
    s.balance -= gasPerCall; // the vault account pays gas for calls made with its keys, refused or not
    if (!s.keyAlive) return { ok: false, error: "not a recorded daily key" };
    if (method === "send_small") {
      const amt = BigInt(a.amount);
      if (!breakAllowlist && a.to !== "supplier.near") return refuse("recipient is not on the allowlist");
      if (!breakCap && amt > s.limit) return refuse("over the 24 h limit");
      s.balance -= amt;
      return { ok: true, hash: "tx-send", outcome: { sent: true, refused: null, strikes: 0, burned: false } };
    }
    if (method === "request_withdraw") {
      s.queue.push({ id: String(s.nextId++), to: a.to, amount: a.amount });
      return { ok: true, hash: "tx-queue" };
    }
    if (method === "execute") return s.queue.some((q) => q.id === a.id) ? { ok: true, hash: "tx-exec" } : { ok: false, error: "no such request" };
    throw new Error("unexpected call " + method);
  };
  const adminCancel = async (id) => {
    if (!breakCancel) s.queue = s.queue.filter((q) => q.id !== id);
  };
  const wait = { tries: 2, delayMs: 0, wait: async () => {} };
  return { s, args: { vault: "v.near", supplier: "supplier.near", attacker: "attacker.near", rpc, agentCall, adminCancel, payable: 1000n, limit: s.limit, wait } };
}

test("when every defence holds, the demo passes, the key burns on the third strike, and nothing reaches the attacker", async () => {
  const { args, s } = fakeVault();
  const r = await runInjectionDemo(args);
  assert.equal(r.ok, true, JSON.stringify(r.steps.filter((x) => !x.held)));
  assert.equal(r.reachedAttacker, "0");
  assert.equal(s.keyAlive, false);
  const text = renderDemo(r);
  assert.match(text, /every attack was stopped/);
  assert.match(text, /strike 1 of 3/);
  assert.match(text, /strike 3 of 3, key burned/);
  assert.equal(r.steps.find((x) => x.name.includes("agent wrapper")).outcome, "refused");
  assert.equal(r.steps.find((x) => x.name.includes("tries again with its burned key")).held, true);
});

test("the demo FAILS if the recipient policy is broken", async () => {
  const r = await runInjectionDemo(fakeVault({ breakAllowlist: true }).args);
  assert.equal(r.ok, false);
  assert.match(renderDemo(r), /A DEFENCE FAILED/);
});

test("gas that refused calls cost the vault is reported, and does not fail a demo where nothing was stolen", async () => {
  const r = await runInjectionDemo(fakeVault({ gasPerCall: 10n ** 20n }).args);
  assert.equal(r.ok, true, JSON.stringify(r.steps.filter((x) => !x.held)));
  assert.equal(r.reachedAttacker, "0");
  assert.ok(BigInt(r.gasSpent) > 0n, "the gas is visible in the report, not hidden");
  assert.match(renderDemo(r), /gas the refused calls cost the vault/);
});

test("a small theft cannot hide inside the gas allowance", async () => {
  const r = await runInjectionDemo(fakeVault({ breakAllowlist: true }).args);
  assert.equal(r.ok, false);
  assert.ok(BigInt(r.gasSpent) > BigInt(r.gasBudget));
});

test("the demo FAILS if the daily cap is broken", async () => {
  assert.equal((await runInjectionDemo(fakeVault({ breakCap: true }).args)).ok, false);
});

test("the demo FAILS if the admin cannot cancel a queued withdrawal", async () => {
  assert.equal((await runInjectionDemo(fakeVault({ breakCancel: true }).args)).ok, false);
});

test("the demo FAILS if the key survives its strikes", async () => {
  const r = await runInjectionDemo(fakeVault({ breakBurn: true }).args);
  assert.equal(r.ok, false);
  const burn = r.steps.find((x) => x.name.includes("burns the agent's key"));
  assert.equal(burn.held, false);
  assert.match(renderDemo(r), /key still active/);
});
