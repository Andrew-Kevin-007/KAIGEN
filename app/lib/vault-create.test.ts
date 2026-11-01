import test from "node:test";
import assert from "node:assert/strict";
import {
  STEP_ORDER,
  TEMP_KEY_GONE_AT,
  adminKeyFromBackupText,
  adminKeyFromHash,
  begin,
  fail,
  finalKeysError,
  finish,
  fundingYocto,
  initialSteps,
  nextStep,
  outcomeFailure,
  placeCaption,
  recoveryNote,
  stepCaption,
  txHashOf,
  vaultAccountId,
} from "./vault-create.ts";

const KEY = `ml-dsa-65:${"A".repeat(2600)}`;
const HANDLE = "ml-dsa-65-hash:HANDLE";
const TEMP = "ed25519:TEMP";

test("APP-5: the steps run in a fixed order, starting with the wallet", () => {
  assert.deepEqual(STEP_ORDER, ["create", "admin", "cleanup", "check"]);
  assert.equal(nextStep(initialSteps()), "create");
});

test("APP-5: a step cannot start out of order or while another is running", () => {
  const s0 = initialSteps();
  assert.throws(() => begin(s0, "admin"), /order/);
  const s1 = begin(s0, "create");
  assert.throws(() => begin(s1, "create"), /order|running/);
  assert.throws(() => begin(s1, "admin"), /order|running/);
  assert.equal(nextStep(s1), null, "nothing else is offered while a step runs");
  const s2 = finish(s1, "create", "TXHASH1");
  assert.equal(nextStep(s2), "admin");
  assert.equal(s2[0].tx, "TXHASH1");
});

test("APP-5: finish and fail need a running step", () => {
  assert.throws(() => finish(initialSteps(), "create"), /not running/);
  assert.throws(() => fail(initialSteps(), "create", "x"), /not running/);
});

test("APP-5: a failed step is offered again and keeps the steps before it done", () => {
  let s = finish(begin(initialSteps(), "create"), "create", "T1");
  s = fail(begin(s, "admin"), "admin", "RPC down");
  assert.equal(s[0].status, "done");
  assert.equal(s[1].status, "failed");
  assert.equal(s[1].error, "RPC down");
  assert.equal(nextStep(s), "admin");
  s = finish(begin(s, "admin"), "admin", "T2");
  assert.equal(s[1].status, "done");
  assert.equal(s[1].error, undefined, "a retry clears the old error");
});

test("APP-5: the whole run finishes with nothing left to do, and the inputs were never mutated", () => {
  const start = initialSteps();
  let s = start;
  for (const id of STEP_ORDER) s = finish(begin(s, id), id, `tx-${id}`);
  assert.equal(nextStep(s), null);
  assert.ok(s.every((x) => x.status === "done"));
  assert.ok(start.every((x) => x.status === "todo"), "the first array is unchanged");
});

test("APP-5: every failure leaves a recovery note that names the vault and what is still live", () => {
  const vault = "my-vault.alice.near";
  const run = (upTo: number, failing: (typeof STEP_ORDER)[number]) => {
    let s = initialSteps();
    for (const id of STEP_ORDER.slice(0, upTo)) s = finish(begin(s, id), id, "t");
    return fail(begin(s, failing), failing, "boom");
  };
  const create = recoveryNote(run(0, "create"), vault, TEMP)!;
  assert.match(create, /my-vault\.alice\.near/);
  assert.match(create, /exists/);
  const admin = recoveryNote(run(1, "admin"), vault, TEMP)!;
  assert.match(admin, /only this tab/);
  assert.ok(admin.includes(TEMP));
  const cleanup = recoveryNote(run(2, "cleanup"), vault, TEMP)!;
  assert.match(cleanup, /full-access/);
  assert.ok(cleanup.includes(TEMP));
  assert.match(cleanup, /admin key/);
  const check = recoveryNote(run(3, "check"), vault, TEMP)!;
  assert.match(check, /Do not fund/);
  assert.equal(recoveryNote(initialSteps(), vault, TEMP), null, "no failure, no note");
});

