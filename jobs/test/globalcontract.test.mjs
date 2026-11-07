// M6 global-contract tooling (jobs/src/globalcontract.mjs, jobs/src/globaltx.mjs, `globalcontract` in bin.mjs).
// Nothing here touches a network. The chain is faked two ways: at the fetch level (so the real rpc.mjs, the real sender
// and the real signing run under the test, and the fake node decodes the signed transaction with a HAND-WRITTEN reader
// that shares no code with the library's borsh codec), and as an injected `sender` for the orchestration tests.
// Every key is generated in memory by the test; none is a real key and none holds anything.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { actions } from "@fastnear/api";
import { generateSigner, publicKeyToHandle } from "@fastnear/ml-dsa-65";
import { privateKeyFromRandom, publicKeyFromPrivate, serializeTransaction as librarySerialize, sha256, signerFromPrivateKey, toBase58, fromBase58 } from "@fastnear/utils";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  GlobalUsage, Refused, assertMamori, assertWasm, defaultPublishAccountId, defaultVaultId, describeWasm, estimateBurnYocto, formatNear, gasCostOf, measureFromOutcome, measurePublishTx, parseGlobalArgs, parseNear, planGlobalContract, planPublishOnly, preflight, readGlobalCode, renderMeasured, renderRun, runGlobalContract, splitOutcome, verifyVault,
} from "../src/globalcontract.mjs";
import { buildTrivialWasm } from "./fixtures/make-trivial-wasm.mjs";
import { adminSigner, assertSucceeded, hashBytes, loadFunder, makeSender, mapAction, readSeeds, serializeSignedTransaction, serializeTransaction, signTransaction } from "../src/globaltx.mjs";
import { makeRpc } from "../src/rpc.mjs";
import { codeHashOf } from "../src/verify.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "..", "src", "bin.mjs");
const NEAR = 10n ** 24n;
const EMPTY = "11111111111111111111111111111111";
const FUNDER = "funder.testnet";
const VAULT = `gv-test.${FUNDER}`;
const KIZASHI = "kizashi.testnet";
const pq = await import("@noble/post-quantum/ml-dsa.js").catch(() => null);

const tmpDirs = [];
const tmp = (p = "m6-") => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  tmpDirs.push(d);
  return d;
};
process.on("exit", () => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

// ---- a small valid wasm with chosen exports ----------------------------------------------------------------------

const leb = (n) => {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};
const section = (id, bytes) => [id, ...leb(bytes.length), ...bytes];
function wasmWithExports(names) {
  const type = section(1, [1, 0x60, 0, 0]);
  const func = section(3, [names.length, ...names.map(() => 0)]);
  const exps = section(7, [names.length, ...names.flatMap((n, i) => [...leb(n.length), ...Buffer.from(n), 0x00, i])]);
  const code = section(10, [names.length, ...names.flatMap(() => [2, 0, 0x0b])]);
  return Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...type, ...func, ...exps, ...code]);
}
const MAMORI = wasmWithExports(["init", "send_small", "request_withdraw", "execute", "config", "attest"]);
const HASH = codeHashOf(MAMORI);

// ---- keys -------------------------------------------------------------------------------------------------------

const funderPrivate = privateKeyFromRandom();
const funderPublic = publicKeyFromPrivate(funderPrivate);
const funderSigner = signerFromPrivateKey(funderPrivate);
const funder = { accountId: FUNDER, publicKey: funderPublic, signer: funderSigner };

// ---- a hand-written reader of the signed transaction (no borsh library) -----------------------------------------

class Reader {
  constructor(buf) {
    this.b = Buffer.from(buf);
    this.o = 0;
  }
  u8() {
    return this.b[this.o++];
  }
  u32() {
    const v = this.b.readUInt32LE(this.o);
    this.o += 4;
    return v;
  }
  u64() {
    const v = this.b.readBigUInt64LE(this.o);
    this.o += 8;
    return v;
  }
  u128() {
    const lo = this.u64();
    return lo + (this.u64() << 64n);
  }
  bytes(n) {
    const v = Buffer.from(this.b.subarray(this.o, this.o + n));
    this.o += n;
    return v;
  }
  str() {
    return this.bytes(this.u32()).toString("utf8");
  }
  done() {
    return this.o === this.b.length;
  }
}
const KEY_PREFIX = ["ed25519", "secp256k1", "ml-dsa-65"];
const KEY_LEN = [32, 64, 1952];
const SIG_LEN = [64, 65, 3309];
const readKey = (r) => {
  const t = r.u8();
  return `${KEY_PREFIX[t]}:${toBase58(r.bytes(KEY_LEN[t]))}`;
};

function readAction(r) {
  const tag = r.u8();
  switch (tag) {
    case 0:
      return { type: "CreateAccount" };
    case 2: {
      const method = r.str();
      const args = JSON.parse(r.bytes(r.u32()).toString("utf8"));
      return { type: "FunctionCall", method, args, gasTgas: Number(r.u64() / 10n ** 12n), depositYocto: r.u128() };
    }
    case 3:
      return { type: "Transfer", yocto: r.u128() };
    case 5: {
      const publicKey = readKey(r);
      r.u64();
      const perm = r.u8();
      assert.equal(perm, 1, "only full-access keys are added by this tool");
      return { type: "AddKey", publicKey };
    }
    case 6:
      return { type: "DeleteKey", publicKey: readKey(r) };
    case 9: {
      const code = r.bytes(r.u32());
      const mode = r.u8();
      return { type: "DeployGlobalContract", code, mode: mode === 0 ? "CodeHash" : mode === 1 ? "AccountId" : `?${mode}` };
    }
    case 10: {
      const id = r.u8();
      if (id === 0) return { type: "UseGlobalContract", codeHash: toBase58(r.bytes(32)) };
      return { type: "UseGlobalContract", accountId: r.str() };
    }
    default:
      throw new Error(`the test reader does not know action tag ${tag}`);
  }
}

/** Parses a signed transaction; asserts every byte is consumed. */
function parseSigned(bytes) {
  const r = new Reader(bytes);
  const signerId = r.str();
  const publicKey = readKey(r);
  const nonce = r.u64();
  const receiverId = r.str();
  const blockHash = toBase58(r.bytes(32));
  const actionsList = Array.from({ length: r.u32() }, () => readAction(r));
  const txEnd = r.o;
  const sigType = r.u8();
  const signature = r.bytes(SIG_LEN[sigType]);
  assert.ok(r.done(), "trailing bytes after the signature");
  return { signerId, publicKey, nonce, receiverId, blockHash, actions: actionsList, txBytes: Buffer.from(bytes).subarray(0, txEnd), sigType, signature };
}

// ---- a fake node, at the fetch level ----------------------------------------------------------------------------

/** An account's contract state is `global_contract_hash`; its ML-DSA keys are listed by handle, as the chain does. */
function makeWorld(over = {}) {
  return {
    chain_id: "testnet",
    protocol_version: 88,
    host_fns: true,
    height: 1_000,
    accounts: new Map([[FUNDER, { amount: (60n * NEAR).toString(), locked: "0", storage_usage: 182, code_hash: EMPTY }]]),
    keys: new Map([[FUNDER, [{ listed: funderPublic, full: funderPublic, nonce: 5, permission: "FullAccess" }]]]),
    globalCode: new Map(),
    config: new Map(),
    txs: new Map(),
    sentTxs: [],
    requests: [],
    ...over,
  };
}

const listedKey = (full) => (full.startsWith("ml-dsa-65:") ? publicKeyToHandle(full) : full);

/** Applies decoded action descriptors the way the chain would, or throws what the chain would fail with. */
function applyActions(w, signerId, receiverId, list) {
  const staged = {
    accounts: new Map([...w.accounts].map(([k, v]) => [k, { ...v }])),
    keys: new Map([...w.keys].map(([k, v]) => [k, v.map((x) => ({ ...x }))])),
    globalCode: new Map(w.globalCode),
    config: new Map(w.config),
  };
  for (const a of list) {
    const acc = staged.accounts.get(receiverId);
    const signerAcc = staged.accounts.get(signerId);
    if (a.type === "CreateAccount") {
      if (acc) throw new Error("AccountAlreadyExists");
      staged.accounts.set(receiverId, { amount: "0", locked: "0", storage_usage: 182, code_hash: EMPTY });
    } else if (a.type === "Transfer") {
      if (BigInt(signerAcc.amount) < a.yocto) throw new Error("LackBalanceForState");
      signerAcc.amount = (BigInt(signerAcc.amount) - a.yocto).toString();
      staged.accounts.get(receiverId).amount = (BigInt(staged.accounts.get(receiverId).amount) + a.yocto).toString();
    } else if (a.type === "AddKey") {
      staged.keys.set(receiverId, [...(staged.keys.get(receiverId) ?? []), { listed: listedKey(a.publicKey), full: a.publicKey, nonce: w.height * 1_000_000, permission: "FullAccess" }]);
    } else if (a.type === "DeployGlobalContract") {
      if (a.mode !== "CodeHash") throw new Error("this test world only accepts code-hash mode");
      const burn = BigInt(a.code.length) * 10n ** 20n;
      if (BigInt(acc.amount) < burn) throw new Error("LackBalanceForState (global contract burn)");
      acc.amount = (BigInt(acc.amount) - burn).toString();
      staged.globalCode.set(toBase58(sha256(a.code)), Buffer.from(a.code));
    } else if (a.type === "UseGlobalContract") {
      if (!staged.globalCode.has(a.codeHash)) throw new Error("GlobalContractDoesNotExist");
      acc.global_contract_hash = a.codeHash;
    } else if (a.type === "FunctionCall") {
      if (!acc.global_contract_hash) throw new Error("CodeDoesNotExist");
      if (a.method !== "init") throw new Error(`the test world only knows init, not ${a.method}`);
      if (signerId !== receiverId) throw new Error("Smart contract panicked: Method init is private");
      if (a.args.delay_secs < 86_400) throw new Error("Smart contract panicked: withdrawal delay must be at least 24 hours");
      if (staged.config.has(receiverId)) throw new Error("Smart contract panicked: The contract has already been initialized");
      staged.config.set(receiverId, { kizashi: a.args.kizashi, era: "Calm", daily_limit: a.args.daily_limit, delay_secs: a.args.delay_secs });
    } else throw new Error(`unhandled action ${a.type}`);
  }
  for (const k of ["accounts", "keys", "globalCode", "config"]) w[k] = staged[k];
}

