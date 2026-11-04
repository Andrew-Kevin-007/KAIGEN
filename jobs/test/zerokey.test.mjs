import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { base58 } from "@scure/base";
import { hasNoKeys, isKeyGoneError, renderZeroKey, runZeroKey, ZeroKeyError, zeroKeyPreflight } from "../src/firetest.mjs";
import { makeDrillChain, makeZeroKeyChain } from "../src/chain.mjs";
import { zeroKey } from "../src/testnet.mjs";

// A public, obviously fake test vector (32 bytes of 0x01). It controls nothing.
const FAKE_PRIVATE = `ed25519:${base58.encode(new Uint8Array(32).fill(1))}`;
const OWN = { public_key: "ed25519:OWN", access_key: { nonce: 1, permission: "FullAccess" } };
const OTHER = { public_key: "ed25519:OTHER", access_key: { nonce: 1, permission: "FullAccess" } };
const FN = { public_key: "ed25519:FN", access_key: { nonce: 1, permission: { FunctionCall: { allowance: "1", receiver_id: "k", method_names: ["claim"] } } } };
const OMEN = "drill-ed25519-omen";
const cfg = { kizashi: "k.testnet", submitter: "keeper.testnet", omenId: OMEN, ownKey: "ed25519:OWN" };
const fast = { wait: async () => {}, tries: 3 };

/** A drill Kizashi as a small state machine. `calls` is the order of every transaction sent to it or at it. */
function fakeKizashi({ keys = [OWN], era = "Calm", dead = false, keepKeyOnDelete = false, probe, viewsBreakAfterDelete = false, viewsWrongEraAfterDelete = false, claimFails = false, claimRaisesEra = true, resetFails = false, resetAddsKey = false } = {}) {
  const s = { keys, era, calls: [], omens: [{ id: OMEN, death: dead ? { block: "1" } : null }, { id: "drill-secp256k1-omen", death: null }], deleted: false };
  const chain = {
    state: s,
    views: async () => {
      if (viewsBreakAfterDelete && s.deleted) throw new Error("view call failed");
      if (viewsWrongEraAfterDelete && s.deleted && s.calls.length === 1) return { era: "Weird", omens: [], bounty: {} };
      return { era: s.era, omens: s.omens.map((o) => ({ ...o })), bounty: { near: "1", usdc_token: null, claimable: true } };
    },
    accessKeys: async () => s.keys,
    blockHeight: async () => 100,
    deleteOwnKey: async () => {
      s.calls.push("delete");
      s.deleted = true;
      if (!keepKeyOnDelete) s.keys = s.keys.filter((k) => k.public_key !== "ed25519:OWN");
      return "tx-delete";
    },
    probeDeletedKey: async () => {
      s.calls.push("probe");
      return probe ?? { accepted: false, error: "Signer \"k.testnet\" doesn't have access key with the given public_key ed25519:OWN" };
    },
    claim: async (id) => {
      s.calls.push("claim");
      if (claimFails) throw new Error("claim refused");
      if (claimRaisesEra) {
        s.era = "Kaigen";
        s.omens.find((o) => o.id === id).death = { block: "2" };
      }
      return "tx-claim";
    },
    reset: async () => {
      s.calls.push("reset");
      if (resetFails) throw new Error("out of gas");
      s.era = "Calm";
      for (const o of s.omens) o.death = null;
      if (resetAddsKey) s.keys = [OTHER];
      return "tx-reset";
    },
  };
  return chain;
}

// ---- the sequence --------------------------------------------------------------------------------

test("zero-key: deletes the key first, proves nothing is left, then a third party claims and resets", async () => {
  const chain = fakeKizashi();
  const rec = await runZeroKey({ chain, cfg, opts: fast });
  assert.equal(rec.ok, true);
  assert.ok(rec.steps.every((s) => s.ok));
  assert.deepEqual(chain.state.calls, ["delete", "probe", "claim", "reset"], "the claim only happens once the key is gone");
  assert.equal(rec.delete_tx, "tx-delete");
  assert.equal(rec.claim_tx, "tx-claim");
  assert.equal(rec.reset_tx, "tx-reset");
  assert.equal(rec.deleted_key, "ed25519:OWN");
  assert.deepEqual(chain.state.keys, [], "no access keys at the end");
  assert.equal(chain.state.era, "Calm", "left armed for the next fire test");
  assert.deepEqual(rec.warnings, []);
  assert.equal(rec.drill, true);
});

