// The trip keeper's lockdown confirmation and its owed-payout report. In-memory chain, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { describeOwed, listOwed, MAX_TRIP_PASSES, retryCommand, tripOnce } from "../src/keeper.mjs";

const key = (public_key, permission = "FullAccess") => ({ public_key, access_key: { nonce: 0, permission } });
const fc = { FunctionCall: { allowance: "1", receiver_id: "v", method_names: ["send_small"] } };
const PQ = key("ml-dsa-65:ADMIN");
const noSleep = async () => {};

/** Views are values, or functions of the call's arguments. */
function chain(accounts) {
  return {
    accessKeys: async (id) => accounts[id]?.keys ?? null,
    view: async (id, method, args) => {
      const v = accounts[id].views[method];
      return typeof v === "function" ? v(args) : v;
    },
  };
}

// ---- lockdown confirmation (Mamori's lock_down deletes daily keys first, intents keys second, under a gas cap) ----

test("keeper: a lockdown needs BOTH daily_keys and intents_keys empty, so a trip that clears only the first is repeated", async () => {
  const accounts = {
    k: { views: { era: "Kaigen", omens: [] } },
    v: { views: { era: "Kaigen", daily_keys: ["ed25519:D"], intents_keys: ["ed25519:I1", "ed25519:I2"] }, keys: [PQ, key("ed25519:D", fc)] },
  };
  const trips = [];
  const r = await tripOnce({
    rpc: chain(accounts),
    kizashi: "k",
    vaults: ["v"],
    sleep: noSleep,
    sendTrip: async (v) => {
      trips.push(v);
      if (trips.length === 1) {
        accounts.v.views.daily_keys = [];
        accounts.v.keys = [PQ];
      } else accounts.v.views.intents_keys = [];
      return `hash-${trips.length}`;
    },
  });
  assert.equal(trips.length, 2, "one trip left the intents keys behind, so the keeper tripped again");
  assert.deepEqual(r.results.map((x) => [x.action, x.hash, x.passes]), [["tripped", "hash-2", 2]]);
});

test("keeper: intents keys left alone (daily keys gone, no function-call key) are enough to need a trip", async () => {
  const accounts = {
    k: { views: { era: "Kaigen", omens: [] } },
    v: { views: { era: "Kaigen", daily_keys: [], intents_keys: ["ed25519:I1"] }, keys: [PQ] },
  };
  let trips = 0;
  const r = await tripOnce({ rpc: chain(accounts), kizashi: "k", vaults: ["v"], sleep: noSleep, sendTrip: async () => ((accounts.v.views.intents_keys = []), ++trips, "h") });
  assert.equal(trips, 1);
  assert.equal(r.results[0].action, "tripped");
});

test("keeper: intents keys that never clear leave the vault pending after a bounded number of trips, with a delay between them", async () => {
  const accounts = {
    k: { views: { era: "Kaigen", omens: [] } },
    v: { views: { era: "Kaigen", daily_keys: [], intents_keys: ["ed25519:I1"] }, keys: [PQ] },
  };
  assert.ok(MAX_TRIP_PASSES > 1 && MAX_TRIP_PASSES <= 10, "bounded, and more than one");
  const sleeps = [];
  let trips = 0;
  const run = (extra = {}) => tripOnce({ rpc: chain(accounts), kizashi: "k", vaults: ["v"], retryDelayMs: 7, sleep: async (ms) => sleeps.push(ms), sendTrip: async () => `h${++trips}`, ...extra });
  const r = await run();
  const v = r.results[0];
  assert.equal(v.action, "unconfirmed", "the bin sets a non-zero exit for unconfirmed vaults");
  assert.equal(v.pending, true);
  assert.equal(v.passes, MAX_TRIP_PASSES);
  assert.equal(v.hash, `h${MAX_TRIP_PASSES}`);
  assert.match(v.error, /intents keys/);
  assert.match(v.error, /pending/);
  assert.equal(trips, MAX_TRIP_PASSES);
  assert.deepEqual(sleeps, Array(MAX_TRIP_PASSES - 1).fill(7));
  trips = 0;
  assert.equal((await run({ maxPasses: 2 })).results[0].passes, 2);
  assert.equal(trips, 2);
});

test("keeper: a vault that does not answer intents_keys with a list is an error, never confirmed", async () => {
  const accounts = {
    k: { views: { era: "Kaigen", omens: [] } },
    v: { views: { era: "Kaigen", daily_keys: [] }, keys: [PQ] },
  };
  const sent = [];
  const r = await tripOnce({ rpc: chain(accounts), kizashi: "k", vaults: ["v"], sleep: noSleep, sendTrip: async (v) => (sent.push(v), "h") });
  assert.equal(r.results[0].action, "error");
  assert.match(r.results[0].error, /intents_keys/);
});

