import test, { after } from "node:test";
import assert from "node:assert/strict";
import { hashOf } from "../src/chain.mjs";

test("hashOf reads the hash from the JSON-RPC envelope sendTx really returns", () => {
  const envelope = { jsonrpc: "2.0", id: "x", result: { transaction: { hash: "H1" }, transaction_outcome: { id: "H1" }, status: { SuccessValue: "" } } };
  assert.equal(hashOf(envelope), "H1");
});

test("hashOf also accepts an unwrapped result and falls back to the outcome id", () => {
  assert.equal(hashOf({ transaction: { hash: "H2" }, status: { SuccessValue: "" } }), "H2");
  assert.equal(hashOf({ result: { transaction_outcome: { id: "H3" }, status: { SuccessValue: "" } } }), "H3");
});

test("hashOf throws on a failed transaction, an rpc error, or a missing hash", () => {
  const failed = { result: { transaction: { hash: "H4" }, status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: over the 24 h limit" } } } } } } };
  assert.throws(() => hashOf(failed), /over the 24 h limit/);
  assert.throws(() => hashOf({ error: { message: "boom" } }), /boom/);
  assert.throws(() => hashOf({ result: {} }), /no transaction hash/);
  assert.throws(() => hashOf(undefined), /no transaction hash/);
});

// ---- mainnet adapters: plan data -> FastNEAR actions, and the deployer key file --------------

const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const { base58 } = await import("@scure/base");
const { loadDeployerKey, toActions } = await import("../src/chain.mjs");

test("toActions turns every planned action into the FastNEAR action, and refuses an unknown one", () => {
  const out = toActions([
    { type: "CreateAccount" },
    { type: "Transfer", yocto: 5n },
    { type: "AddKey", publicKey: "ed25519:P" },
    { type: "DeleteKey", publicKey: "ed25519:Q" },
    { type: "DeployContract", codeBase64: "AAEC" },
    { type: "FunctionCall", method: "new", args: { a: 1 }, gasTgas: 30, depositYocto: 7n },
  ]);
  assert.deepEqual(out.map((a) => a.type), ["CreateAccount", "Transfer", "AddKey", "DeleteKey", "DeployContract", "FunctionCall"]);
  assert.equal(out[1].deposit, "5");
  assert.equal(out[3].publicKey, "ed25519:Q");
  assert.equal(out[5].gas, String(30n * 10n ** 12n));
  assert.equal(out[5].deposit, "7");
  assert.throws(() => toActions([{ type: "DeleteAccount" }]), /unknown action type/);
});

const keyDirs = [];
after(() => keyDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const keyFile = (content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keyfile-"));
  keyDirs.push(dir);
  const f = path.join(dir, "key.json");
  fs.writeFileSync(f, content);
  return f;
};

test("loadDeployerKey: derives the public key, hands back a sender, and never returns the private key", () => {
  // A public, obviously fake test vector (32 bytes of 0x01). It controls nothing.
  const fake = `ed25519:${base58.encode(new Uint8Array(32).fill(1))}`;
  const k = loadDeployerKey(keyFile(JSON.stringify({ account_id: "deployer.near", private_key: fake })));
  assert.equal(k.accountId, "deployer.near");
  assert.match(k.publicKey, /^ed25519:/);
  assert.equal(typeof k.send, "function");
  assert.ok(!JSON.stringify(Object.keys(k)).includes("private"));
  assert.ok(!k.publicKey.includes(fake.slice(8)));
});

test("loadDeployerKey: a bad file is refused without echoing a fragment of it", () => {
  const secret = "ed25519:SUPERSECRETLOOKINGTEXT";
  for (const content of [`{"account_id": "x.near", "private_key": "${secret}"`, `oops ${secret}`, JSON.stringify({ account_id: "x.near", private_key: secret }), JSON.stringify({ private_key: secret }), JSON.stringify([secret])]) {
    assert.throws(
      () => loadDeployerKey(keyFile(content)),
      (e) => !String(e.message).includes("SUPERSECRET") && /key file|private_key/.test(e.message),
    );
  }
  assert.throws(() => loadDeployerKey(path.join(os.tmpdir(), "no-such-keyfile.json")), /cannot read the key file.*ENOENT/);
});
