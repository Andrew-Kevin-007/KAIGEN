import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DEFAULT_RPC, kizashiRole, networkOfAccount, parseDeployments, parseDrillRecord } from "./deployments.ts";

const TX = (c: string) => c.repeat(44);
const drillDoc = (over: Record<string, unknown> = {}) => ({
  drill: true,
  seq: 4,
  kizashi: "drill-kizashi.dep.testnet",
  omen_id: "ed25519-test",
  vaults: ["v1.dep.testnet"],
  steps: [{ step: "claim", ok: true }, { step: "trip", ok: true }],
  claim_tx: TX("B"),
  claim_block: 100,
  verified_block: 120,
  trip_txs: { "v1.dep.testnet": TX("C") },
  pq_send_txs: { "v1.dep.testnet": TX("D") },
  rearm_txs: { "v1.dep.testnet": TX("E") },
  reset_tx: TX("F"),
  ...over,
});
const parse = (doc: unknown) => parseDeployments(JSON.stringify(doc));

test("APP-D1: no setting, an empty one and {} all read as 'nothing deployed yet', with no problem to report", () => {
  for (const text of [undefined, "", "   ", "{}"]) {
    const d = parseDeployments(text);
    assert.equal(d.kizashi, null, `kizashi for ${JSON.stringify(text)}`);
    assert.equal(d.drillKizashi, null);
    assert.equal(d.mamoriReference, null);
    assert.equal(d.mamoriCodeHash, null);
    assert.equal(d.drillRecord, null);
    assert.deepEqual(d.problems, []);
    assert.equal(d.network, "mainnet", "the stricter network when none is named");
    assert.equal(d.rpc, DEFAULT_RPC.mainnet);
  }
});

test("APP-D1: deployments.example.json copied unchanged reads as 'not deployed yet', never as an address", () => {
  const example = fs.readFileSync(new URL("../../deployments.example.json", import.meta.url), "utf8");
  const d = parseDeployments(example);
  assert.equal(d.kizashi, null, "REPLACE-kizashi-account.near is a placeholder");
  assert.equal(d.drillKizashi, null, "drill-kizashi.REPLACE-deployer.near is a placeholder");
  assert.equal(d.mamoriReference, null);
  assert.deepEqual(d.problems, [], "a placeholder is 'not deployed', not a configuration error");
});

test("APP-D1: real addresses come through, on the network they name", () => {
  const d = parse({
    network: "testnet",
    kizashi: "kizashi.dep.testnet",
    mamoriReference: "mamori.dep.testnet",
    mamoriCodeHash: "5Wc3p3zmbq8qNBMxX7MoJXAXxqjCmE9nzRPVa4rt5W8d",
    drill: { kizashi: "drill-kizashi.dep.testnet" },
  });
  assert.equal(d.network, "testnet");
  assert.equal(d.kizashi, "kizashi.dep.testnet");
  assert.equal(d.drillKizashi, "drill-kizashi.dep.testnet");
  assert.equal(d.mamoriReference, "mamori.dep.testnet");
  assert.equal(d.mamoriCodeHash, "5Wc3p3zmbq8qNBMxX7MoJXAXxqjCmE9nzRPVa4rt5W8d");
  assert.equal(d.rpc, DEFAULT_RPC.testnet);
  assert.deepEqual(d.problems, []);
});

test("APP-D1: a setting that is not JSON, or not an object, is reported and nothing is invented", () => {
  for (const text of ["{not json", "[]", "7", '"kizashi.near"']) {
    const d = parseDeployments(text);
    assert.equal(d.kizashi, null);
    assert.equal(d.problems.length, 1, `one problem for ${text}`);
  }
});

test("APP-D1: an unknown network is reported and read as mainnet", () => {
  const d = parse({ network: "betanet", kizashi: "k.near" });
  assert.equal(d.network, "mainnet");
  assert.match(d.problems.join(" "), /network must be/);
});

test("APP-D1: a mainnet account on a testnet deployment (or the reverse) is flagged", () => {
  const d = parse({ network: "testnet", kizashi: "kizashi.near" });
  assert.match(d.problems.join(" "), /kizashi \(kizashi\.near\) is a mainnet account, but network is testnet/);
  const e = parse({ network: "mainnet", drill: { kizashi: "d.testnet" } });
  assert.match(e.problems.join(" "), /drill\.kizashi \(d\.testnet\) is a testnet account, but network is mainnet/);
});

test("APP-D1: an invalid account name is refused and shown cut to 80 characters (the message is built before the type guard narrows it away)", () => {
  const long = `Bad Name ${"x".repeat(200)}`;
  const d = parse({ kizashi: long });
  assert.equal(d.kizashi, null);
  assert.equal(d.problems.length, 1);
  assert.match(d.problems[0], /^kizashi is not a valid NEAR account name \("Bad Name x+"\)\.$/);
  assert.ok(d.problems[0].length < 160, "the 200 character value is not echoed whole");
  assert.match(parse({ mamoriReference: 7 }).problems.join(" "), /mamoriReference must be a NEAR account name/);
});