test("APP-5: the final key list must be exactly the admin key", () => {
  assert.equal(finalKeysError([{ public_key: HANDLE }], HANDLE, TEMP), null);
  assert.match(finalKeysError([], HANDLE, TEMP)!, /no keys/);
  assert.match(finalKeysError([{ public_key: HANDLE }, { public_key: TEMP }], HANDLE, TEMP)!, /temporary key is still/);
  assert.match(finalKeysError([{ public_key: TEMP }], HANDLE, TEMP)!, /temporary key is still/);
  assert.match(finalKeysError([{ public_key: "ed25519:OTHER" }], HANDLE, TEMP)!, /admin key is not/);
  assert.match(finalKeysError([{ public_key: HANDLE }, { public_key: "ed25519:OTHER" }], HANDLE, TEMP)!, /other than/);
});

test("APP-5: outcomes are read for failures at any receipt, and the transaction hash is found", () => {
  assert.equal(outcomeFailure({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }] }), null);
  assert.match(outcomeFailure({ status: { Failure: { ActionError: { kind: "AccountAlreadyExists" } } } })!, /AccountAlreadyExists/);
  assert.match(outcomeFailure({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { Failure: { kind: "LackBalanceForState" } } } }] })!, /LackBalanceForState/);
  assert.equal(outcomeFailure(undefined), null);
  assert.equal(txHashOf({ transaction: { hash: "H1" } }), "H1");
  assert.equal(txHashOf({ transaction_outcome: { id: "H2" } }), "H2");
  assert.equal(txHashOf({}), null);
  assert.equal(txHashOf(null), null);
});

test("APP-5: the vault name becomes a sub-account of the connected wallet account", () => {
  assert.deepEqual(vaultAccountId("my-vault", "alice.near"), { ok: true, id: "my-vault.alice.near" });
  for (const bad of ["", "a", "A", "-a", "a-", "a b", "a.b", "x".repeat(40)]) {
    assert.equal(vaultAccountId(bad, "alice.near").ok, false, JSON.stringify(bad));
  }
  assert.equal(vaultAccountId("vault", "a".repeat(60)).ok, false, "the whole id may not pass 64 characters");
});

test("APP-5: funding is parsed exactly and has a floor that covers the gas for the next steps", () => {
  assert.equal(fundingYocto("0.1"), "100000000000000000000000");
  assert.equal(fundingYocto("2"), "2000000000000000000000000");
  assert.equal(fundingYocto("0.01"), null);
  assert.equal(fundingYocto("abc"), null);
  assert.equal(fundingYocto(""), null);
});

test("APP-5: the admin key comes from the Protect page's link or from the backup file, and is only ever the public half", () => {
  assert.equal(adminKeyFromHash(`#key=${encodeURIComponent(KEY)}`), KEY);
  assert.equal(adminKeyFromHash("#key=ed25519:abc"), null);
  assert.equal(adminKeyFromHash(""), null);
  assert.equal(adminKeyFromBackupText(JSON.stringify({ v: 1, app: "kaigen", publicKey: KEY, ciphertext: "x" })), KEY);
  assert.equal(adminKeyFromBackupText(JSON.stringify({ app: "other", publicKey: KEY })), null);
  assert.equal(adminKeyFromBackupText("not json"), null);
});

test("APP-C1: step captions are read from the real step list, so the count on screen is the count of steps", () => {
  const captions = STEP_ORDER.map(stepCaption);
  assert.deepEqual(captions, ["Step 1 of 4", "Step 2 of 4", "Step 3 of 4", "Step 4 of 4"]);
  // Every caption ends in the length of the list, whatever that length becomes.
  for (const c of captions) assert.ok(c.endsWith(` of ${STEP_ORDER.length}`), c);
  assert.equal(placeCaption("Part", 0, 3), "Part 1 of 3");
  assert.equal(placeCaption("Part", 2, 3), "Part 3 of 3");
});

test("APP-C1: 'keep this tab open until step N is done' names the step that deletes the temporary key", () => {
  assert.equal(STEP_ORDER[TEMP_KEY_GONE_AT - 1], "cleanup");
  assert.equal(TEMP_KEY_GONE_AT, 3);
});
