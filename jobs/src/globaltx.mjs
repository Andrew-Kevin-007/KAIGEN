// Transactions for the two actions @fastnear/api 2.5.0 cannot build: DeployGlobalContract and UseGlobalContract.
//
// `actions` in @fastnear/api has no builder for them, @fastnear/borsh-schema says "9-11 ... not modelled" and the
// library's `mapAction` throws "Not implemented action" for anything else, so `sendTx` cannot carry them. This file
// goes one level down: it serialises the transaction with the library's own borsh codec (`exp.borsh`) and its
// PublicKey / Signature / FunctionCall schemas, adds the two missing Action variants, signs the transaction hash
// with any `{ publicKey, signHash }` signer and sends it with the injected JSON-RPC client.
//
// Wire format, from nearcore (near-primitives 0.38.0, protocol 88): Action discriminant 9 = DeployGlobalContract
// { code: u32 length + bytes, deploy_mode: u8 (0 = CodeHash, 1 = AccountId) } and 10 = UseGlobalContract
// { contract_identifier: u8 tag (0 = CodeHash then 32 bytes, 1 = AccountId then a string) }. Only the by-hash
// forms are built here: the by-account form is mutable and this tool never wants it.
//
// Not yet accepted by a live node: the bytes are pinned by tests/globalcontract.test.mjs against the library's own
// serialiser for the ordinary actions and against hand-computed bytes for the two new ones. Nothing here imports
// the planner, and the planner (globalcontract.mjs) imports nothing from here: the sender is handed in.
import fs from "node:fs";
import path from "node:path";
import { generateSigner, signerFromSeed } from "@fastnear/ml-dsa-65";
import { bytesToBase64, decodeNearPublicKey, exp, fromBase58, NEAR_KEY_DESCRIPTORS, privateKeyFromRandom, publicKeyFromPrivate, sha256, signerFromPrivateKey, toBase58 } from "@fastnear/utils";
import { RpcError } from "./rpc.mjs";

const TGAS = (n) => BigInt(n) * 10n ** 12n;
const DEPLOY_MODE_CODE_HASH = 0;
export const DEPLOY_GLOBAL_CONTRACT_TAG = 9;
export const USE_GLOBAL_CONTRACT_TAG = 10;
const KNOWN_CLASSIC_KEYS = ["createAccount", "deployContract", "functionCall", "transfer", "stake", "addKey", "deleteKey", "deleteAccount", "signedDelegate"];

// ---- schema -----------------------------------------------------------------------------------------------------

/**
 * The library's schema with the two global-contract variants added at tags 9 and 10. Built once, from copies:
 * the library's shared schema object is never changed. If a later @fastnear/borsh-schema models tags 9 to 11 itself,
 * the shape check below fails loudly instead of sending two variants with one tag.
 */
function buildSchema() {
  const base = exp.borshSchema.getBorshSchema();
  const entries = base.Action.enum;
  const classic = entries.slice(0, KNOWN_CLASSIC_KEYS.length);
  const rest = entries.slice(KNOWN_CLASSIC_KEYS.length);
  const keysOk = classic.length === KNOWN_CLASSIC_KEYS.length && classic.every((e, i) => Object.keys(e.struct)[0] === KNOWN_CLASSIC_KEYS[i] && e.tag === undefined);
  const restOk = rest.every((e) => Number.isInteger(e.tag) && e.tag > USE_GLOBAL_CONTRACT_TAG + 1);
  if (!keysOk || !restOk) throw new Error("@fastnear/borsh-schema changed its Action enum: revisit jobs/src/globaltx.mjs before sending anything");
  const Action = {
    enum: [
      ...classic,
      { tag: DEPLOY_GLOBAL_CONTRACT_TAG, struct: { deployGlobalContract: { struct: { code: { array: { type: "u8" } }, deployMode: "u8" } } } },
      { tag: USE_GLOBAL_CONTRACT_TAG, struct: { useGlobalContract: { struct: { contractIdentifier: { enum: [{ struct: { codeHash: { array: { type: "u8", len: 32 } } } }, { struct: { accountId: "string" } }] } } } } },
      ...rest,
    ],
  };
  const Transaction = {
    struct: {
      signerId: "string",
      publicKey: base.PublicKey,
      nonce: "u64",
      receiverId: "string",
      blockHash: { array: { type: "u8", len: 32 } },
      actions: { array: { type: Action } },
    },
  };
  return { Action, Transaction, SignedTransaction: { struct: { transaction: Transaction, signature: base.Signature } } };
}
let schemaCache;
const schema = () => (schemaCache ??= buildSchema());