const GAS_PRICE = 10n ** 8n;
/** The storage charge a global deploy puts into the receipt's tokens_burnt: 0.0001 NEAR (10^20 yocto) a byte of code. */
const deployCharge = (list) => list.filter((a) => a.type === "DeployGlobalContract").reduce((acc, a) => acc + BigInt(a.code.length) * 10n ** 20n, 0n);
/**
 * An outcome shaped like the real chain's (testnet, 2026-11-04): the transaction outcome, the action receipt, whose tokens_burnt for a
 * global deploy is its gas PLUS the storage `charge`, and a refund receipt that burns no tokens although it reports gas units.
 * Gas: (5 + 15) x 10^12 units at the price 10^8 = 2 x 10^21 yocto, the same figure in every test that checks gas.
 */
function outcomeOf({ gasUnits = [5n * 10n ** 12n, 15n * 10n ** 12n], charge = 0n, status = { SuccessValue: "" } } = {}) {
  const [txGas, receiptGas] = gasUnits;
  return {
    status,
    transaction_outcome: { id: "T", outcome: { gas_burnt: Number(txGas), tokens_burnt: (txGas * GAS_PRICE).toString(), status: { SuccessReceiptId: "R" } } },
    receipts_outcome: [
      { id: "R", outcome: { gas_burnt: Number(receiptGas), tokens_burnt: (receiptGas * GAS_PRICE + charge).toString(), status } },
      { id: "F", outcome: { gas_burnt: 1_000_000_000_000, tokens_burnt: "0", status: { SuccessValue: "" } } },
    ],
  };
}

const okResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, name, cause, data) => ({ jsonrpc: "2.0", id, error: { name, cause: { name: cause }, code: -32000, message: "Server error", data } });

function viewsOf(w, vault) {
  const acc = w.accounts.get(vault);
  const cfg = w.config.get(vault);
  if (!acc?.global_contract_hash || !cfg) return null;
  const attest = { attest_version: 1, contract: "mamori", drill_build: false, account_id: vault, block_height: String(w.height), block_timestamp: "1", config: cfg, min_delay_secs: 86_400, allowlist_enforced: false, allowlist_len: 0, daily_keys: [], intents_keys: [], revoked_keys: [], queue_len: 0, note: "informational", policy_account: null, safe_account: { current: null, pending: null }, watchers: [], emergency_until: "0", proposals: [] };
  return { config: cfg, daily_keys: [], intents_keys: [], revoked_keys: [], attest };
}

function handle(w, req) {
  w.requests.push(req);
  const { id, method, params: p } = req;
  if (method === "status") return okResult(id, { chain_id: w.chain_id, protocol_version: w.protocol_version });
  if (method === "EXPERIMENTAL_protocol_config") return okResult(id, { protocol_version: w.protocol_version, runtime_config: { wasm_config: w.host_fns === undefined ? {} : { global_contract_host_fns: w.host_fns } } });
  if (method === "block") return okResult(id, { header: { height: w.height, hash: toBase58(new Uint8Array(32).fill(9)) } });
  if (method === "send_tx") {
    const parsed = parseSigned(Buffer.from(p.signed_tx_base64, "base64"));
    const key = (w.keys.get(parsed.signerId) ?? []).find((k) => k.full === parsed.publicKey);
    if (!key) return rpcError(id, "HANDLER_ERROR", "INVALID_TRANSACTION", "InvalidAccessKeyError: AccessKeyNotFound");
    if (parsed.nonce <= BigInt(key.nonce)) return rpcError(id, "HANDLER_ERROR", "INVALID_TRANSACTION", `InvalidNonce: tx nonce ${parsed.nonce} is not above ${key.nonce}`);
    const hash = sha256(parsed.txBytes);
    // The signature has to verify over the hash of exactly the bytes that were sent.
    if (parsed.sigType === 0) assert.ok(ed25519.verify(parsed.signature, hash, fromBase58(parsed.publicKey.slice("ed25519:".length))), "ed25519 signature does not verify");
    else if (parsed.sigType === 2 && pq) assert.ok(pq.ml_dsa65.verify(parsed.signature, hash, fromBase58(parsed.publicKey.slice("ml-dsa-65:".length))), "ML-DSA-65 signature does not verify");
    w.sentTxs.push(parsed);
    const h58 = toBase58(hash);
    let status = { SuccessValue: "" };
    try {
      applyActions(w, parsed.signerId, parsed.receiverId, parsed.actions);
    } catch (e) {
      status = { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: e.message } } } } };
    }
    key.nonce = Number(parsed.nonce);
    // The signer pays the gas the outcome below reports (2 x 10^21 yocto); the storage charge of a global deploy is debited by applyActions.
    const payer = w.accounts.get(parsed.signerId);
    if (payer) payer.amount = (BigInt(payer.amount) > 2n * 10n ** 21n ? BigInt(payer.amount) - 2n * 10n ** 21n : 0n).toString();
    const succeeded = !status.Failure;
    const charge = succeeded ? deployCharge(parsed.actions) : 0n;
    const view = parsed.actions.map((a) => (a.type === "DeployGlobalContract" ? { DeployGlobalContract: { code: Buffer.from(sha256(a.code)).toString("base64") } } : { [a.type]: {} }));
    w.txs.set(h58, { final_execution_status: "FINAL", transaction: { hash: h58, signer_id: parsed.signerId, actions: view }, ...outcomeOf({ charge, status }) });
    if (!w.silentSend) w.height += 3;
    return okResult(id, { final_execution_status: "INCLUDED" });
  }
  if (method === "tx" || method === "EXPERIMENTAL_tx_status") {
    const t = w.txs.get(p.tx_hash);
    return t ? okResult(id, t) : rpcError(id, "HANDLER_ERROR", "UNKNOWN_TRANSACTION", `Transaction ${p.tx_hash} doesn't exist`);
  }
  if (method !== "query") return { jsonrpc: "2.0", id, error: { name: "METHOD_NOT_FOUND", message: method } };
  const missing = (account) => okResult(id, { error: `account ${account} does not exist while viewing` });
  switch (p.request_type) {
    case "view_account": {
      const a = w.accounts.get(p.account_id);
      return a ? okResult(id, { locked: "0", ...a }) : missing(p.account_id);
    }
    case "view_access_key": {
      const k = (w.keys.get(p.account_id) ?? []).find((x) => x.full === p.public_key || x.listed === p.public_key);
      return k ? okResult(id, { nonce: k.nonce, permission: k.permission }) : okResult(id, { error: `access key ${p.public_key} does not exist while viewing` });
    }
    case "view_access_key_list":
      return w.accounts.has(p.account_id) ? okResult(id, { keys: (w.keys.get(p.account_id) ?? []).map((k) => ({ public_key: k.listed, access_key: { nonce: k.nonce, permission: k.permission } })) }) : missing(p.account_id);
    case "view_global_contract_code": {
      const code = w.globalCode.get(p.code_hash);
      return code ? okResult(id, { code_base64: code.toString("base64"), hash: p.code_hash }) : rpcError(id, "HANDLER_ERROR", "NO_GLOBAL_CONTRACT_CODE", `Global contract code with identifier CodeHash(${p.code_hash}) has never been observed on the node`);
    }
    case "call_function": {
      const views = viewsOf(w, p.account_id);
      const v = views?.[p.method_name];
      if (v === undefined) return okResult(id, { error: "wasm execution failed with error: FunctionCallError(MethodResolveError(MethodNotFound))" });
      return okResult(id, { result: [...Buffer.from(JSON.stringify(v))] });
    }
    default:
      return okResult(id, { error: `unsupported request_type ${p.request_type}` });
  }
}

const rpcOf = (w) => makeRpc("http://fake.invalid", { retries: 0, fetchImpl: async (_u, init) => ({ status: 200, json: async () => handle(w, JSON.parse(init.body)) }) });
const READ_ONLY = new Set(["status", "EXPERIMENTAL_protocol_config", "block", "query", "tx"]);

// ---- orchestration helpers ---------------------------------------------------------------------------------------

const planOf = (over = {}) =>
  planGlobalContract({ wasm: MAMORI, wasmPath: "mamori.wasm", funderId: FUNDER, vault: VAULT, kizashi: KIZASHI, dailyLimitYocto: NEAR, delaySecs: 86_400, vaultYocto: NEAR, ...over });

/** A sender that applies descriptor actions to the world (no wire format), recording each call. */
function fakeSender(w, events) {
  let n = 0;
  return async ({ signerId, signer, receiverId, actions: list }) => {
    events.push({ kind: "send", signerId, receiverId, actions: list, signer });
    const burnt = BigInt(2e21);
    // The funder's gas comes off its balance like the chain's does.
    const acc = w.accounts.get(signerId);
    applyActions(w, signerId, receiverId, list.map((a) => (a.type === "Transfer" ? { ...a, yocto: BigInt(a.yocto) } : a)));
    w.accounts.get(signerId).amount = (BigInt(w.accounts.get(signerId).amount) - burnt).toString();
    void acc;
    w.height += 3;
    return { hash: `TX${++n}`, outcome: outcomeOf({ charge: deployCharge(list) }) };
  };
}

function adminFactory(events, seedStore) {
  return ({ vault, create }) => {
    events.push({ kind: "admin", vault, create });
    if (seedStore.has(vault)) return seedStore.get(vault);
    if (!create) return null;
    const s = generateSigner();
    seedStore.set(vault, s);
    return s;
  };
}

// ======================================================================================================================
// wire format
// ======================================================================================================================