test("zero-key: the delete does not take, so the run stops before any claim", async () => {
  const chain = fakeKizashi({ keepKeyOnDelete: true });
  await assert.rejects(
    () => runZeroKey({ chain, cfg, opts: fast }),
    (e) => e instanceof ZeroKeyError && e.step === "Kizashi has no access keys left" && e.record.claim_tx === undefined && e.record.cleanup === undefined && e.record.ok === false,
  );
  assert.deepEqual(chain.state.calls, ["delete"], "nothing was claimed against a Kizashi that still has a key");
});

test("zero-key: a transaction signed with the deleted key that goes through fails the run", async () => {
  const chain = fakeKizashi({ probe: { accepted: true, hash: "tx-probe" } });
  await assert.rejects(
    () => runZeroKey({ chain, cfg, opts: fast }),
    (e) => e.step === "the deleted key can no longer sign" && /was accepted \(tx-probe\)/.test(e.message),
  );
  assert.ok(!chain.state.calls.includes("claim"));
});

test("zero-key: a refusal worded differently is a warning, because the key list is the proof", async () => {
  const chain = fakeKizashi({ probe: { accepted: false, error: "fetch failed" } });
  const rec = await runZeroKey({ chain, cfg, opts: fast });
  assert.equal(rec.ok, true);
  assert.equal(rec.warnings.length, 1);
  assert.match(rec.warnings[0], /not with an access-key error: fetch failed/);
  assert.match(renderZeroKey(rec), /WARN .*fetch failed/);
});

test("zero-key: a Kizashi that has no keys already is not deleted again, and still gets the claim and reset checks", async () => {
  const chain = fakeKizashi({ keys: [] });
  const rec = await runZeroKey({ chain, cfg, opts: fast });
  assert.equal(rec.already_keyless, true);
  assert.equal(rec.delete_tx, undefined);
  assert.deepEqual(chain.state.calls, ["probe", "claim", "reset"]);
  assert.match(renderZeroKey(rec), /had no keys already/);
});

test("zero-key: the views failing once the key is gone fails the run before the claim", async () => {
  const chain = fakeKizashi({ viewsBreakAfterDelete: true });
  await assert.rejects(() => runZeroKey({ chain, cfg, opts: fast }), (e) => e.step === "the views still answer" && /view call failed/.test(e.message));
  assert.ok(!chain.state.calls.includes("claim"));
});

test("zero-key: views that answer, but not with a calm drill, fail the run", async () => {
  const chain = fakeKizashi({ viewsWrongEraAfterDelete: true });
  await assert.rejects(() => runZeroKey({ chain, cfg, opts: fast }), (e) => e.step === "the views still answer" && /era view answered "Weird"/.test(e.message));
  assert.ok(!chain.state.calls.includes("claim"));
});

test("zero-key: an account that has a key again by the end fails the last check", async () => {
  const chain = fakeKizashi({ resetAddsKey: true });
  await assert.rejects(() => runZeroKey({ chain, cfg, opts: fast }), (e) => e.step === "Kizashi is calm again and still has no access keys" && /has access keys again/.test(e.message));
});

test("zero-key: a refused claim fails at the claim and leaves nothing to clean up", async () => {
  const chain = fakeKizashi({ claimFails: true });
  await assert.rejects(
    () => runZeroKey({ chain, cfg, opts: fast }),
    (e) => e.step === "a third party claims with a valid drill omen" && /claim refused/.test(e.message) && e.record.cleanup === undefined,
  );
  assert.ok(!chain.state.calls.includes("reset"), "no claim landed, so there is nothing to reset");
});