test("APP-D1: rpc must be https (http only for localhost); a placeholder falls back silently", () => {
  assert.equal(parse({ network: "testnet", rpc: "https://rpc.example.org/" }).rpc, "https://rpc.example.org");
  assert.equal(parse({ network: "testnet", rpc: "http://localhost:3030" }).rpc, "http://localhost:3030");
  const plain = parse({ network: "testnet", rpc: "http://rpc.example.org" });
  assert.equal(plain.rpc, DEFAULT_RPC.testnet);
  assert.match(plain.problems.join(" "), /rpc must be an https URL/);
  const placeholder = parse({ network: "testnet", rpc: "REPLACE-rpc" });
  assert.equal(placeholder.rpc, DEFAULT_RPC.testnet);
  assert.deepEqual(placeholder.problems, []);
});

test("APP-D1: the Mamori code hash must be base58 sha-256, or it is dropped with a problem", () => {
  assert.equal(parse({ mamoriCodeHash: "not a hash!" }).mamoriCodeHash, null);
  assert.match(parse({ mamoriCodeHash: "not a hash!" }).problems.join(" "), /mamoriCodeHash/);
  assert.equal(parse({ mamoriCodeHash: "REPLACE-hash" }).mamoriCodeHash, null);
  assert.deepEqual(parse({ mamoriCodeHash: "REPLACE-hash" }).problems, []);
});

test("APP-D2: a whole drill record parses; the first failed step is named, a clean run has none", () => {
  const ok = parseDrillRecord(drillDoc());
  assert.ok("record" in ok);
  if ("record" in ok) {
    assert.equal(ok.record.network, "testnet", "read from the Kizashi account's suffix");
    assert.equal(ok.record.failedStep, null);
    assert.equal(ok.record.resetTx, TX("F"));
  }
  const bad = parseDrillRecord(drillDoc({ steps: [{ step: "claim", ok: true }, { step: "trip", ok: false }, { step: "rearm", ok: false }] }));
  assert.ok("record" in bad);
  if ("record" in bad) assert.equal(bad.record.failedStep, "trip");
});

test("APP-D2: a drill record with a hole in it is refused whole, with the reason", () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ drill: false }, /not marked as a drill/],
    [{ seq: 0 }, /sequence number/],
    [{ kizashi: "Bad Name" }, /no Kizashi account/],
    [{ vaults: [] }, /no valid vaults/],
    [{ steps: [] }, /no recorded steps/],
    [{ claim_tx: "short" }, /claim transaction/],
    [{ verified_block: 0 }, /block height/],
    [{ trip_txs: {} }, /trip, send or re-arm/],
    [{ reset_tx: "short" }, /reset transaction/],
  ];
  for (const [over, why] of cases) {
    const r = parseDrillRecord(drillDoc(over));
    assert.ok("problem" in r, `refused: ${JSON.stringify(over)}`);
    if ("problem" in r) assert.match(r.problem, why);
  }
  assert.ok("problem" in parseDrillRecord("nope"));
});

test("APP-D2: a settings drill record is used, and a broken one is reported rather than shown", () => {
  assert.ok(parse({ network: "testnet", drillRecord: drillDoc() }).drillRecord);
  const broken = parse({ network: "testnet", drillRecord: drillDoc({ claim_tx: "x" }) });
  assert.equal(broken.drillRecord, null);
  assert.match(broken.problems.join(" "), /recorded drill is unusable/);
});

test("APP-D3: networkOfAccount reads the top-level name; a name that says neither is unknown", () => {
  assert.equal(networkOfAccount("a.testnet"), "testnet");
  assert.equal(networkOfAccount("a.near"), "mainnet");
  assert.equal(networkOfAccount("a.example"), null);
});

test("APP-D4: a vault's Kizashi is production, the drill one, or one this deployment does not know", () => {
  const d = { kizashi: "kizashi.dep.testnet", drillKizashi: "drill-kizashi.dep.testnet" };
  assert.equal(kizashiRole("kizashi.dep.testnet", d), "production");
  assert.equal(kizashiRole("drill-kizashi.dep.testnet", d), "drill");
  assert.equal(kizashiRole("kizashi.evil.testnet", d), "other");
  // Nothing deployed: an empty id must never match a null, and every Kizashi is unknown.
  assert.equal(kizashiRole("", { kizashi: null, drillKizashi: null }), "other");
  assert.equal(kizashiRole("kizashi.dep.testnet", { kizashi: null, drillKizashi: null }), "other");
});