test("wire: the ordinary actions serialise byte for byte as @fastnear/utils does", () => {
  const admin = generateSigner();
  const base = { signerId: "a.testnet", publicKey: funderPublic, nonce: 5n, receiverId: "v.a.testnet", blockHash: toBase58(new Uint8Array(32).fill(7)) };
  try {
    const lib = [
      actions.createAccount(),
      actions.transfer("1000"),
      actions.addFullAccessKey({ publicKey: funderPublic }),
      actions.addFullAccessKey({ publicKey: admin.publicKey }),
      actions.deleteKey({ publicKey: funderPublic }),
      actions.functionCall({ methodName: "init", args: { a: 1 }, gas: String(30n * 10n ** 12n), deposit: "0" }),
    ];
    const mine = [
      { type: "CreateAccount" },
      { type: "Transfer", yocto: 1000n },
      { type: "AddKey", publicKey: funderPublic },
      { type: "AddKey", publicKey: admin.publicKey },
      { type: "DeleteKey", publicKey: funderPublic },
      { type: "FunctionCall", method: "init", args: { a: 1 }, gasTgas: 30, depositYocto: 0 },
    ];
    assert.ok(Buffer.from(librarySerialize({ ...base, actions: lib })).equals(Buffer.from(serializeTransaction({ ...base, actions: mine }))));
  } finally {
    admin.destroy();
  }
});

test("wire: DeployGlobalContract and UseGlobalContract are tags 9 and 10 with the nearcore layout (hand-computed bytes)", () => {
  const base = { signerId: "a.testnet", publicKey: funderPublic, nonce: 5n, receiverId: "a.testnet", blockHash: toBase58(new Uint8Array(32).fill(7)) };
  const code = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
  const digest = Buffer.from(sha256(code));
  const header = Buffer.from(serializeTransaction({ ...base, actions: [] })).subarray(0, -4); // everything before the action count
  const u32 = (n) => Buffer.from(new Uint32Array([n]).buffer);
  const expected = Buffer.concat([header, u32(2), Buffer.from([9]), u32(code.length), code, Buffer.from([0]), Buffer.from([10, 0]), digest]);
  const got = Buffer.from(serializeTransaction({ ...base, actions: [{ type: "DeployGlobalContract", code, mode: "CodeHash" }, { type: "UseGlobalContract", codeHash: toBase58(digest) }] }));
  assert.equal(got.toString("hex"), expected.toString("hex"));
  // The independent reader agrees about what those bytes say.
  const r = new Reader(got);
  r.str();
  readKey(r);
  r.u64();
  r.str();
  r.bytes(32);
  assert.equal(r.u32(), 2);
  assert.deepEqual([readAction(r), readAction(r)].map((a) => a.type), ["DeployGlobalContract", "UseGlobalContract"]);
  assert.ok(r.done());
});

test("wire: refuses the by-account forms, an empty module, a bad hash and an unknown action", () => {
  assert.throws(() => mapAction({ type: "DeployGlobalContract", code: MAMORI, mode: "AccountId" }), /code hash only/);
  assert.throws(() => mapAction({ type: "DeployGlobalContract", code: new Uint8Array(0), mode: "CodeHash" }), /needs the wasm bytes/);
  assert.throws(() => mapAction({ type: "UseGlobalContract", accountId: "publisher.testnet" }), /needs a codeHash.*by-hash form only/);
  assert.throws(() => hashBytes("3yMApqCuCjXDWPrb"), /not a base58 sha256/); // decodes, but to fewer than 32 bytes
  assert.equal(hashBytes("3yMApqCuCjXDWPrbjfR5mjCPTHqFG8Pux1TxQrEM35jj").length, 32);
  assert.throws(() => hashBytes("0OIl"), /./);
  assert.throws(() => mapAction({ type: "DeleteAccount" }), /unknown action type/);
});

test("wire: a signed transaction is the transaction bytes plus the signature, and the signature verifies (ed25519 and ML-DSA-65)", async () => {
  const tx = { signerId: FUNDER, publicKey: funderPublic, nonce: 6n, receiverId: FUNDER, blockHash: toBase58(new Uint8Array(32).fill(3)), actions: [{ type: "DeployGlobalContract", code: MAMORI, mode: "CodeHash" }] };
  const a = await signTransaction(tx, funderSigner);
  const parsed = parseSigned(Buffer.from(a.signedBase64, "base64"));
  assert.equal(toBase58(sha256(parsed.txBytes)), a.hash);
  assert.ok(ed25519.verify(parsed.signature, sha256(parsed.txBytes), fromBase58(funderPublic.slice(8))));
  assert.deepEqual(parsed.actions.map((x) => [x.type, x.mode]), [["DeployGlobalContract", "CodeHash"]]);

  const admin = generateSigner();
  try {
    const t2 = { ...tx, signerId: VAULT, receiverId: VAULT, publicKey: admin.publicKey, actions: [{ type: "UseGlobalContract", codeHash: HASH }, { type: "FunctionCall", method: "init", args: { kizashi: KIZASHI }, gasTgas: 30, depositYocto: 0 }] };
    const b = await signTransaction(t2, admin);
    const p2 = parseSigned(Buffer.from(b.signedBase64, "base64"));
    assert.equal(p2.sigType, 2);
    assert.equal(p2.signature.length, 3309);
    if (pq) assert.ok(pq.ml_dsa65.verify(p2.signature, sha256(p2.txBytes), fromBase58(admin.publicKey.slice("ml-dsa-65:".length))));
    assert.deepEqual(p2.actions.map((x) => x.type), ["UseGlobalContract", "FunctionCall"], "both actions are in ONE transaction, in this order");
    await assert.rejects(() => signTransaction({ ...t2, publicKey: funderPublic }, admin), /not the transaction's/);
  } finally {
    admin.destroy();
  }
  assert.throws(() => serializeSignedTransaction(tx, new Uint8Array(10)), /signature is 64 bytes/);
});

test("wire: assertSucceeded throws on a failed transaction or receipt", () => {
  assert.throws(() => assertSucceeded({ status: { Failure: { x: 1 } } }, "H"), /failed/);
  assert.throws(() => assertSucceeded({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { Failure: { y: 2 } } } }] }, "H"), /"y":2/);
  assert.throws(() => assertSucceeded({}, "H"), /without a status/);
});

// ---- gas and the deploy charge are different things in tokens_burnt (a bug of the first real run) --------------

/** The real outcome of the first testnet publish (1,024 bytes, tx BpqsZRxP..., 2026-11-04), numbers as the RPC returned them. */
const REAL_PUBLISH_OUTCOME = {
  status: { SuccessValue: "" },
  transaction_outcome: { id: "BpqsZRxPHFhsr26evVxELm9qJC5cnUE6GbhEM5AQNHfg", outcome: { gas_burnt: 299801760976, tokens_burnt: "29980176097600000000" } },
  receipts_outcome: [
    { id: "7ZkeRcfBkdQJD25WsspT2tr7qGzEr3RDyA2JBEV", outcome: { gas_burnt: 364505250000, tokens_burnt: "102436450525000000000000" } },
    { id: "D9X8R4eT", outcome: { gas_burnt: 223182562500, tokens_burnt: "0" } },
  ],
};

test("cost split (bug of the first real run): tokens_burnt holds gas AND the deploy charge; gas comes from gas units x price, so the real publish splits into 0.000066431 NEAR and exactly 1e20 per byte, not into 'all gas, 0 per byte'", () => {
  const s = splitOutcome(REAL_PUBLISH_OUTCOME);
  assert.equal(s.splittable, true);
  assert.equal(s.tokensBurntYocto, 102_466_430_701_097_600_000_000n, "= the funder's balance fall in the real run (9.968286 -> 9.865820 NEAR)");
  assert.equal(s.gasPriceYocto, 10n ** 8n);
  assert.equal(s.gasUnits, 299_801_760_976n + 364_505_250_000n, "the refund receipt's 223182562500 units were not paid for: it burnt 0 tokens");
  assert.equal(s.gasCostYocto, 66_430_701_097_600_000_000n);
  assert.equal(s.deployChargeYocto, 1024n * 10n ** 20n);
  const m = measureFromOutcome({ outcome: REAL_PUBLISH_OUTCOME, bytes: 1024, before: 9_968_286_480_263_932_600_000_000n, after: 9_865_820_049_562_835_000_000_000n });
  assert.equal(m.fellByYocto, "102466430701097600000000");
  assert.equal(m.unexplainedYocto, "0", "balance fall = tokens_burnt");
  assert.deepEqual([m.gasBurntYocto, m.storageBurnYocto, m.yoctoPerByte, m.yoctoPerByteRemainder, m.warnings], ["66430701097600000000", "102400000000000000000000", "100000000000000000000", "0", []]);
  const text = renderMeasured(m).join("\n");
  assert.match(text, /fell by 0\.102466 NEAR/);
  assert.match(text, /of which gas 0\.000066431 NEAR \(664307010976 gas units x 100000000 yoctoNEAR\) and the deploy charge 0\.102400 NEAR/);
  assert.match(text, /= 100000000000000000000 yoctoNEAR per byte exactly/);
  assert.doesNotMatch(text, / 0 yoctoNEAR per byte/);
});

test("cost split: an outcome whose tokens_burnt is gas plus 0.1024 NEAR gives that 0.1024 NEAR as the charge and the gas as the gas; never 0 per byte while a charge was paid", () => {
  const charge = 123_456_789n * 10n ** 12n; // any other charge is reported as it is
  const out = outcomeOf({ charge: 1024n * 10n ** 20n });
  const s = splitOutcome(out);
  assert.equal(s.gasCostYocto, 2n * 10n ** 21n);
  assert.equal(s.deployChargeYocto, 1024n * 10n ** 20n);
  assert.equal(s.tokensBurntYocto, s.gasCostYocto + s.deployChargeYocto, "tokens_burnt = gas cost + 0.1024 NEAR");
  const m = measureFromOutcome({ outcome: out, bytes: 1024 });
  assert.equal(m.yoctoPerByte, (10n ** 20n).toString());
  assert.notEqual(m.yoctoPerByte, "0");
  // A different charge is reported as it is.
  assert.equal(measureFromOutcome({ outcome: outcomeOf({ charge }), bytes: 1000 }).storageBurnYocto, charge.toString());
  assert.equal(gasCostOf(outcomeOf()), 2n * 10n ** 21n, "a create or attach transaction has no charge: its gas is its tokens_burnt");
});