// ---- actions ----------------------------------------------------------------------------------------------------

const publicKeyOf = (keyString) => {
  const { keyType, data } = decodeNearPublicKey(keyString);
  return { [NEAR_KEY_DESCRIPTORS[keyType].publicKeyVariant]: { data } };
};

/** Base58 sha256 text as the 32 bytes it stands for; anything else throws. */
export function hashBytes(codeHash) {
  if (typeof codeHash !== "string") throw new Error("UseGlobalContract needs a codeHash (base58 sha256): this tool uses the by-hash form only");
  const bytes = fromBase58(codeHash);
  if (bytes.length !== 32 || toBase58(bytes) !== codeHash) throw new Error(`${JSON.stringify(codeHash)} is not a base58 sha256 (32 bytes)`);
  return bytes;
}

/**
 * Plain-data action descriptors, the same shape mainnet.mjs plans with, plus the two global-contract ones
 * (and, for prodvault / plant-key, { type: "DeployContract", code } and
 * { type: "AddKeyFunctionCall", publicKey, allowanceYocto, receiverId, methods }):
 *   { type: "DeployGlobalContract", code: Uint8Array, mode: "CodeHash" }
 *   { type: "UseGlobalContract", codeHash: "<base58 sha256>" }
 * @returns the borsh value of one Action
 */
export function mapAction(a) {
  switch (a.type) {
    case "CreateAccount":
      return { createAccount: {} };
    case "Transfer":
      return { transfer: { deposit: BigInt(a.yocto) } };
    case "AddKey":
      return { addKey: { publicKey: publicKeyOf(a.publicKey), accessKey: { nonce: 0n, permission: { fullAccess: {} } } } };
    case "DeleteKey":
      return { deleteKey: { publicKey: publicKeyOf(a.publicKey) } };
    case "DeployContract":
      if (!(a.code instanceof Uint8Array) || a.code.length === 0) throw new Error("DeployContract needs the wasm bytes");
      return { deployContract: { code: a.code } };
    case "AddKeyFunctionCall":
      // allowanceYocto null = unlimited (the shape cage-check's ARCH-2.8-3 calls red); plant-key builds it on purpose.
      return { addKey: { publicKey: publicKeyOf(a.publicKey), accessKey: { nonce: 0n, permission: { functionCall: { allowance: a.allowanceYocto === null || a.allowanceYocto === undefined ? null : BigInt(a.allowanceYocto), receiverId: a.receiverId, methodNames: a.methods ?? [] } } } } };
    case "FunctionCall":
      return { functionCall: { methodName: a.method, args: new TextEncoder().encode(JSON.stringify(a.args ?? {})), gas: TGAS(a.gasTgas), deposit: BigInt(a.depositYocto ?? 0) } };
    case "DeployGlobalContract":
      if (a.mode !== "CodeHash") throw new Error(`DeployGlobalContract mode ${JSON.stringify(a.mode)}: this tool publishes by code hash only (immutable)`);
      if (!(a.code instanceof Uint8Array) || a.code.length === 0) throw new Error("DeployGlobalContract needs the wasm bytes");
      return { deployGlobalContract: { code: a.code, deployMode: DEPLOY_MODE_CODE_HASH } };
    case "UseGlobalContract":
      return { useGlobalContract: { contractIdentifier: { codeHash: hashBytes(a.codeHash) } } };
    default:
      throw new Error(`unknown action type ${a.type}`);
  }
}

/**
 * `tx`: { signerId, publicKey, nonce, receiverId, blockHash (base58), actions: descriptors }. The bytes the hash
 * and the signature cover are exactly these.
 */