test("zero-key: a claim that lands but does not raise the era fails the run, and the drill is reset", async () => {
  const chain = fakeKizashi({ claimRaisesEra: false });
  await assert.rejects(
    () => runZeroKey({ chain, cfg, opts: fast }),
    (e) => {
      assert.equal(e.step, "the claim raised the era and killed the omen");
      assert.equal(e.record.claim_tx, "tx-claim");
      assert.equal(e.record.cleanup.reset_tx, "tx-reset");
      assert.deepEqual(e.record.cleanup.errors, []);
      return true;
    },
  );
});

test("zero-key: cleanup that itself fails is recorded and does not mask the original failure", async () => {
  const chain = fakeKizashi({ claimRaisesEra: false, resetFails: true });
  await assert.rejects(
    () => runZeroKey({ chain, cfg, opts: fast }),
    (e) => e.step === "the claim raised the era and killed the omen" && e.record.cleanup.reset_tx === null && e.record.cleanup.errors.some((m) => /reset: out of gas/.test(m)),
  );
});

test("zero-key: a reset that fails after a good claim is reported at the reset, tried once more in the cleanup, and that is recorded", async () => {
  const chain = fakeKizashi({ resetFails: true });
  await assert.rejects(
    () => runZeroKey({ chain, cfg, opts: fast }),
    (e) => e.step === "a third party resets the drill Kizashi" && /out of gas/.test(e.message) && e.record.cleanup.reset_tx === null && e.record.cleanup.errors.length === 1,
  );
  assert.equal(chain.state.calls.filter((c) => c === "reset").length, 2, "the step, then one cleanup attempt, no loop");
});

// ---- preflight: refuses to start from a state it cannot finish from ------------------------------

test("zero-key preflight: refuses a Kizashi that is not calm, has a dead omen, holds a key it cannot delete, or does not exist", async () => {
  const refuses = async (chain, pattern) => {
    await assert.rejects(() => runZeroKey({ chain, cfg, opts: fast }), (e) => e instanceof ZeroKeyError && e.step.startsWith("preflight") && pattern.test(e.message));
    assert.deepEqual(chain.state.calls, [], "nothing was sent");
  };
  await refuses(fakeKizashi({ era: "Kaigen" }), /not calm/);
  await refuses(fakeKizashi({ dead: true }), /already claimed/);
  await refuses(fakeKizashi({ keys: [OWN, OTHER] }), /holds keys other than its own full-access key ed25519:OWN: ed25519:OWN, ed25519:OTHER/);
  await refuses(fakeKizashi({ keys: [FN] }), /holds keys other than its own/);
  await refuses(fakeKizashi({ keys: [{ ...OWN, access_key: { nonce: 1, permission: { FunctionCall: {} } } }] }), /holds keys other than its own/);
  await refuses(fakeKizashi({ keys: null }), /does not exist/);
  const noOmen = fakeKizashi();
  noOmen.state.omens = [];
  await refuses(noOmen, /has no omen drill-ed25519-omen/);
});

test("zero-key preflight alone is read-only and says whether the key is already gone", async () => {
  const chain = fakeKizashi();
  assert.deepEqual(await zeroKeyPreflight({ chain, cfg }), { keys: [OWN], alreadyKeyless: false });
  assert.equal((await zeroKeyPreflight({ chain: fakeKizashi({ keys: [] }), cfg })).alreadyKeyless, true);
  assert.deepEqual(chain.state.calls, []);
});

test("hasNoKeys: an empty list is no keys, a missing account is not", () => {
  assert.equal(hasNoKeys([]), true);
  assert.equal(hasNoKeys(null), false, "no account is not a keyless account");
  assert.equal(hasNoKeys(undefined), false);
  assert.equal(hasNoKeys([OWN]), false);
});