test("cost split: when gas and charge cannot be told apart, or the balance contradicts the outcome, there is NO per-byte figure and the output says why", () => {
  // No gas_burnt in the outcome (an old node, a different shape): unsplittable, never a guess.
  const noGas = { status: { SuccessValue: "" }, transaction_outcome: { outcome: { tokens_burnt: "5000" } }, receipts_outcome: [{ outcome: { tokens_burnt: "100000" } }] };
  assert.equal(splitOutcome(noGas).splittable, false);
  const a = measureFromOutcome({ outcome: noGas, bytes: 1024, before: 200000n, after: 95000n });
  assert.deepEqual([a.yoctoPerByte, a.gasBurntYocto, a.storageBurnYocto], [null, null, null]);
  const aText = renderMeasured(a).join("\n");
  assert.match(aText, /NO per-byte figure/);
  assert.match(aText, /WARNING: the outcome does not carry a usable gas_burnt/);
  assert.doesNotMatch(aText, /yoctoNEAR per byte/);
  // A price that does not divide exactly is not guessed at either.
  assert.equal(splitOutcome({ transaction_outcome: { outcome: { gas_burnt: 7, tokens_burnt: "100" } }, receipts_outcome: [] }).splittable, false);
  // The outcome shows no charge, but the balance fell by far more than the gas: a contradiction, so no "0 per byte".
  const free = outcomeOf({ charge: 0n });
  const c = measureFromOutcome({ outcome: free, bytes: 1024, before: 10n * NEAR, after: 10n * NEAR - 2n * 10n ** 21n - 1024n * 10n ** 20n });
  assert.equal(c.yoctoPerByte, null);
  assert.match(c.warnings.join(" "), /more than the gas, yet the outcome shows no deploy charge: no per-byte figure is given \(0 would be wrong\)/);
  assert.doesNotMatch(renderMeasured(c).join("\n"), / 0 yoctoNEAR per byte/);
  // A truly free deploy (charge 0, balance fell by the gas only) is a real 0, and is allowed to say so.
  const d = measureFromOutcome({ outcome: free, bytes: 1024, before: 10n * NEAR, after: 10n * NEAR - 2n * 10n ** 21n });
  assert.equal(d.yoctoPerByte, "0");
  // Something else moved the funder's balance: the outcome's split is kept, and the difference is a warning.
  const e = measureFromOutcome({ outcome: outcomeOf({ charge: 1024n * 10n ** 20n }), bytes: 1024, before: 10n * NEAR, after: 10n * NEAR - 3n * 10n ** 23n });
  assert.equal(e.yoctoPerByte, (10n ** 20n).toString());
  assert.match(e.warnings.join(" "), /something else moved the funder's balance/);
  // A remainder is shown, not rounded away.
  const f = measureFromOutcome({ outcome: outcomeOf({ charge: 1024n * 10n ** 20n + 5n }), bytes: 1024 });
  assert.equal(f.yoctoPerByteRemainder, "5");
  assert.match(renderMeasured(f).join("\n"), /per byte and 5\/1024 of a yoctoNEAR/);
});

test("cost-of: reads the publish transaction with EXPERIMENTAL_tx_status (read-only), takes the code hash from it, the bytes from the code the node holds, and prints the split", async () => {
  const w = makeWorld();
  const rpc = rpcOf(w);
  const sent = await runGlobalContract({ plan: publishPlan(), rpc, funder, sender: makeSender({ rpc, sleep: async () => {}, pollMs: 0 }), makeAdmin: adminFactory([], new Map()), yes: true, sleep: async () => {} });
  const before = w.requests.length;
  const r = await measurePublishTx({ rpc, txHash: sent.rec.txs.publish, signerId: FUNDER });
  const asked = w.requests.slice(before);
  assert.ok(asked.length > 0 && asked.every((q) => READ_ONLY.has(q.method) || q.method === "EXPERIMENTAL_tx_status"), "reads only");
  assert.ok(asked.some((q) => q.method === "EXPERIMENTAL_tx_status"));
  assert.equal(r.codeHash, TRIVIAL_HASH);
  assert.equal(r.measured.bytes, 1024);
  assert.equal(r.measured.yoctoPerByte, (10n ** 20n).toString());
  assert.equal(r.measured.gasBurntYocto, (2n * 10n ** 21n).toString());
  assert.equal(r.measured.fellByYocto, null, "balances are not known from a transaction alone");
  assert.equal((await measurePublishTx({ rpc, txHash: sent.rec.txs.publish, signerId: FUNDER, bytes: 2048 })).measured.bytes, 2048, "--bytes overrides");
  await assert.rejects(measurePublishTx({ rpc, txHash: sent.rec.txs.attach, signerId: ACCOUNT }), /is not a DeployGlobalContract transaction/);
  await assert.rejects(measurePublishTx({ rpc, txHash: "nope", signerId: FUNDER }), /UNKNOWN_TRANSACTION|doesn't exist/);
});

test("cost-of args: needs --signer, takes no publish / --verify / --yes, and --signer or --bytes alone are refused", () => {
  const d = { wasm: "w.wasm", seedFile: "s.json", funderFile: undefined };
  const o = parseGlobalArgs(["--cost-of", "H1", "--signer", FUNDER, "--bytes", "1024"], d);
  assert.deepEqual([o.mode, o.costOf, o.signer, o.bytes], ["cost", "H1", FUNDER, 1024]);
  assert.equal(parseGlobalArgs(["--cost-of", "H1", "--signer", FUNDER], d).bytes, undefined);
  const bad = (argv, re) => assert.throws(() => parseGlobalArgs(argv, d), (e) => e instanceof GlobalUsage && re.test(e.message));
  bad(["--cost-of", "H1"], /--cost-of needs --signer/);
  bad(["--cost-of", "H1", "--signer", FUNDER, "--yes"], /read-only on its own/);
  bad(["publish", "--wasm", "x.wasm", "--cost-of", "H1", "--signer", FUNDER], /read-only on its own/);
  bad(["--cost-of", "H1", "--signer", FUNDER, "--bytes", "0"], /positive whole number/);
  bad(["--signer", FUNDER, "--kizashi", KIZASHI], /belong to --cost-of/);
});

// ======================================================================================================================
// the plan
// ======================================================================================================================

test("plan: the code hash is the wasm's sha256, the burn is estimated at 0.0001 NEAR a byte, and everything is by hash", () => {
  const plan = planOf();
  assert.equal(plan.wasm.codeHash, HASH);
  assert.equal(plan.wasm.sha256Hex, Buffer.from(sha256(MAMORI)).toString("hex"));
  assert.equal(plan.wasm.codeHash, describeWasm(MAMORI).codeHash);
  assert.equal(plan.estimate.burnYocto, BigInt(MAMORI.length) * 10n ** 20n);
  assert.equal(estimateBurnYocto(100_000), 10n * NEAR, "the docs' 10 NEAR per 100 KB");
  assert.equal(plan.estimate.neededYocto, plan.estimate.burnYocto + NEAR + NEAR / 2n);
  const all = plan.steps.flatMap((s) => s.actions);
  assert.deepEqual(all.filter((a) => a.type === "DeployGlobalContract").map((a) => a.mode), ["CodeHash"]);
  assert.deepEqual(all.filter((a) => a.type === "UseGlobalContract").map((a) => Object.keys(a).sort().join()), ["codeHash,type"], "no by-account reference anywhere");
  assert.equal(all.find((a) => a.type === "UseGlobalContract").codeHash, HASH);
  const attach = plan.steps.find((s) => s.id === "attach");
  assert.deepEqual(attach.actions.map((a) => a.type), ["UseGlobalContract", "FunctionCall"], "init is in the same transaction as the attach");
  assert.equal(attach.actions[1].method, "init");
  assert.deepEqual(attach.actions[1].args, { kizashi: KIZASHI, daily_limit: NEAR.toString(), delay_secs: 86_400 });
  assert.match(attach.signer, /its ML-DSA-65 admin key/);
});

test("plan: refuses a file that is not Mamori before any NEAR is at stake", () => {
  assert.throws(() => assertMamori(Buffer.from("not wasm at all")), Refused);
  assert.throws(() => assertMamori(wasmWithExports(["new", "claim"])), /not Mamori: the wasm has no init, send_small/);
  assert.deepEqual(assertMamori(wasmWithExports(["init", "send_small", "request_withdraw", "execute", "config"])), { attest: false });
  assert.deepEqual(assertMamori(MAMORI), { attest: true });
});

test("plan: the vault must be a sub-account of the funder, the default name is derived from the hash, bad ids and delays are usage errors", () => {
  assert.equal(defaultVaultId("76abf7141d79", FUNDER), `gv-76abf714.${FUNDER}`);
  assert.equal(planOf({ vault: undefined }).vault, `gv-${Buffer.from(sha256(MAMORI)).toString("hex").slice(0, 8)}.${FUNDER}`);
  assert.throws(() => planOf({ vault: "someone.else.testnet" }), GlobalUsage);
  assert.throws(() => planOf({ kizashi: "Not An Account" }), GlobalUsage);
  assert.throws(() => planOf({ delaySecs: -1 }), GlobalUsage);
  assert.equal(planOf({ funderId: null, vault: undefined }).vault, `gv-${Buffer.from(sha256(MAMORI)).toString("hex").slice(0, 8)}.<funder>`);
  assert.equal(formatNear(37_619_200_000_000_000_000_000_000n), "37.6192");
  assert.equal(parseNear("0.25", "x"), NEAR / 4n);
  assert.throws(() => parseNear("a lot", "--vault-near"), GlobalUsage);
});

// ======================================================================================================================
// dry run and preflight
// ======================================================================================================================

test("dry run: reads the chain, prints the plan, signs and sends nothing, builds no key", async () => {
  const w = makeWorld();
  const out = await runGlobalContract({
    plan: planOf(),
    rpc: rpcOf(w),
    funder,
    sender: async () => assert.fail("a dry run must not send"),
    makeAdmin: () => assert.fail("a dry run must not make a key"),
  });
  assert.equal(out.dryRun, true);
  assert.equal(out.pre.ok, true);
  assert.ok(w.requests.length > 0 && w.requests.every((r) => READ_ONLY.has(r.method)), `only reads: ${[...new Set(w.requests.map((r) => r.method))]}`);
  assert.ok(!w.requests.some((r) => r.method === "send_tx"));
  const text = renderRun(out);
  assert.match(text, /cost ESTIMATE \(not measured\)/);
  assert.match(text, new RegExp(HASH));
  assert.match(text, /PASS {2}published already\? .*no: step 1 would publish it/);
  assert.equal(w.accounts.size, 1, "the world is unchanged");
});

test("dry run: without a funder file it still plans and reads, and says what it did not check", async () => {
  const w = makeWorld();
  const out = await runGlobalContract({ plan: planOf({ funderId: null, vault: undefined }), rpc: rpcOf(w), funder: null });
  assert.equal(out.pre.ok, true);
  assert.deepEqual(out.pre.checks.filter((c) => c.skipped).map((c) => c.name), ["funder balance and key", "vault account"]);
  assert.ok(w.requests.every((r) => READ_ONLY.has(r.method)));
});

test("preflight: refuses a mainnet node whatever was asked, an old protocol, a missing balance and a foreign key", async () => {
  const names = (pre) => pre.checks.filter((c) => !c.ok).map((c) => c.name);
  const mainnet = await preflight({ rpc: rpcOf(makeWorld({ chain_id: "mainnet", protocol_version: 86 })), plan: planOf(), funderKey: funderPublic, expectedChain: "mainnet" });
  assert.match(mainnet.checks[0].detail, /testnet only/);
  assert.equal(mainnet.ok, false);
  const asked = await preflight({ rpc: rpcOf(makeWorld({ chain_id: "mainnet", protocol_version: 86 })), plan: planOf(), funderKey: funderPublic });
  assert.ok(names(asked).includes("chain is the one asked for, and is not mainnet"));
  const old = await preflight({ rpc: rpcOf(makeWorld({ protocol_version: 84 })), plan: planOf(), funderKey: funderPublic });
  assert.ok(names(old).includes("protocol supports global contracts and ML-DSA-65 keys"));
  const poor = makeWorld();
  poor.accounts.get(FUNDER).amount = NEAR.toString();
  const lowFunds = await preflight({ rpc: rpcOf(poor), plan: planOf(), funderKey: funderPublic });
  assert.deepEqual(names(lowFunds), ["funder balance covers the burn, the vault and a margin"]);
  assert.match(lowFunds.checks.find((c) => !c.ok).detail, /available 0\.99\d+ NEAR, needs about 1\.5\d+ NEAR/);
  const foreign = await preflight({ rpc: rpcOf(makeWorld()), plan: planOf(), funderKey: "ed25519:11111111111111111111111111111111" });
  assert.deepEqual(names(foreign), ["funder file's key is a full-access key of the funder"]);
  const flagOff = await preflight({ rpc: rpcOf(makeWorld({ host_fns: false })), plan: planOf(), funderKey: funderPublic });
  assert.deepEqual(names(flagOff), ["node reports global-contract host functions"]);
});

test("preflight: a node that does not report the host-function flag is not a failure; code already published is read by hash and noted", async () => {
  const w = makeWorld({ host_fns: undefined });
  w.globalCode.set(HASH, MAMORI);
  const pre = await preflight({ rpc: rpcOf(w), plan: planOf(), funderKey: funderPublic });
  assert.equal(pre.ok, true);
  assert.equal(pre.facts.published, "yes");
  assert.match(pre.checks.find((c) => c.name.startsWith("published")).detail, /step 1 would be skipped \(no second burn\)/);
  assert.deepEqual(await readGlobalCode(rpcOf(makeWorld()), HASH), { present: false });
  assert.equal((await readGlobalCode(rpcOf(w), HASH)).hash, HASH);
});

// ======================================================================================================================
// the real run (--yes), with an injected sender
// ======================================================================================================================

test("run: publish, create, attach in that order; init rides in the SAME transaction as the attach and is signed by the vault's own ML-DSA key", async () => {
  const w = makeWorld();
  const events = [];
  const seeds = new Map();
  const dir = tmp();
  const recordFile = path.join(dir, "record.json");
  const out = await runGlobalContract({ plan: planOf(), rpc: rpcOf(w), funder, sender: fakeSender(w, events), makeAdmin: adminFactory(events, seeds), yes: true, recordFile, sleep: async () => {} });
  const sends = events.filter((e) => e.kind === "send");
  assert.deepEqual(sends.map((s) => [s.signerId, s.receiverId, s.actions.map((a) => a.type).join("+")]), [
    [FUNDER, FUNDER, "DeployGlobalContract"],
    [FUNDER, VAULT, "CreateAccount+Transfer+AddKey"],
    [VAULT, VAULT, "UseGlobalContract+FunctionCall"],
  ]);
  const admin = seeds.get(VAULT);
  assert.equal(sends[0].actions[0].mode, "CodeHash");
  assert.ok(Buffer.from(sends[0].actions[0].code).equals(MAMORI), "the bytes published are the bytes hashed");
  assert.equal(sends[1].actions[2].publicKey, admin.publicKey, "the admin key is the vault's only key from the first block");
  assert.equal(sends[2].signer, admin, "the attach is signed with the ML-DSA key, not a classical one");
  assert.deepEqual(sends[2].actions[1].args, { kizashi: KIZASHI, daily_limit: NEAR.toString(), delay_secs: 86_400 });
  assert.ok(events.findIndex((e) => e.kind === "admin" && e.create) < events.findIndex((e) => e.kind === "send" && e.receiverId === VAULT), "the admin key was made (and its seed saved) before it was put on the account");
  assert.equal(w.accounts.get(VAULT).global_contract_hash, HASH);
  assert.equal(out.rec.ok, true, JSON.stringify(out.rec.verify.filter((c) => !c.ok)));
  assert.deepEqual(out.rec.verify.map((c) => c.ok), [true, true, true, true]);
  assert.equal(out.cage.verdict, "GREEN");
  assert.deepEqual(out.rec.txs, { publish: "TX1", create: "TX2", attach: "TX3" });
  const measured = out.rec.measured;
  assert.equal(measured.estimatedBurnYocto, (BigInt(MAMORI.length) * 10n ** 20n).toString());
  assert.equal(BigInt(measured.storageBurnYocto), BigInt(MAMORI.length) * 10n ** 20n, "measured = balance fall minus the gas the outcome reports");
  assert.equal(BigInt(measured.fellByYocto), BigInt(MAMORI.length) * 10n ** 20n + BigInt(2e21));
  const saved = fs.readFileSync(recordFile, "utf8");
  assert.deepEqual(JSON.parse(saved).txs, out.rec.txs);
  assert.ok(!/seed|private/i.test(saved), "the record holds no secret");
  assert.match(renderRun(out), /MEASURED publishing cost for \d+ bytes of code:[\s\S]*of which gas 0\.002000000 NEAR \(20000000000000 gas units x 100000000 yoctoNEAR\)/);
  assert.equal(measured.yoctoPerByte, (10n ** 20n).toString(), "the per-byte price is storage burn / bytes");
  assert.equal(measured.yoctoPerByteRemainder, "0");
  assert.match(renderRun(out), /GREEN: all 15 conditions hold/);
});

test("run: refuses --yes without a funder, with another account's funder file, or when the preflight fails; nothing is sent in any of them", async () => {
  const never = async () => assert.fail("nothing may be sent");
  const noAdmin = () => assert.fail("no key may be made");
  await assert.rejects(runGlobalContract({ plan: planOf(), rpc: rpcOf(makeWorld()), funder: null, sender: never, makeAdmin: noAdmin, yes: true }), /--yes needs --funder-file/);
  await assert.rejects(runGlobalContract({ plan: planOf(), rpc: rpcOf(makeWorld()), funder: { ...funder, accountId: "other.testnet" }, sender: never, makeAdmin: noAdmin, yes: true }), /plan was made for funder\.testnet/);
  const poor = makeWorld();
  poor.accounts.get(FUNDER).amount = NEAR.toString();
  await assert.rejects(runGlobalContract({ plan: planOf(), rpc: rpcOf(poor), funder, sender: never, makeAdmin: noAdmin, yes: true }), /preflight failed, nothing was sent[\s\S]*FAIL {2}funder balance/);
  const mainnet = makeWorld({ chain_id: "mainnet", protocol_version: 86 });
  await assert.rejects(runGlobalContract({ plan: planOf(), rpc: rpcOf(mainnet), funder, sender: never, makeAdmin: noAdmin, yes: true }), /testnet only/);
  assert.equal(poor.requests.filter((r) => r.method === "send_tx").length, 0);
});

test("run: a second run after the code is published does not publish (or burn) again, and a finished run changes nothing", async () => {
  const w = makeWorld();
  const seeds = new Map();
  const first = [];
  await runGlobalContract({ plan: planOf(), rpc: rpcOf(w), funder, sender: fakeSender(w, first), makeAdmin: adminFactory([], seeds), yes: true, sleep: async () => {} });
  const balance = w.accounts.get(FUNDER).amount;
  const again = [];
  const out = await runGlobalContract({ plan: planOf(), rpc: rpcOf(w), funder, sender: fakeSender(w, again), makeAdmin: adminFactory([], seeds), yes: true, sleep: async () => {} });
  assert.equal(again.length, 0, "nothing to send");
  assert.equal(w.accounts.get(FUNDER).amount, balance);
  assert.deepEqual(out.rec.skipped.map((s) => s.split(":")[0]), ["publish", "create", "attach"]);
  assert.equal(out.rec.ok, true);
});

test("run: an init that panics fails the attach whole; the re-run resumes at the attach and does not publish or create again", async () => {
  const w = makeWorld();
  const seeds = new Map();
  const events = [];
  const bad = planOf({ delaySecs: 10 });
  await assert.rejects(runGlobalContract({ plan: bad, rpc: rpcOf(w), funder, sender: fakeSender(w, events), makeAdmin: adminFactory([], seeds), yes: true, sleep: async () => {} }), /withdrawal delay must be at least 24 hours/);
  assert.equal(events.filter((e) => e.kind === "send").length, 3, "publish, create and the failed attach were attempted");
  assert.equal(w.accounts.get(VAULT).global_contract_hash, undefined, "the failed batch left the vault without the contract");
  assert.ok(w.globalCode.has(HASH) && w.keys.get(VAULT).length === 1);
  const events2 = [];
  const out = await runGlobalContract({ plan: planOf(), rpc: rpcOf(w), funder, sender: fakeSender(w, events2), makeAdmin: adminFactory([], seeds), yes: true, sleep: async () => {} });
  assert.deepEqual(events2.filter((e) => e.kind === "send").map((e) => e.actions.map((a) => a.type).join("+")), ["UseGlobalContract+FunctionCall"]);
  assert.equal(out.rec.ok, true);
});

test("run: an existing vault with no admin seed on file, or a different key, is never touched", async () => {
  const w = makeWorld();
  w.globalCode.set(HASH, MAMORI);
  w.accounts.set(VAULT, { amount: NEAR.toString(), locked: "0", storage_usage: 182, code_hash: EMPTY });
  w.keys.set(VAULT, [{ listed: "ed25519:SOMEONE", full: "ed25519:SOMEONE", nonce: 1, permission: "FullAccess" }]);
  const never = async () => assert.fail("nothing may be sent");
  await assert.rejects(runGlobalContract({ plan: planOf(), rpc: rpcOf(w), funder, sender: never, makeAdmin: () => null, yes: true }), /no admin seed for it is on file/);
  const other = generateSigner();
  try {
    await assert.rejects(runGlobalContract({ plan: planOf(), rpc: rpcOf(w), funder, sender: never, makeAdmin: () => other, yes: true }), /does not match a full-access key/);
  } finally {
    other.destroy();
  }
});

test("run: a vault that already has other code is not given this one", async () => {
  const w = makeWorld();
  w.globalCode.set(HASH, MAMORI);
  const admin = generateSigner();
  try {
    w.accounts.set(VAULT, { amount: NEAR.toString(), locked: "0", storage_usage: 182, code_hash: EMPTY, global_contract_hash: "3yMApqCuCjXDWPrbjfR5mjCPTHqFG8Pux1TxQrEM35jj" });
    w.keys.set(VAULT, [{ listed: admin.publicKeyHandle, full: admin.publicKey, nonce: 1, permission: "FullAccess" }]);
    await assert.rejects(runGlobalContract({ plan: planOf(), rpc: rpcOf(w), funder, sender: async () => assert.fail("no send"), makeAdmin: () => admin, yes: true }), /already has a contract/);
  } finally {
    admin.destroy();
  }
});

// ======================================================================================================================
// verification
// ======================================================================================================================

test("verify: red when the vault follows a publisher account, uses another hash, carries local code, or the code is not on chain", async () => {
  const run = async (patch, { code = true } = {}) => {
    const w = makeWorld();
    if (code) w.globalCode.set(HASH, MAMORI);
    w.accounts.set(VAULT, { amount: NEAR.toString(), locked: "0", storage_usage: 182, code_hash: EMPTY, global_contract_hash: HASH, ...patch });
    w.keys.set(VAULT, [{ listed: "ml-dsa-65-hash:ADMIN", full: "ml-dsa-65:X", nonce: 1, permission: "FullAccess" }]);
    w.config.set(VAULT, { kizashi: KIZASHI, era: "Calm", daily_limit: NEAR.toString(), delay_secs: 86_400 });
    return verifyVault({ rpc: rpcOf(w), vault: VAULT, codeHash: HASH, adminHandle: "ml-dsa-65-hash:ADMIN" });
  };
  const failing = (r) => r.checks.filter((c) => !c.ok).map((c) => c.name);
  assert.deepEqual(failing(await run({})), []);
  assert.deepEqual(failing(await run({ global_contract_hash: "3yMApqCuCjXDWPrbjfR5mjCPTHqFG8Pux1TxQrEM35jj" })).slice(0, 1), ["vault's global_contract_hash equals the published hash"]);
  const byAccount = await run({ global_contract_hash: undefined, global_contract_account_id: "publisher.testnet" });
  assert.match(byAccount.checks[0].detail, /\(mutable\), not a hash/);
  assert.match((await run({ code_hash: "3yMApqCuCjXDWPrbjfR5mjCPTHqFG8Pux1TxQrEM35jj" })).checks[0].detail, /local code/);
  assert.ok(failing(await run({}, { code: false })).includes("the code published under that hash hashes to it"));
  const missing = await verifyVault({ rpc: rpcOf(makeWorld()), vault: "nope.testnet", codeHash: HASH });
  assert.match(missing.checks[0].detail, /does not exist/);
});

test("verify: a vault whose config differs from the init arguments fails the views check", async () => {
  const w = makeWorld();
  w.globalCode.set(HASH, MAMORI);
  w.accounts.set(VAULT, { amount: NEAR.toString(), locked: "0", storage_usage: 182, code_hash: EMPTY, global_contract_hash: HASH });
  w.keys.set(VAULT, [{ listed: "ml-dsa-65-hash:ADMIN", full: "ml-dsa-65:X", nonce: 1, permission: "FullAccess" }]);
  w.config.set(VAULT, { kizashi: "wrong.testnet", era: "Calm", daily_limit: "1", delay_secs: 10 });
  const r = await verifyVault({ rpc: rpcOf(w), vault: VAULT, codeHash: HASH, init: { kizashi: KIZASHI, daily_limit: NEAR.toString(), delay_secs: 86_400 } });
  const views = r.checks.find((c) => c.name === "views answer (config)");
  assert.equal(views.ok, false);
  assert.match(views.detail, /kizashi wrong\.testnet, delay_secs 10, daily_limit 1/);
});

// ======================================================================================================================
// the real sender, signing and wire format, end to end against the fake node
// ======================================================================================================================

test("end to end: the real sender signs and sends all three transactions, the fake node decodes and verifies them, and the vault ends attached by hash", async () => {
  const w = makeWorld();
  const rpc = rpcOf(w);
  const seeds = new Map();
  const events = [];
  const out = await runGlobalContract({ plan: planOf(), rpc, funder, sender: makeSender({ rpc, sleep: async () => {}, pollMs: 0 }), makeAdmin: adminFactory(events, seeds), yes: true, sleep: async () => {} });
  assert.equal(out.rec.ok, true, JSON.stringify(out.rec.verify.filter((c) => !c.ok)));
  assert.deepEqual(w.sentTxs.map((t) => [t.signerId, t.receiverId, t.actions.map((a) => a.type).join("+")]), [
    [FUNDER, FUNDER, "DeployGlobalContract"],
    [FUNDER, VAULT, "CreateAccount+Transfer+AddKey"],
    [VAULT, VAULT, "UseGlobalContract+FunctionCall"],
  ]);
  assert.deepEqual(w.sentTxs.map((t) => t.sigType), [0, 0, 2], "the funder signs with ed25519, the vault with ML-DSA-65");
  const publish = w.sentTxs[0].actions[0];
  assert.equal(publish.mode, "CodeHash");
  assert.equal(toBase58(sha256(publish.code)), HASH);
  const attach = w.sentTxs[2];
  assert.equal(attach.actions[0].codeHash, HASH);
  assert.deepEqual(attach.actions[1].args, { kizashi: KIZASHI, daily_limit: NEAR.toString(), delay_secs: 86_400 });
  assert.equal(attach.actions[1].gasTgas, 30);
  assert.equal(w.accounts.get(VAULT).global_contract_hash, HASH);
  assert.deepEqual(w.keys.get(VAULT).map((k) => k.listed), [seeds.get(VAULT).publicKeyHandle], "the vault's only key is the ML-DSA admin key");
  assert.ok(attach.nonce > w.sentTxs[1].nonce, "the new key's nonce comes from the chain, above the height-based start");
  assert.ok(BigInt(out.rec.measured.storageBurnYocto) > 0n);
  assert.equal(out.cage.verdict, "GREEN");
});

test("sender: a node refusal is thrown as it is; a lost broadcast whose hash landed is not sent twice; a lost broadcast that never landed says so", async () => {
  const sender = (w) => makeSender({ rpc: rpcOf(w), sleep: async () => {}, pollMs: 0, polls: 3 });
  const tx = { signerId: FUNDER, signer: funderSigner, receiverId: FUNDER, actions: [{ type: "Transfer", yocto: 1n }] };
  // refused: wrong key on the account
  const w1 = makeWorld();
  w1.keys.set(FUNDER, [{ listed: funderPublic, full: funderPublic, nonce: 5, permission: "FullAccess" }]);
  const stale = { ...tx, signer: signerFromPrivateKey(privateKeyFromRandom()) };
  await assert.rejects(sender(w1)(stale), /does not exist|AccessKeyNotFound/);
  // refused: a function-call key is not a full-access key
  const w2 = makeWorld();
  w2.keys.get(FUNDER)[0].permission = { FunctionCall: {} };
  await assert.rejects(sender(w2)(tx), /not a full-access key/);
  // lost broadcast, tx landed: the response is lost but the chain has it
  const w3 = makeWorld();
  const real = rpcOf(w3);
  let broadcasts = 0;
  const lossy = { ...real, call: async (method, params) => (method === "send_tx" ? ((broadcasts++, await real.call(method, params), Promise.reject(new Error("socket hang up"))) ) : real.call(method, params)) };
  const out = await makeSender({ rpc: lossy, sleep: async () => {}, pollMs: 0, polls: 3 })(tx);
  assert.equal(broadcasts, 1, "sent once");
  assert.equal(w3.sentTxs.length, 1);
  assert.match(out.hash, /./);
  // lost broadcast, never landed
  const w4 = makeWorld();
  const real4 = rpcOf(w4);
  const dead = { ...real4, call: async (method, params) => (method === "send_tx" ? Promise.reject(new Error("socket hang up")) : real4.call(method, params)) };
  await assert.rejects(makeSender({ rpc: dead, sleep: async () => {}, pollMs: 0, polls: 3 })(tx), /socket hang up; and the chain has no record of/);
  assert.equal(w4.sentTxs.length, 0);
  // an included transaction whose action failed
  const w5 = makeWorld();
  w5.accounts.get(FUNDER).amount = "0";
  await assert.rejects(sender(w5)({ ...tx, actions: [{ type: "Transfer", yocto: 10n }] }), /LackBalanceForState/);
});

// ======================================================================================================================
// keys and files
// ======================================================================================================================

test("loadFunder: reads a funder file, never returns or leaks the private key", () => {
  const dir = tmp();
  const f = path.join(dir, "funder.json");
  fs.writeFileSync(f, JSON.stringify({ account_id: FUNDER, private_key: funderPrivate }));
  const got = loadFunder(f);
  assert.equal(got.accountId, FUNDER);
  assert.equal(got.publicKey, funderPublic);
  assert.ok(!JSON.stringify(got).includes(funderPrivate.slice(8)), "the private key is not a property");
  assert.ok(!Object.values(got).some((v) => v === funderPrivate));
  fs.writeFileSync(f, `{"account_id": "x.testnet", "private_key": "${funderPrivate}"`); // truncated JSON
  assert.throws(() => loadFunder(f), (e) => /not valid JSON/.test(e.message) && !e.message.includes(funderPrivate.slice(8)));
  fs.writeFileSync(f, JSON.stringify({ account_id: FUNDER, private_key: "ed25519:abc" }));
  assert.throws(() => loadFunder(f), (e) => /not a valid NEAR private key/.test(e.message) && !e.message.includes("abc"));
  assert.throws(() => loadFunder(path.join(dir, "missing.json")), /ENOENT/);
});

test("adminSigner: the seed is on disk before the signer is returned, the same seed gives the same key, a damaged file is left alone", () => {
  const dir = tmp();
  const seedFile = path.join(dir, "deeper", "global-admin-seeds.json");
  assert.equal(adminSigner({ seedFile, vault: VAULT }), null, "no seed and no create: nothing is made");
  assert.ok(!fs.existsSync(seedFile));
  const a = adminSigner({ seedFile, vault: VAULT, create: true });
  const onDisk = readSeeds(seedFile);
  assert.match(onDisk[VAULT], /^[0-9a-f]{64}$/, "a 32-byte seed in hex, the format DEMO_ADMIN_SEEDS uses");
  const b = adminSigner({ seedFile, vault: VAULT, create: true });
  assert.equal(b.publicKey, a.publicKey);
  assert.deepEqual(readSeeds(seedFile), onDisk, "reused, not regenerated");
  const c = adminSigner({ seedFile, vault: `other.${FUNDER}`, create: true });
  assert.deepEqual(Object.keys(readSeeds(seedFile)).sort(), [VAULT, `other.${FUNDER}`].sort(), "a second vault is added without losing the first");
  [a, b, c].forEach((s) => s.destroy());
  fs.writeFileSync(seedFile, "{ broken");
  assert.throws(() => adminSigner({ seedFile, vault: VAULT, create: true }), /not a JSON object[\s\S]*was not touched/);
  assert.equal(fs.readFileSync(seedFile, "utf8"), "{ broken");
});

// ======================================================================================================================
// the command line
// ======================================================================================================================

test("args: defaults, the funder file from the environment default, and every usage error", () => {
  const d = { wasm: "w.wasm", seedFile: "s.json", funderFile: "env-funder.json" };
  const o = parseGlobalArgs(["--kizashi", KIZASHI], d);
  assert.deepEqual([o.mode, o.wasm, o.funderFile, o.seedFile, o.yes, o.delaySecs, o.chainId], ["deploy", "w.wasm", "env-funder.json", "s.json", false, 86_400, "testnet"]);
  assert.equal(o.vaultYocto, NEAR);
  assert.equal(o.dailyLimitYocto, NEAR);
  const v = parseGlobalArgs(["--verify", VAULT, "--code-hash", HASH], d);
  assert.deepEqual([v.mode, v.verifyVault, v.codeHash], ["verify", VAULT, HASH]);
  const bad = (argv, re) => assert.throws(() => parseGlobalArgs(argv, d), (e) => e instanceof GlobalUsage && re.test(e.message));
  bad([], /--kizashi/);
  bad(["--kizashi", KIZASHI, "--chain-id", "mainnet"], /testnet only/);
  bad(["--kizashi"], /needs a value/);
  bad(["--kizashi", KIZASHI, "--kizashi", "b.testnet"], /given twice/);
  bad(["--kizashi", KIZASHI, "--frobnicate"], /unknown option/);
  bad(["--kizashi", KIZASHI, "stray"], /unexpected argument/);
  bad(["--kizashi", KIZASHI, "--delay-secs", "1.5"], /whole number/);
  bad(["--kizashi", KIZASHI, "--vault-near", "lots"], /not an amount in NEAR/);
  bad(["--verify", VAULT, "--yes"], /read-only/);
  bad(["--verify", VAULT, "--wasm", "a", "--code-hash", HASH], /exclude each other/);
  bad(["--verify", VAULT, "--code-hash", "not a hash"], /neither a base58 nor/);
});

const cli = (args, env = {}) => {
  const clean = { ...process.env, KAIGEN_RPC: "", ...env };
  delete clean.KAIGEN_FUNDER_FILE;
  return spawnSync(process.execPath, [BIN, "globalcontract", ...args], { encoding: "utf8", env: { ...clean, ...env }, timeout: 60_000 });
};

test("cli: usage errors exit 2 and print the usage, --yes without a funder file refuses before any network use, mainnet is refused", () => {
  const none = cli([]);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /--kizashi[\s\S]*usage: kaigen-jobs globalcontract/);
  assert.equal(cli(["--kizashi", KIZASHI, "--chain-id", "mainnet"]).status, 2);
  assert.equal(cli(["--verify", VAULT, "--yes"]).status, 2);
  const started = Date.now();
  // The RPC is unreachable on purpose: if the refusal needed the network this would hang through the client's retries.
  // --wasm is given on purpose: the default is out/prod/mamori.wasm, which a clean clone does not have (the missing-wasm refusal would come first).
  const wasmFile = path.join(tmp("gc-nofunder-"), "mamori.wasm");
  fs.writeFileSync(wasmFile, MAMORI);
  const noFunder = cli(["--kizashi", KIZASHI, "--wasm", wasmFile, "--rpc", "http://127.0.0.1:9", "--yes"]);
  assert.equal(noFunder.status, 1);
  assert.match(noFunder.stderr, /--yes needs --funder-file/);
  assert.ok(Date.now() - started < 20_000, "refused without touching the network");
});

test("cli: a missing wasm and a wasm that is not Mamori are refused with a clear message", () => {
  const dir = tmp();
  const notWasm = path.join(dir, "x.wasm");
  fs.writeFileSync(notWasm, "hello");
  const missing = cli(["--kizashi", KIZASHI, "--wasm", path.join(dir, "nope.wasm")]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /cannot read the wasm .*ENOENT/);
  const wrong = cli(["--kizashi", KIZASHI, "--wasm", notWasm]);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /not a wasm module/);
});

