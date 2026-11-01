// On-chain adapters: the only place that signs and sends. Everything else in this package is
// read-only or takes these as injected functions.
//
// NOT YET RUN AGAINST A CHAIN. The FastNEAR calls follow its documented recipes, but this file has
// only been syntax-checked until a funded account exists (gates G1 to G4).
import fs from "node:fs";
import { actions, sendTx } from "@fastnear/api";
import { publicKeyFromPrivate, signerFromPrivateKey } from "@fastnear/utils";
import { signerFromSeed } from "@fastnear/ml-dsa-65";
import { signClaim, toBase64 } from "../../scripts/claim.mjs";

const TGAS = (n) => String(BigInt(n) * 10n ** 12n);
const ZERO = "0";

/**
 * The transaction hash of a `sendTx` result, or a thrown error if the transaction failed. `sendTx` returns the
 * raw JSON-RPC envelope (`{ result: { transaction, status, ... } }`), which a real testnet run showed; the
 * unwrapped shape is accepted too.
 */
export function hashOf(r) {
  if (r?.error) throw new Error(`rpc error: ${typeof r.error === "string" ? r.error : JSON.stringify(r.error.data ?? r.error.message ?? r.error)}`);
  const t = r?.result ?? r;
  const failure = t?.status?.Failure ?? t?.transaction_outcome?.outcome?.status?.Failure;
  if (failure) throw new Error(`transaction failed: ${JSON.stringify(failure)}`);
  const hash = t?.transaction?.hash ?? t?.transaction_outcome?.id;
  if (!hash) throw new Error("sendTx returned no transaction hash");
  return hash;
}

/** The JSON a contract method returned, from a `sendTx` result, or null when it returned nothing. */
export function valueOf(r) {
  const b64 = (r?.result ?? r)?.status?.SuccessValue;
  if (!b64) return null;
  try {
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/** A submitter that signs with a classical key. Used for claim, trip and reset, which anyone may call. */
export function classicalSubmitter({ network = "mainnet", account, privateKey }) {
  const signer = signerFromPrivateKey(privateKey);
  return async ({ receiver, method, args = {}, gas = TGAS(100), deposit = ZERO }) =>
    hashOf(
      await sendTx({
        signerId: account,
        signer,
        receiverId: receiver,
        actions: [actions.functionCall({ methodName: method, args, gas, deposit })],
        waitUntil: "FINAL",
        network,
      }),
    );
}

/**
 * The action descriptors `mainnet.mjs` plans with ({ type, ... }, plain data) as FastNEAR actions. Kept here so the
 * planner never imports the signing library: this file is the only place that can send.
 */
export function toActions(list) {
  return list.map((a) => {
    switch (a.type) {
      case "CreateAccount":
        return actions.createAccount();
      case "Transfer":
        return actions.transfer(String(a.yocto));
      case "AddKey":
        return actions.addFullAccessKey({ publicKey: a.publicKey });
      case "DeleteKey":
        return actions.deleteKey({ publicKey: a.publicKey });
      case "DeployContract":
        return actions.deployContract({ codeBase64: a.codeBase64 });
      case "FunctionCall":
        return actions.functionCall({ methodName: a.method, args: a.args ?? {}, gas: TGAS(a.gasTgas), deposit: String(a.depositYocto ?? 0) });
      default:
        throw new Error(`unknown action type ${a.type}`);
    }
  });
}

/**
 * Reads a deployer key file, `{ "account_id": "...", "private_key": "ed25519:..." }`, and returns
 * `{ accountId, publicKey, send }`. The private key stays inside `send`'s closure: it is never returned, logged or
 * put in an error message (a JSON parse error would quote the file, so parse errors are replaced, not passed on).
 */
export function loadDeployerKey(file, { network = "mainnet" } = {}) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`cannot read the key file ${file}: ${e.code ?? "it is not valid JSON"}`);
  }
  if (typeof raw?.account_id !== "string" || typeof raw?.private_key !== "string") throw new Error('the key file must be JSON with "account_id" and "private_key"');
  let publicKey;
  let signer;
  try {
    publicKey = publicKeyFromPrivate(raw.private_key);
    signer = signerFromPrivateKey(raw.private_key);
  } catch {
    throw new Error("the key file's private_key is not a valid NEAR private key");
  }
  const send = async ({ signerId, receiverId, actions: list }) =>
    hashOf(await sendTx({ signerId, signer, receiverId, actions: toActions(list), waitUntil: "FINAL", network }));
  return { accountId: raw.account_id, publicKey, send };
}