test("isKeyGoneError: recognises how a node words a refused key, not a dropped connection", () => {
  assert.equal(isKeyGoneError('Transaction is not valid: Signer "k.testnet" doesn\'t have access key with the given public_key ed25519:X'), true);
  assert.equal(isKeyGoneError('rpc error: {"InvalidTxError":{"InvalidAccessKeyError":{"AccessKeyNotFound":{"account_id":"k.testnet"}}}}'), true);
  assert.equal(isKeyGoneError("fetch failed"), false);
  assert.equal(isKeyGoneError(undefined), false);
});

// ---- the chain adapter: what it signs and sends, with the network injected ----------------------------

const envelope = (hash) => ({ result: { transaction: { hash }, status: { SuccessValue: "" } } });

test("makeZeroKeyChain: deleteOwnKey sends one DeleteKey of its own public key, signed as Kizashi, to Kizashi", async () => {
  const sent = [];
  const send = async (tx) => (sent.push(tx), envelope("H-del"));
  const chain = makeZeroKeyChain({ rpc: {}, drill: {}, kizashi: "k.testnet", privateKey: FAKE_PRIVATE, send });
  assert.match(chain.ownKey, /^ed25519:/);
  assert.equal(await chain.deleteOwnKey(), "H-del");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].signerId, "k.testnet");
  assert.equal(sent[0].receiverId, "k.testnet");
  assert.equal(sent[0].network, "testnet");
  assert.equal(sent[0].waitUntil, "FINAL");
  assert.deepEqual(sent[0].actions.map((a) => [a.type, a.publicKey]), [["DeleteKey", chain.ownKey]]);
});

test("makeZeroKeyChain: the probe is a 1 yocto self-transfer, refused means not accepted, included means accepted", async () => {
  const sent = [];
  const make = (send) => makeZeroKeyChain({ rpc: {}, drill: {}, kizashi: "k.testnet", privateKey: FAKE_PRIVATE, send: async (tx) => (sent.push(tx), send(tx)) });

  const refusedByEnvelope = await make(async () => ({ error: { data: "Signer \"k.testnet\" doesn't have access key with the given public_key" } })).probeDeletedKey();
  assert.equal(refusedByEnvelope.accepted, false);
  assert.equal(isKeyGoneError(refusedByEnvelope.error), true);

  const refusedByThrow = await make(async () => { throw new Error("fetch failed"); }).probeDeletedKey();
  assert.deepEqual(refusedByThrow, { accepted: false, error: "fetch failed" });

  const taken = await make(async () => envelope("H-probe")).probeDeletedKey();
  assert.deepEqual(taken, { accepted: true, hash: "H-probe" });

  const includedThenFailed = await make(async () => ({ result: { transaction: { hash: "H-f" }, status: { Failure: { ActionError: {} } } } })).probeDeletedKey();
  assert.equal(includedThenFailed.accepted, true, "a transaction the node included was signed by a key that worked");

  assert.ok(sent.every((tx) => tx.actions.length === 1 && tx.actions[0].type === "Transfer" && tx.actions[0].deposit === "1" && tx.receiverId === tx.signerId));
});

test("makeZeroKeyChain: the views are era, omens and bounty of the account asked about", async () => {
  const asked = [];
  const rpc = { view: async (k, m) => (asked.push([k, m]), { era: "Calm", omens: [], bounty: { claimable: true } }[m]) };
  const chain = makeZeroKeyChain({ rpc, drill: {}, kizashi: "k.testnet", privateKey: FAKE_PRIVATE, send: async () => envelope("x") });
  assert.deepEqual(await chain.views("k.testnet"), { era: "Calm", omens: [], bounty: { claimable: true } });
  assert.deepEqual(asked.sort(), [["k.testnet", "bounty"], ["k.testnet", "era"], ["k.testnet", "omens"]]);
});

test("makeZeroKeyChain: claim, reset, access keys and block height are the drill chain's, signed by the submitter and not by Kizashi", () => {
  const drill = { claim: () => "c", reset: () => "r", accessKeys: () => "a", blockHeight: () => "b" };
  const chain = makeZeroKeyChain({ rpc: {}, drill, kizashi: "k.testnet", privateKey: FAKE_PRIVATE, send: async () => envelope("x") });
  assert.deepEqual([chain.claim(), chain.reset(), chain.accessKeys(), chain.blockHeight()], ["c", "r", "a", "b"]);
});