// ======================================================================================================================
// publish-only mode (`globalcontract publish --wasm <file>`): any valid wasm, no init, measured cost
// ======================================================================================================================

const FIXTURE = path.join(here, "fixtures", "trivial.wasm");
const FIXTURE_SHA256 = "806e2476b2af830f9cc990b199064e2111d42b115c652a67b7b49c6450b5b876";
const TRIVIAL = fs.readFileSync(FIXTURE);
const TRIVIAL_HASH = codeHashOf(TRIVIAL);
const ACCOUNT = `gp-test.${FUNDER}`;
const publishPlan = (over = {}) => planPublishOnly({ wasm: TRIVIAL, wasmPath: FIXTURE, funderId: FUNDER, account: ACCOUNT, accountYocto: NEAR / 10n, ...over });

test("fixture: trivial.wasm matches its recorded sha256, rebuilds byte for byte, and is a valid one-function module of a few hundred bytes to 10 KB", async () => {
  const { createHash } = await import("node:crypto");
  const hex = createHash("sha256").update(TRIVIAL).digest("hex");
  assert.equal(hex, FIXTURE_SHA256, "the pinned hash in this test");
  assert.equal(fs.readFileSync(`${FIXTURE}.sha256`, "utf8"), `${FIXTURE_SHA256}  trivial.wasm\n`, "the sha256 file next to it, in sha256sum format");
  assert.ok(buildTrivialWasm().equals(TRIVIAL), "make-trivial-wasm.mjs rebuilds exactly this file");
  assert.ok(TRIVIAL.length >= 300 && TRIVIAL.length <= 10 * 1024, `${TRIVIAL.length} bytes`);
  assert.equal(TRIVIAL.length, 1024);
  const module = new WebAssembly.Module(TRIVIAL);
  assert.deepEqual(WebAssembly.Module.exports(module), [{ name: "ping", kind: "function" }]);
  assert.deepEqual(WebAssembly.Module.imports(module), [], "no imports, no memory");
  assert.equal(new WebAssembly.Instance(module, {}).exports.ping(), undefined, "it runs");
  assert.equal(assertWasm(TRIVIAL).constructor, WebAssembly.Module);
  assert.equal(TRIVIAL_HASH, describeWasm(TRIVIAL).codeHash);
});