/** The keeper's `sendTrip`: `trip()` reserves 200 Tgas for its callback, so the transaction carries 250. */
export const makeSendTrip = (submit) => (vault) => submit({ receiver: vault, method: "trip", gas: TGAS(250) });

/** Chain interface for `runFireTest`, backed by real transactions and views. */
export function makeDrillChain({ rpc, submit, network = "mainnet", cfg, drillSecretsPath, adminSeedsPath, dailyKeys: dailyKeyByVault, omens }) {
  const secrets = JSON.parse(fs.readFileSync(drillSecretsPath, "utf8"));
  const seeds = JSON.parse(fs.readFileSync(adminSeedsPath, "utf8")); // { vault: hex of the 32-byte ML-DSA seed }

  const adminSend = async (vault, acts) => {
    const signer = signerFromSeed(Uint8Array.from(Buffer.from(seeds[vault], "hex")));
    try {
      return hashOf(await sendTx({ signerId: vault, signer, receiverId: vault, actions: acts, waitUntil: "FINAL", network }));
    } finally {
      signer.destroy();
    }
  };

  return {
    era: (kizashi) => rpc.view(kizashi, "era"),
    vaultEra: (v) => rpc.view(v, "era"),
    dailyKeys: (v) => rpc.view(v, "daily_keys"),
    accessKeys: (v) => rpc.accessKeys(v),
    blockHeight: async () => (await rpc.status()).sync_info.latest_block_height,

    claim: async (omenId) => {
      const omen = omens.find((o) => o.id === omenId);
      if (!omen) throw new Error(`unknown drill omen ${omenId}`);
      const signature = signClaim({ curve: omen.curve, secretHex: secrets[omenId], kizashi: cfg.kizashi, omenId, claimant: cfg.submitter });
      return submit({ receiver: cfg.kizashi, method: "claim", args: { omen_id: omenId, claimant: cfg.submitter, signature: toBase64(signature) }, gas: TGAS(100) });
    },
    trip: makeSendTrip(submit),
    // Proves the post-quantum admin key still controls the account after the classical keys are gone.
    pqSend: (v) => adminSend(v, [actions.transfer("1")]),
    reset: () => submit({ receiver: cfg.kizashi, method: "reset", gas: TGAS(30) }),
    // After Kizashi's reset a drill vault follows it back to calm on its next trip, then gets its daily key again.
    rearm: async (v) => {
      await makeSendTrip(submit)(v);
      return adminSend(v, [actions.functionCall({ methodName: "add_daily_key", args: { public_key: dailyKeyByVault[v], allowance: null }, gas: TGAS(30), deposit: ZERO })]);
    },
  };
}

/**
 * The agent's side: calls the vault with its classical daily key. A refusal comes back as `{ ok: false, error }`,
 * because for the injection demo a refusal is the expected outcome, not a crash.
 */
export function agentCaller({ network = "mainnet", vault, privateKey }) {
  const signer = signerFromPrivateKey(privateKey);
  return async (method, args = {}) => {
    try {
      const r = await sendTx({
        signerId: vault,
        signer,
        receiverId: vault,
        actions: [actions.functionCall({ methodName: method, args, gas: TGAS(100), deposit: ZERO })],
        waitUntil: "FINAL",
        network,
      });
      // `send_small` reports a refused attack as a normal result ({ sent: false, refused, strikes, burned }).
      return { ok: true, hash: hashOf(r), outcome: valueOf(r) };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  };
}

/** The human admin's side: any vault method, signed with the post-quantum admin key. Returns the tx hash. */
export function adminCaller({ network = "mainnet", vault, seedHex }) {
  return async (method, args = {}, gasT = 30) => {
    const signer = signerFromSeed(Uint8Array.from(Buffer.from(seedHex, "hex")));
    try {
      return hashOf(
        await sendTx({
          signerId: vault,
          signer,
          receiverId: vault,
          actions: [actions.functionCall({ methodName: method, args, gas: TGAS(gasT), deposit: ZERO })],
          waitUntil: "FINAL",
          network,
        }),
      );
    } finally {
      signer.destroy();
    }
  };
}

/** The admin cancelling a queued withdrawal. */
export function adminCanceller(opts) {
  const call = adminCaller(opts);
  return async (id) => {
    await call("cancel", { id });
  };
}
