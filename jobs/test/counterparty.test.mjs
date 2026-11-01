import test from "node:test";
import assert from "node:assert/strict";
import { checkCounterparty, guardedSend } from "../src/counterparty.mjs";

const person = { code_hash: "11111111111111111111111111111111" };
const contract = { code_hash: "ABC123", };
const rpcWith = ({ accounts = {}, policy = { enforced: false, accounts: [] }, policyError } = {}) => ({
  account: async (id) => (id in accounts ? accounts[id] : null),
  view: async () => {
    if (policyError) throw new Error(policyError);
    return policy;
  },
});
const base = { vault: "v.near", to: "shop.near" };

test("a known person's account that the agent has paid before is allowed", async () => {
  const v = await checkCounterparty({ ...base, rpc: rpcWith({ accounts: { "shop.near": person } }), history: new Set(["shop.near"]) });
  assert.equal(v.verdict, "allow");
});

test("a first payment is a warning, so a human can look", async () => {
  const v = await checkCounterparty({ ...base, rpc: rpcWith({ accounts: { "shop.near": person } }) });
  assert.equal(v.verdict, "warn");
  assert.ok(v.reasons.some((r) => /never paid/.test(r.text)));
});

test("a blocklisted recipient is blocked, with the evidence it was reported with", async () => {
  const v = await checkCounterparty({ ...base, to: "evil.near", rpc: rpcWith({ accounts: { "evil.near": person } }), blocklist: new Map([["evil.near", "drained 3 agents, tx 9xK"]]), history: new Set(["evil.near"]) });
  assert.equal(v.verdict, "block");
  assert.match(v.reasons[0].text, /drained 3 agents, tx 9xK/);
});

test("a named account that does not exist is blocked; an unfunded implicit one only warns", async () => {
  assert.equal((await checkCounterparty({ ...base, to: "ghost.near", rpc: rpcWith(), history: new Set(["ghost.near"]) })).verdict, "block");
  const implicit = "a".repeat(64);
  assert.equal((await checkCounterparty({ ...base, to: implicit, rpc: rpcWith(), history: new Set([implicit]) })).verdict, "warn");
});

test("a contract recipient warns", async () => {
  const v = await checkCounterparty({ ...base, rpc: rpcWith({ accounts: { "shop.near": contract } }), history: new Set(["shop.near"]) });
  assert.equal(v.verdict, "warn");
  assert.ok(v.reasons.some((r) => /contract/.test(r.text)));
});

test("an enforced vault allowlist blocks recipients that are not on it, and allows ones that are", async () => {
  const policy = { enforced: true, accounts: ["shop.near"] };
  const acc = { "shop.near": person, "other.near": person };
  assert.equal((await checkCounterparty({ ...base, rpc: rpcWith({ accounts: acc, policy }), history: new Set(["shop.near"]) })).verdict, "allow");
  const v = await checkCounterparty({ ...base, to: "other.near", rpc: rpcWith({ accounts: acc, policy }), history: new Set(["other.near"]) });
  assert.equal(v.verdict, "block");
});

test("a signal that cannot be read is a warning, never a pass", async () => {
  const v = await checkCounterparty({ ...base, rpc: rpcWith({ accounts: { "shop.near": person }, policyError: "rpc down" }), history: new Set(["shop.near"]) });
  assert.equal(v.verdict, "warn");
  assert.ok(v.reasons.some((r) => /could not read the vault's allowlist/.test(r.text)));
  const down = { account: async () => { throw new Error("429"); }, view: async () => ({ enforced: false, accounts: [] }) };
  assert.equal((await checkCounterparty({ ...base, rpc: down, history: new Set(["shop.near"]) })).verdict, "warn");
});

test("guardedSend never signs on block, asks a human on warn, and signs on allow", async () => {
  const log = [];
  let signed = 0;
  const send = async () => (signed++, "tx1");
  const mk = (verdict) => async () => ({ verdict, reasons: [{ level: verdict === "allow" ? "info" : verdict, text: "t" }] });

  const blocked = await guardedSend({ check: mk("block"), send, confirm: async () => true, log: (e) => log.push(e) });
  assert.deepEqual([blocked.sent, signed], [false, 0], "even a human yes cannot override a block");

  const declined = await guardedSend({ check: mk("warn"), send });
  assert.deepEqual([declined.sent, declined.declined, signed], [false, true, 0], "no confirm callback means no");

  const approved = await guardedSend({ check: mk("warn"), send, confirm: async () => true });
  assert.deepEqual([approved.sent, approved.hash, signed], [true, "tx1", 1]);

  const allowed = await guardedSend({ check: mk("allow"), send });
  assert.equal(allowed.sent, true);
  assert.equal(signed, 2);
  assert.ok(log.some((e) => e.step === "check" && e.verdict === "block"));
});