test("publish args: --wasm is required, the vault-run options are refused, the account defaults to 0.1 NEAR", () => {
  const d = { wasm: "default.wasm", seedFile: "s.json", funderFile: "env-funder.json" };
  const o = parseGlobalArgs(["publish", "--wasm", "x.wasm"], d);
  assert.deepEqual([o.mode, o.wasm, o.funderFile, o.yes, o.chainId, o.vaultYocto], ["publish", "x.wasm", "env-funder.json", false, "testnet", NEAR / 10n]);
  assert.equal(parseGlobalArgs(["publish", "--wasm", "x.wasm", "--yes", "--vault-near", "0.25", "--vault", ACCOUNT], d).vaultYocto, NEAR / 4n);
  const bad = (argv, re) => assert.throws(() => parseGlobalArgs(argv, d), (e) => e instanceof GlobalUsage && re.test(e.message));
  bad(["publish"], /publish needs --wasm/);
  bad(["publish", "--wasm", "x.wasm", "--kizashi", KIZASHI], /--kizashi is not used by publish/);
  bad(["publish", "--wasm", "x.wasm", "--delay-secs", "5"], /--delay-secs is not used by publish/);
  bad(["publish", "--wasm", "x.wasm", "--verify", VAULT], /--verify is not used by publish/);
  bad(["publish", "--wasm", "x.wasm", "--chain-id", "mainnet"], /testnet only/);
  assert.equal(parseGlobalArgs(["--kizashi", KIZASHI], d).mode, "deploy", "without the word publish nothing changed");
});