// ---- owed payouts ----------------------------------------------------------------------------------------------

const omenList = [
  { id: "a", death: { claimant: "alice.near", block: "1", signature: "s" } },
  { id: "b", death: null },
  { id: "c", death: { claimant: "alice.near", block: "2", signature: "s" } },
  { id: "d", death: { claimant: "bob.near", block: "3", signature: "s" } },
  { id: "e", death: { claimant: "carol.near", block: "4", signature: "s" } },
];
const owedBy = { "alice.near": { near: "0", usdc: "0", usdc_unread: false }, "bob.near": { near: "5000", usdc: "7", usdc_unread: false }, "carol.near": { near: "0", usdc: "0", usdc_unread: true } };

test("owed: every dead omen's claimant is asked once, and each owed amount comes with the exact retry command", async () => {
  const asked = [];
  const rpc = chain({ "k.near": { views: { omens: omenList, owed: (a) => (asked.push(a.claimant), owedBy[a.claimant]) } } });
  const owed = await listOwed({ rpc, kizashi: "k.near" });
  assert.deepEqual(asked, ["alice.near", "bob.near", "carol.near"], "alice claimed two omens and is asked once; living omens have no claimant");
  assert.deepEqual(owed.map((o) => [o.claimant, o.near, o.usdc, o.usdcUnread]), [["bob.near", "5000", "7", false], ["carol.near", "0", "0", true]]);
  assert.equal(owed[0].command, `near call k.near retry_payout '{"claimant":"bob.near"}' --accountId <any funded account> --gas 300000000000000`);
  assert.equal(owed[0].command, retryCommand("k.near", "bob.near"));
  assert.match(describeOwed(owed[0]), /bob\.near is owed 5000 yoctoNEAR and 7 USDC base units; to pay it run \(nothing here sends it\): near call/);
  assert.match(describeOwed(owed[1]), /USDC balance that could not be read/);
});

test("owed: nothing owed is an empty list; an answer it cannot read, or an id it cannot print safely, is an error", async () => {
  const none = chain({ "k.near": { views: { omens: omenList, owed: () => ({ near: "0", usdc: "0", usdc_unread: false }) } } });
  assert.deepEqual(await listOwed({ rpc: none, kizashi: "k.near" }), []);
  const garbage = chain({ "k.near": { views: { omens: omenList, owed: () => ({ near: 5 }) } } });
  await assert.rejects(() => listOwed({ rpc: garbage, kizashi: "k.near" }), /owed/);
  const noList = chain({ "k.near": { views: { omens: "nope" } } });
  await assert.rejects(() => listOwed({ rpc: noList, kizashi: "k.near" }), /omens\(\)/);
  assert.throws(() => retryCommand("k.near", "bad id; rm -rf ~"), /plausible account id/);
});

test("keeper: the pass lists every owed payout with its retry command and never sends one", async () => {
  const accounts = {
    k: { views: { era: "Kaigen", omens: omenList, owed: (a) => owedBy[a.claimant] } },
    v: { views: { era: "Kaigen", daily_keys: [], intents_keys: [] }, keys: [PQ] },
  };
  const sent = [];
  const r = await tripOnce({ rpc: chain({ ...accounts, "k.near": undefined }), kizashi: "k", vaults: ["v"], sleep: noSleep, sendTrip: async (v) => (sent.push(v), "h") });
  assert.deepEqual(sent, [], "the vault was up to date and retry_payout is never sent by the keeper");
  assert.equal(r.results[0].action, "up to date");
  const rows = r.results.filter((x) => x.action === "owed");
  assert.deepEqual(rows.map((x) => x.claimant), ["bob.near", "carol.near"]);
  assert.ok(rows[0].error.includes(retryCommand("k", "bob.near")), "the printed line carries the exact command");
  assert.equal(r.owed.length, 2);
  assert.equal(r.error, undefined);
});

test("keeper: owed payouts that cannot be read are reported on the pass, and the trips are still reported", async () => {
  const accounts = {
    k: { views: { era: "Kaigen", omens: omenList } },
    v: { views: { era: "Kaigen", daily_keys: [], intents_keys: [] }, keys: [PQ] },
  };
  const r = await tripOnce({ rpc: chain(accounts), kizashi: "k", vaults: ["v"], sleep: noSleep, sendTrip: async () => "h" });
  assert.equal(r.results[0].action, "up to date");
  assert.match(r.error, /owed payouts/);
});