export function serializeTransaction(tx) {
  const blockHash = fromBase58(tx.blockHash);
  return exp.borsh.serialize(schema().Transaction, {
    signerId: tx.signerId,
    publicKey: publicKeyOf(tx.publicKey),
    nonce: BigInt(tx.nonce),
    receiverId: tx.receiverId,
    blockHash,
    actions: tx.actions.map(mapAction),
  });
}

export function serializeSignedTransaction(tx, signature) {
  const keyType = decodeNearPublicKey(tx.publicKey).keyType;
  const d = NEAR_KEY_DESCRIPTORS[keyType];
  if (signature.length !== d.signatureLength) throw new Error(`a ${keyType} signature is ${d.signatureLength} bytes, got ${signature.length}`);
  return exp.borsh.serialize(schema().SignedTransaction, {
    transaction: {
      signerId: tx.signerId,
      publicKey: publicKeyOf(tx.publicKey),
      nonce: BigInt(tx.nonce),
      receiverId: tx.receiverId,
      blockHash: fromBase58(tx.blockHash),
      actions: tx.actions.map(mapAction),
    },
    signature: { [d.signatureVariant]: { data: signature } },
  });
}

/** Signs `tx` and returns what a node takes: the base64 signed transaction and the transaction hash. */
export async function signTransaction(tx, signer) {
  if (signer.publicKey !== tx.publicKey) throw new Error("the signer's public key is not the transaction's");
  const hash = sha256(serializeTransaction(tx));
  const signature = await signer.signHash(hash);
  return { signedBase64: bytesToBase64(serializeSignedTransaction(tx, signature)), hash: toBase58(hash) };
}

// ---- outcomes ---------------------------------------------------------------------------------------------------

/** Throws if the transaction or any of its receipts failed. `outcome` is the result of the `tx` RPC call. */
export function assertSucceeded(outcome, hash) {
  const failure = outcome?.status?.Failure ?? outcome?.transaction_outcome?.outcome?.status?.Failure ?? (outcome?.receipts_outcome ?? []).map((r) => r.outcome?.status?.Failure).find(Boolean);
  if (failure) throw new Error(`transaction ${hash} failed: ${JSON.stringify(failure)}`);
  if (!outcome?.status) throw new Error(`transaction ${hash} came back without a status`);
  return outcome;
}

// ---- sending ----------------------------------------------------------------------------------------------------

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOT_YET = /UNKNOWN_TRANSACTION|TIMEOUT_ERROR|NOT_ENOUGH_BLOCKS|REQUEST_TIMEOUT/;
const notYet = (e) => NOT_YET.test(`${e?.message ?? ""} ${JSON.stringify(e?.data ?? "")}`);

/**
 * A sender for full-access keys: `send({ signerId, signer, receiverId, actions })` -> `{ hash, outcome }`. It reads the
 * key's nonce and the latest final block, signs, broadcasts, then waits for the FINAL status by hash. The hash is
 * known before the broadcast, so a broadcast that errors or times out is resolved by asking the chain what became of
 * that hash, never by sending again.
 * @param rpc  the client of rpc.mjs (`call`, `finalBlock`, `tx`)
 */