test("publish plan: any valid wasm, by hash, and the attach is UseGlobalContract alone: no init and no call anywhere", () => {
  const plan = publishPlan();
  assert.equal(plan.init, null);
  assert.equal(plan.wasm.codeHash, TRIVIAL_HASH);
  assert.deepEqual(plan.steps.map((s) => [s.id, s.actions.map((a) => a.type).join("+")]), [["publish", "DeployGlobalContract"], ["create", "CreateAccount+Transfer+AddKey"], ["attach", "UseGlobalContract"]]);
  assert.ok(!plan.steps.flatMap((s) => s.actions).some((a) => a.type === "FunctionCall"));
  assert.equal(plan.steps[0].actions[0].mode, "CodeHash");
  assert.equal(plan.steps[2].actions[0].codeHash, TRIVIAL_HASH);
  assert.equal(plan.estimate.burnYocto, 1024n * 10n ** 20n);
  assert.equal(plan.estimate.neededYocto, 1024n * 10n ** 20n + NEAR / 10n + NEAR / 2n);
  assert.equal(defaultPublishAccountId("806e2476b2af", FUNDER), `gp-806e2476.${FUNDER}`);
  assert.equal(publishPlan({ account: undefined }).vault, `gp-806e2476.${FUNDER}`);
  assert.throws(() => publishPlan({ account: "someone.else.testnet" }), GlobalUsage);
  assert.throws(() => planPublishOnly({ wasm: Buffer.from("hello world, not wasm"), funderId: FUNDER, accountYocto: NEAR }), Refused);
  assert.throws(() => planPublishOnly({ wasm: Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0xff, 0xff]), funderId: FUNDER, accountYocto: NEAR }), /does not compile as wasm/);
  assert.equal(planPublishOnly({ wasm: MAMORI, funderId: FUNDER, accountYocto: NEAR }).init, null, "Mamori itself is just another wasm here");
});