// ---- the rehearsal glue: guards and the dry run, offline ---------------------------------------------

const dirs = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function rehearsalDir({ kizashi = "k.testnet", network = "testnet", withKey = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zerokey-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "drill-omen-secrets.json"), JSON.stringify({ [OMEN]: "01".repeat(32) }));
  fs.writeFileSync(path.join(dir, "admin-seeds.json"), "{}");
  fs.writeFileSync(path.join(dir, "accounts.json"), JSON.stringify(withKey ? { [kizashi]: { privateKey: FAKE_PRIVATE, publicKey: "ignored" } } : {}));
  const state = {
    network,
    kizashi,
    vault: "vault.f.testnet",
    keeper: { id: "keeper.f.testnet", privateKey: FAKE_PRIVATE },
    daily: { publicKey: "ed25519:D", privateKey: FAKE_PRIVATE },
    drillSecretsPath: path.join(dir, "drill-omen-secrets.json"),
    adminSeedsPath: path.join(dir, "admin-seeds.json"),
    omens: [{ id: OMEN, curve: "Ed25519" }],
  };
  return { dir, state };
}
/** A read-only RPC for a calm drill Kizashi whose only key is `keys`. */
const fakeRpc = (keys) => ({
  view: async (_k, m) => ({ era: "Calm", omens: [{ id: OMEN, death: null }], bounty: { near: "0", usdc_token: null, claimable: true } }[m]),
  accessKeys: async () => keys,
});

test("zerokey (dry run): reads the chain, sends nothing, and writes nothing", async () => {
  const { dir, state } = rehearsalDir();
  const ownKey = makeZeroKeyChain({ rpc: {}, drill: {}, kizashi: "k.testnet", privateKey: FAKE_PRIVATE, send: async () => {} }).ownKey;
  const before = fs.readdirSync(dir).sort();
  const out = await zeroKey({ state, outDir: dir, rpc: fakeRpc([{ public_key: ownKey, access_key: { nonce: 0, permission: "FullAccess" } }]) });
  assert.equal(out.dryRun, true);
  assert.equal(out.alreadyKeyless, false);
  assert.equal(out.cfg.ownKey, ownKey);
  assert.equal(out.cfg.submitter, "keeper.f.testnet");
  assert.deepEqual(fs.readdirSync(dir).sort(), before, "no record file, no state change");
});

test("zerokey: refuses anything that is not a testnet rehearsal, or whose Kizashi key it does not hold", async () => {
  const mainnet = rehearsalDir({ kizashi: "kizashi.near", network: "mainnet" });
  await assert.rejects(() => zeroKey({ state: mainnet.state, outDir: mainnet.dir, rpc: fakeRpc([]) }), /only runs on a testnet rehearsal/);
  const wrongNet = rehearsalDir({ network: "mainnet" });
  await assert.rejects(() => zeroKey({ state: wrongNet.state, outDir: wrongNet.dir, yes: true, rpc: fakeRpc([]) }), /only runs on a testnet rehearsal/);
  const noKey = rehearsalDir({ withKey: false });
  await assert.rejects(() => zeroKey({ state: noKey.state, outDir: noKey.dir, yes: true, rpc: fakeRpc([]) }), /has no key for k\.testnet/);
});

test("zerokey (dry run): a Kizashi that holds a key it cannot delete is refused before anything is sent", async () => {
  const { dir, state } = rehearsalDir();
  await assert.rejects(
    () => zeroKey({ state, outDir: dir, rpc: fakeRpc([{ public_key: "ed25519:SOMEONE-ELSE", access_key: { nonce: 0, permission: "FullAccess" } }]) }),
    /holds keys other than its own full-access key/,
  );
});

