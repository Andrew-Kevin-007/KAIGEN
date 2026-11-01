import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FireTestError, lockedDown, runFireTest } from "../src/firetest.mjs";

const fc = { FunctionCall: { allowance: "1", receiver_id: "v", method_names: ["send_small"] } };
const key = (public_key, permission = "FullAccess") => ({ public_key, access_key: { nonce: 0, permission } });
const PQ = key("ml-dsa-65-hash:B");
const DAILY = key("ed25519:D", fc);

// ---- fire test --------------------------------------------------------------------------

function fakeDrill(vaults, { brokenTrip = false } = {}) {
  const s = { era: "Calm", block: 100, v: Object.fromEntries(vaults.map((v) => [v, { era: "Calm", daily: ["ed25519:D"], keys: [PQ, DAILY] }])) };
  return {
    state: s,
    era: async () => s.era,
    vaultEra: async (v) => s.v[v].era,
    dailyKeys: async (v) => s.v[v].daily,
    accessKeys: async (v) => s.v[v].keys,
    blockHeight: async () => ++s.block,
    claim: async () => ((s.era = "Kaigen"), "tx-claim"),
    trip: async (v) => {
      if (!brokenTrip) Object.assign(s.v[v], { era: "Kaigen", daily: [], keys: [PQ] });
      return `tx-trip-${v}`;
    },
    pqSend: async (v) => `tx-pq-${v}`,
    reset: async () => ((s.era = "Calm"), "tx-reset"),
    rearm: async (v) => (Object.assign(s.v[v], { era: "Calm", daily: ["ed25519:D"], keys: [PQ, DAILY] }), `tx-rearm-${v}`),
  };
}
const cfg = { kizashi: "k.drill", submitter: "keeper.drill", vaults: ["v1.drill", "v2.drill"], omenId: "drill-ed25519-omen", seq: 1 };
const fast = { wait: async () => {}, tries: 3 };

test("lockedDown: only a post-quantum full-access key may remain", () => {
  assert.equal(lockedDown([PQ]), true);
  assert.equal(lockedDown([PQ, DAILY]), false);
  assert.equal(lockedDown([PQ, key("ed25519:X")]), false);
  assert.equal(lockedDown([]), false, "no keys at all is an empty account, not a lockdown");
});

test("fire test: full cycle produces the record and leaves the drill armed again", async () => {
  const chain = fakeDrill(cfg.vaults);
  const rec = await runFireTest({ chain, cfg, opts: fast });
  assert.equal(rec.claim_tx, "tx-claim");
  assert.deepEqual(Object.keys(rec.trip_txs), cfg.vaults);
  assert.ok(rec.verified_block > rec.claim_block);
  assert.ok(rec.steps.every((s) => s.ok));
  assert.equal(rec.drill, true);
  // Re-armed for next week.
  assert.equal(chain.state.era, "Calm");
  assert.equal(chain.state.v["v1.drill"].daily.length, 1);
});

test("fire test: keys that survive the trip fail the test at that step, with the partial record", async () => {
  await assert.rejects(
    () => runFireTest({ chain: fakeDrill(cfg.vaults, { brokenTrip: true }), cfg, opts: fast }),
    (e) => e instanceof FireTestError && e.step === "classical keys are gone" && e.record.steps.at(-1).ok === false && e.record.claim_tx === "tx-claim",
  );
});

test("fire test: refuses to start unless the drill is calm and armed", async () => {
  const dirty = fakeDrill(cfg.vaults);
  dirty.state.era = "Kaigen";
  await assert.rejects(() => runFireTest({ chain: dirty, cfg, opts: fast }), /not calm/);
  const bare = fakeDrill(cfg.vaults);
  bare.state.v["v2.drill"].daily = [];
  await assert.rejects(() => runFireTest({ chain: bare, cfg, opts: fast }), /no daily key/);
});

test("fire test: a failure after the claim tries to put the drill back, and records it", async () => {
  const chain = fakeDrill(cfg.vaults, { brokenTrip: true });
  await assert.rejects(
    () => runFireTest({ chain, cfg, opts: fast }),
    (e) => {
      assert.equal(e.step, "classical keys are gone");
      assert.equal(e.record.cleanup.reset_tx, "tx-reset");
      assert.deepEqual(Object.keys(e.record.cleanup.rearm_txs), cfg.vaults);
      assert.deepEqual(e.record.cleanup.errors, []);
      return true;
    },
  );
  assert.equal(chain.state.era, "Calm", "the drill is calm again, so next week's run can start");
});

test("fire test: cleanup that itself fails is recorded and does not mask the original failure", async () => {
  const chain = fakeDrill(cfg.vaults, { brokenTrip: true });
  chain.reset = async () => { throw new Error("out of gas"); };
  await assert.rejects(
    () => runFireTest({ chain, cfg, opts: fast }),
    (e) => e.step === "classical keys are gone" && e.record.cleanup.errors.some((m) => /reset: out of gas/.test(m)),
  );
});

test("fire test: a failure before the claim triggers no cleanup", async () => {
  const dirty = fakeDrill(cfg.vaults);
  dirty.state.era = "Kaigen";
  await assert.rejects(() => runFireTest({ chain: dirty, cfg, opts: fast }), (e) => e.record.cleanup === undefined);
});