test("publish dry run: reads only, builds no key, sends nothing, and says there is no init", async () => {
  const w = makeWorld();
  const out = await runGlobalContract({ plan: publishPlan(), rpc: rpcOf(w), funder, sender: async () => assert.fail("a dry run must not send"), makeAdmin: () => assert.fail("a dry run must not make a key") });
  assert.equal(out.dryRun, true);
  assert.equal(out.pre.ok, true);
  assert.ok(w.requests.every((r) => READ_ONLY.has(r.method)));
  const text = renderRun(out);
  assert.match(text, /init {8}none \(publish-only mode/);
  assert.match(text, /cost ESTIMATE \(not measured\): publishing burns about 0\.1024 NEAR \(1024 bytes/);
  assert.match(text, /The account gets 0\.1000 NEAR\. The funder needs about 0\.7024 NEAR/);
  assert.doesNotMatch(text, /MEASURED/);
});

test("publish run: publish, create, attach with UseGlobalContract alone; verified by hash; the cost is MEASURED from the balances and printed with bytes, gas and the price per byte", async () => {
  const w = makeWorld();
  const events = [];
  const seeds = new Map();
  const out = await runGlobalContract({ plan: publishPlan(), rpc: rpcOf(w), funder, sender: fakeSender(w, events), makeAdmin: adminFactory(events, seeds), yes: true, sleep: async () => {} });
  const sends = events.filter((e) => e.kind === "send");
  assert.deepEqual(sends.map((s) => [s.signerId, s.receiverId, s.actions.map((a) => a.type).join("+")]), [
    [FUNDER, FUNDER, "DeployGlobalContract"],
    [FUNDER, ACCOUNT, "CreateAccount+Transfer+AddKey"],
    [ACCOUNT, ACCOUNT, "UseGlobalContract"],
  ]);
  assert.equal(sends[2].signer, seeds.get(ACCOUNT), "the attach is signed by the account's own ML-DSA key");
  assert.ok(!sends.some((s) => s.actions.some((a) => a.type === "FunctionCall")), "no call of any kind");
  assert.equal(w.accounts.get(ACCOUNT).global_contract_hash, TRIVIAL_HASH);
  assert.equal(out.rec.mode, "publish");
  assert.equal(out.rec.ok, true, JSON.stringify(out.rec.verify.filter((c) => !c.ok)));
  assert.deepEqual(out.rec.verify.map((c) => c.name), ["vault's global_contract_hash equals the published hash", "the code published under that hash hashes to it"], "by hash and by the code on chain; no views, no cage-check for an arbitrary wasm");
  assert.equal(out.cage, null);
  assert.ok(!w.requests.some((r) => r.method === "query" && r.params.request_type === "call_function"), "nothing was called on the account");
  const m = out.rec.measured;
  assert.deepEqual(
    [m.bytes, m.funderBalanceBeforeYocto, m.gasBurntYocto, m.storageBurnYocto, m.yoctoPerByte, m.yoctoPerByteRemainder],
    [1024, (60n * NEAR).toString(), "2000000000000000000000", (1024n * 10n ** 20n).toString(), (10n ** 20n).toString(), "0"],
  );
  assert.equal(BigInt(m.fellByYocto), BigInt(m.funderBalanceBeforeYocto) - BigInt(m.funderBalanceAfterYocto));
  assert.deepEqual(Object.keys(out.rec.gasBurntYocto), ["publish", "create", "attach"], "gas of every transaction");
  const text = renderRun(out);
  assert.match(text, /MEASURED publishing cost for 1024 bytes of code:/);
  assert.match(text, /funder balance before 60\.000000 NEAR, after 59\.895600 NEAR, fell by 0\.104400 NEAR/);
  assert.match(text, /of which gas 0\.002000000 NEAR \(20000000000000 gas units x 100000000 yoctoNEAR\) and the deploy charge 0\.102400 NEAR/);
  assert.match(text, /gas of the other transactions: create 0\.002000000, attach 0\.002000000 NEAR/);
  assert.match(text, /deploy charge \/ bytes = 100000000000000000000 yoctoNEAR per byte exactly/);
  assert.match(text, /All 2 checks passed/);
});

test("publish run: code that is already on chain is not published (or paid for) again, and the output says nothing was measured", async () => {
  const w = makeWorld();
  w.globalCode.set(TRIVIAL_HASH, TRIVIAL);
  const events = [];
  const out = await runGlobalContract({ plan: publishPlan(), rpc: rpcOf(w), funder, sender: fakeSender(w, events), makeAdmin: adminFactory(events, new Map()), yes: true, sleep: async () => {} });
  assert.deepEqual(events.filter((e) => e.kind === "send").map((e) => e.actions.map((a) => a.type).join("+")), ["CreateAccount+Transfer+AddKey", "UseGlobalContract"]);
  assert.equal(out.rec.measured, undefined);
  assert.match(renderRun(out), /NO MEASUREMENT: the code was already on chain under this hash/);
  assert.equal(out.rec.ok, true);
});

test("publish end to end: the real sender and the wire format, decoded by the fake node; the measured price per byte comes from the node's balances", async () => {
  const w = makeWorld();
  const rpc = rpcOf(w);
  const seeds = new Map();
  const out = await runGlobalContract({ plan: publishPlan(), rpc, funder, sender: makeSender({ rpc, sleep: async () => {}, pollMs: 0 }), makeAdmin: adminFactory([], seeds), yes: true, sleep: async () => {} });
  assert.equal(out.rec.ok, true, JSON.stringify(out.rec.verify.filter((c) => !c.ok)));
  assert.deepEqual(w.sentTxs.map((t) => [t.signerId, t.receiverId, t.actions.map((a) => a.type).join("+"), t.sigType]), [
    [FUNDER, FUNDER, "DeployGlobalContract", 0],
    [FUNDER, ACCOUNT, "CreateAccount+Transfer+AddKey", 0],
    [ACCOUNT, ACCOUNT, "UseGlobalContract", 2],
  ]);
  assert.equal(toBase58(sha256(w.sentTxs[0].actions[0].code)), TRIVIAL_HASH);
  assert.equal(w.sentTxs[2].actions[0].codeHash, TRIVIAL_HASH);
  // The fake node's world burns 1e20 yocto per published byte; the tool's measurement recovers exactly that from the balances and the reported gas.
  assert.equal(out.rec.measured.yoctoPerByte, (10n ** 20n).toString());
  assert.equal(out.rec.measured.bytes, 1024);
  assert.equal(w.accounts.get(ACCOUNT).global_contract_hash, TRIVIAL_HASH);
});

test("cli: publish without --wasm or with vault-run options exits 2, --yes without a funder refuses offline, a file that is not wasm is refused", () => {
  assert.equal(cli(["publish"]).status, 2);
  assert.match(cli(["publish"]).stderr, /publish needs --wasm[\s\S]*usage: kaigen-jobs globalcontract publish/);
  assert.equal(cli(["publish", "--wasm", FIXTURE, "--kizashi", KIZASHI]).status, 2);
  const started = Date.now();
  const noFunder = cli(["publish", "--wasm", FIXTURE, "--rpc", "http://127.0.0.1:9", "--yes"]);
  assert.equal(noFunder.status, 1);
  assert.match(noFunder.stderr, /--yes needs --funder-file/);
  assert.ok(Date.now() - started < 20_000, "refused without touching the network");
  const dir = tmp();
  const notWasm = path.join(dir, "x.wasm");
  fs.writeFileSync(notWasm, "hello");
  const wrong = cli(["publish", "--wasm", notWasm]);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /not a wasm module/);
  assert.equal(cli(["publish", "--wasm", path.join(dir, "nope.wasm")]).status, 1);
});

test("the planner cannot sign or send: globalcontract.mjs imports no signing library, no sender and makes no network call", () => {
  const src = fs.readFileSync(path.join(here, "..", "src", "globalcontract.mjs"), "utf8");
  const imports = src.match(/^import .*$/gm) ?? [];
  assert.ok(imports.length > 0);
  assert.deepEqual(imports.filter((l) => /@fastnear|globaltx\.mjs|chain\.mjs|node:(http|https|net|child_process)/.test(l)), []);
  assert.ok(!/\bsendTx\b/.test(src));
  assert.ok(!/\bfetch\s*\(/.test(src), "reads go through the injected rpc");
});