test("makeDrillChain is still what the glue builds on: it needs the omen secrets and the admin seeds files", () => {
  assert.throws(() => makeDrillChain({ rpc: {}, submit: async () => "x", cfg: {}, drillSecretsPath: "/no/such/file", adminSeedsPath: "/no/such/file", dailyKeys: {}, omens: [] }), /ENOENT/);
});

// ---- the whole path through the rehearsal glue, offline -------------------------------------------------

/** A simulated drill Kizashi behind an rpc, the keeper's submitter and Kizashi's own sender. `sent` is every transaction, in order. */
function simulatedChain({ deleteWorks = true } = {}) {
  const ownKey = makeZeroKeyChain({ rpc: {}, drill: {}, kizashi: "k.testnet", privateKey: FAKE_PRIVATE, send: async () => {} }).ownKey;
  const sim = { era: "Calm", omens: [{ id: OMEN, death: null }, { id: "drill-secp256k1-omen", death: null }], keys: [{ public_key: ownKey, access_key: { nonce: 0, permission: "FullAccess" } }], sent: [] };
  const rpc = {
    view: async (_k, m) => ({ era: sim.era, omens: sim.omens.map((o) => ({ ...o })), bounty: { near: "0", usdc_token: null, claimable: true } }[m]),
    accessKeys: async () => sim.keys,
    status: async () => ({ sync_info: { latest_block_height: 5 } }),
  };
  const send = async (tx) => {
    const type = tx.actions[0].type;
    sim.sent.push(`kizashi:${type}`);
    if (type === "DeleteKey" && deleteWorks) {
      sim.keys = [];
      return envelope("H-del");
    }
    if (type === "DeleteKey") return envelope("H-del-noop");
    throw new Error(`Signer "${tx.signerId}" doesn't have access key with the given public_key`);
  };
  const submit = async ({ receiver, method }) => {
    sim.sent.push(`keeper:${method}@${receiver}`);
    if (method === "claim") {
      sim.era = "Kaigen";
      sim.omens[0].death = { block: "1" };
    }
    if (method === "reset") {
      sim.era = "Calm";
      sim.omens.forEach((o) => (o.death = null));
    }
    return `H-${method}`;
  };
  return { sim, rpc, send, submit };
}

test("zerokey (--yes), offline end to end: key deleted, probe refused, keeper claims and resets, the record is written without any key", async () => {
  const { dir, state } = rehearsalDir();
  const { sim, rpc, send, submit } = simulatedChain();
  const out = await zeroKey({ state, outDir: dir, yes: true, rpc, submit, send, opts: fast });
  assert.equal(out.rec.ok, true);
  assert.deepEqual(sim.sent, ["kizashi:DeleteKey", "kizashi:Transfer", "keeper:claim@k.testnet", "keeper:reset@k.testnet"]);
  assert.deepEqual(sim.keys, []);
  assert.equal(sim.era, "Calm");
  assert.equal(out.rec.submitter, "keeper.f.testnet");
  const file = fs.readdirSync(dir).find((f) => /^zerokey-.*\.json$/.test(f) && !f.includes("failed"));
  assert.ok(file, "a record file was written");
  const text = fs.readFileSync(path.join(dir, file), "utf8");
  assert.equal(JSON.parse(text).ok, true);
  assert.ok(!text.includes(FAKE_PRIVATE.slice(8)), "no private key in the record");
});

test("zerokey (--yes), offline: a delete that does not take fails the run, keeps the failure on disk, and sends no claim", async () => {
  const { dir, state } = rehearsalDir();
  const { sim, rpc, send, submit } = simulatedChain({ deleteWorks: false });
  await assert.rejects(() => zeroKey({ state, outDir: dir, yes: true, rpc, submit, send, opts: fast }), (e) => e instanceof ZeroKeyError && e.step === "Kizashi has no access keys left");
  assert.deepEqual(sim.sent, ["kizashi:DeleteKey"]);
  assert.ok(fs.readdirSync(dir).some((f) => /^zerokey-.*\.failed\.json$/.test(f)), "the failed record is kept");
});