export function makeSender({ rpc, sleep = defaultSleep, pollMs = 1500, polls = 60 }) {
  // "optimistic", not "final": the previous transaction was waited for to FINAL, but the node that answers this may be a block behind it.
  async function nonceOf(signerId, publicKey) {
    const key = await rpc.call("query", { request_type: "view_access_key", finality: "optimistic", account_id: signerId, public_key: publicKey });
    if (key.permission !== "FullAccess") throw new Error(`${publicKey} is not a full-access key of ${signerId}; this tool signs with full-access keys only`);
    return BigInt(key.nonce) + 1n;
  }

  async function settle(hash, signerId) {
    let last;
    for (let i = 0; i < polls; i++) {
      try {
        return await rpc.tx(hash, signerId);
      } catch (e) {
        if (!notYet(e)) throw e;
        last = e;
      }
      await sleep(pollMs);
    }
    throw new Error(`transaction ${hash} was not seen as final after ${polls} tries${last ? `: ${last.message ?? last}` : ""}`);
  }

  return async function send({ signerId, signer, receiverId, actions }) {
    const nonce = await nonceOf(signerId, signer.publicKey);
    const block = await rpc.finalBlock();
    const tx = { signerId, publicKey: signer.publicKey, nonce, receiverId, blockHash: block.hash, actions };
    const { signedBase64, hash } = await signTransaction(tx, signer);
    let sendError;
    try {
      await rpc.call("send_tx", { signed_tx_base64: signedBase64, wait_until: "INCLUDED" });
    } catch (e) {
      sendError = e;
    }
    // A refusal by the node (bad nonce, no balance, malformed) is final: nothing was included, so there is nothing to wait for.
    if (sendError instanceof RpcError && sendError.kind === "RPC") {
      let landed;
      try {
        landed = await rpc.tx(hash, signerId);
      } catch {
        throw sendError;
      }
      return { hash, outcome: assertSucceeded(landed, hash) };
    }
    const outcome = await settle(hash, signerId).catch((e) => {
      throw sendError ? new Error(`${sendError.message ?? sendError}; and the chain has no record of ${hash}: ${e.message ?? e}`) : e;
    });
    return { hash, outcome: assertSucceeded(outcome, hash) };
  };
}

// ---- keys -------------------------------------------------------------------------------------------------------

/**
 * Reads a funder key file, `{ "account_id": "...", "private_key": "ed25519:..." }` (the format of KAIGEN_FUNDER_FILE).
 * Returns `{ accountId, publicKey, signer }`; the private key stays in the signer's closure and is never returned,
 * logged or put in an error (parse errors are replaced, since a JSON error can quote the file).
 */
export function loadFunder(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`cannot read the funder file ${file}: ${e.code ?? "it is not valid JSON"}`);
  }
  if (typeof raw?.account_id !== "string" || typeof raw?.private_key !== "string") throw new Error('the funder file must be JSON with "account_id" and "private_key"');
  let signer;
  try {
    signer = signerFromPrivateKey(raw.private_key);
  } catch {
    throw new Error("the funder file's private_key is not a valid NEAR private key");
  }
  return { accountId: raw.account_id, publicKey: signer.publicKey, signer };
}

/** A fresh classical (ed25519) key: `{ privateKey, publicKey, signer }`. The private key is for the caller to put in a gitignored file, never to print. */
export function newClassicalKey() {
  const privateKey = privateKeyFromRandom();
  return { privateKey, publicKey: publicKeyFromPrivate(privateKey), signer: signerFromPrivateKey(privateKey) };
}

/** `{ vault: hex of the 32-byte ML-DSA-65 seed }`, the format DEMO_ADMIN_SEEDS and the testnet rehearsal use. */
export function readSeeds(file) {
  if (!fs.existsSync(file)) return {};
  try {
    const seeds = JSON.parse(fs.readFileSync(file, "utf8"));
    if (seeds === null || typeof seeds !== "object" || Array.isArray(seeds)) throw new Error("not an object");
    return seeds;
  } catch {
    throw new Error(`the seed file ${file} is not a JSON object of { account: seed hex }; it was not touched`);
  }
}

/**
 * The vault's ML-DSA-65 admin signer. With a seed on file it is that one; without one and `create` it is generated, and
 * its seed is written to `seedFile` BEFORE the signer is returned, so a key that is about to hold an account can never
 * exist only in memory. Returns null when there is no seed and `create` is false.
 */
export function adminSigner({ seedFile, vault, create = false }) {
  const seeds = readSeeds(seedFile);
  if (typeof seeds[vault] === "string") return signerFromSeed(Uint8Array.from(Buffer.from(seeds[vault], "hex")));
  if (!create) return null;
  const signer = generateSigner();
  const seed = signer.exportSeed();
  fs.mkdirSync(path.dirname(seedFile), { recursive: true });
  fs.writeFileSync(seedFile, JSON.stringify({ ...seeds, [vault]: Buffer.from(seed).toString("hex") }, null, 2));
  seed.fill(0);
  return signer;
}
