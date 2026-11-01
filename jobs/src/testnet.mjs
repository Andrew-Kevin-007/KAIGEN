// One-command testnet rehearsal. Anyone can reproduce it for free: it creates throwaway testnet accounts
// from the public faucet, deploys the DRILL builds of both contracts, makes the vault's only full-access
// key a post-quantum (ML-DSA-65) key, then runs the injection demo and the fire test against them.
//
// Everything it creates is testnet, holds no value, and is written with its keys to a folder that is
// gitignored. Drill objects are labelled drill: nothing here implies the production omen broke.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { actions, createFundedTestnetAccount, sendTx } from "@fastnear/api";
import { privateKeyFromRandom, publicKeyFromPrivate, signerFromPrivateKey } from "@fastnear/utils";
import { generateSigner, signerFromSeed } from "@fastnear/ml-dsa-65";
import { drillOmens } from "../../scripts/omens.mjs";
import { adminCaller, adminCanceller, agentCaller, classicalSubmitter, hashOf, makeDrillChain } from "./chain.mjs";
import { renderDemo, runInjectionDemo } from "./demo.mjs";
import { runFireTest } from "./firetest.mjs";
import { makeRpc } from "./rpc.mjs";

export const NETWORK = "testnet";
export const TESTNET_RPC = "https://rpc.testnet.fastnear.com";
const TGAS = (n) => String(BigInt(n) * 10n ** 12n);
const NEAR = 10n ** 24n;

const call = (methodName, args, gasT = 30, deposit = "0") => actions.functionCall({ methodName, args, gas: TGAS(gasT), deposit });
const send = async (signerId, signer, receiverId, acts) => hashOf(await sendTx({ signerId, signer, receiverId, actions: acts, waitUntil: "FINAL", network: NETWORK }));

/** Keys are written the moment an account exists, so a failed run can never strand an account it created. */
function saveKeys(outDir, account) {
  const file = path.join(outDir, "accounts.json");
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  all[account.id] = { privateKey: account.privateKey, publicKey: account.publicKey };
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
}

/** The faucet gives one account about 10 NEAR and allows one request per IP per 12 hours. */
async function faucetAccount(role, outDir, log) {
  const id = `kaigen-${role}-${crypto.randomBytes(3).toString("hex")}.testnet`;
  const privateKey = privateKeyFromRandom();
  const publicKey = publicKeyFromPrivate(privateKey);
  await createFundedTestnetAccount({ newAccountId: id, publicKey });
  const account = { id, privateKey, publicKey, signer: signerFromPrivateKey(privateKey) };
  saveKeys(outDir, account);
  log({ step: "faucet account created", id, role });
  return account;
}

/** A sub-account of the funder, created and funded in one transaction. Needs no faucet. */
async function subAccount(role, funder, milliNear, outDir, log) {
  const id = `${role}.${funder.id}`;
  const privateKey = privateKeyFromRandom();
  const publicKey = publicKeyFromPrivate(privateKey);
  const account = { id, privateKey, publicKey, signer: signerFromPrivateKey(privateKey) };
  saveKeys(outDir, account); // before the transaction: if it succeeds and the run dies, the key is still on disk
  await send(funder.id, funder.signer, id, [actions.createAccount(), actions.transfer(String(BigInt(milliNear) * 10n ** 21n)), actions.addFullAccessKey({ publicKey })]);
  log({ step: "account created", id, role, near: milliNear / 1000 });
  return account;
}

/**
 * Creates and deploys everything, or loads what an earlier run left in `outDir`.
 * `funderFile` points at a JSON with `account_id` and `private_key` of an existing funded testnet account;
 * without it one faucet account is made and the rest are its sub-accounts.
 */
export async function provision({ outDir, wasmDir, funderFile, log = () => {} }) {
  const stateFile = path.join(outDir, "state.json");
  if (fs.existsSync(stateFile)) {
    log({ step: "reusing the testnet setup in", dir: outDir });
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  }
  fs.mkdirSync(outDir, { recursive: true });
  const code = (f) => fs.readFileSync(path.join(wasmDir, f)).toString("base64");

  let funder;
  if (funderFile) {
    const f = JSON.parse(fs.readFileSync(funderFile, "utf8"));
    funder = { id: f.account_id, privateKey: f.private_key, publicKey: publicKeyFromPrivate(f.private_key), signer: signerFromPrivateKey(f.private_key) };
    log({ step: "using the funder", id: funder.id });
  } else {
    funder = await faucetAccount("funder", outDir, log);
  }
  // Sized for storage (about 0.00001 NEAR per byte, so 215 KB and 310 KB of contract code) plus working balance.
  const kz = await subAccount("kizashi", funder, 2600, outDir, log);
  const vault = await subAccount("vault", funder, 3800, outDir, log);
  const keeper = await subAccount("keeper", funder, 600, outDir, log);
  const supplier = await subAccount("supplier", funder, 100, outDir, log);

  const drillSecretsPath = path.join(outDir, "drill-omen-secrets.json");
  const omens = drillOmens(drillSecretsPath);

  // Deploy and initialise in ONE transaction signed by the account itself: nobody can initialise it first.
  const kzDeploy = await send(kz.id, kz.signer, kz.id, [actions.deployContract({ codeBase64: code("kizashi.wasm") }), call("new", { omens, usdc: null })]);
  log({ step: "kizashi deployed and initialised", account: kz.id, tx: kzDeploy });

  const vaultDeploy = await send(vault.id, vault.signer, vault.id, [
    actions.deployContract({ codeBase64: code("mamori.wasm") }),
    call("init", { kizashi: kz.id, daily_limit: String(NEAR), delay_secs: 10 }),
  ]);
  log({ step: "mamori deployed and initialised", account: vault.id, tx: vaultDeploy });

  // The post-quantum key becomes the vault's only full-access key: a classical key enrols it, then the
  // post-quantum key itself deletes the classical one.
  const pq = generateSigner();
  const adminSeedsPath = path.join(outDir, "admin-seeds.json");
  const seedHex = Buffer.from(pq.exportSeed()).toString("hex");
  fs.writeFileSync(adminSeedsPath, JSON.stringify({ [vault.id]: seedHex }, null, 2));
  await send(vault.id, vault.signer, vault.id, [actions.addFullAccessKey({ publicKey: pq.publicKey })]);
  const lock = await send(vault.id, pq, vault.id, [actions.deleteKey({ publicKey: vault.publicKey })]);
  log({ step: "the vault's classical full-access key is deleted; only the ML-DSA-65 key remains", tx: lock });

  // The agent's key and the policy, set by the post-quantum admin in one transaction.
  const dailyPrivate = privateKeyFromRandom();
  const dailyPublic = publicKeyFromPrivate(dailyPrivate);
  const policy = await send(vault.id, pq, vault.id, [
    call("allow_recipient", { account: supplier.id }),
    call("enforce_allowlist", { on: true }),
    call("add_daily_key", { public_key: dailyPublic, allowance: null }),
  ]);
  log({ step: "agent key added, recipient allowlist on", tx: policy });
  pq.destroy();

  const state = {
    network: NETWORK,
    kizashi: kz.id,
    vault: vault.id,
    supplier: supplier.id,
    keeper: { id: keeper.id, privateKey: keeper.privateKey },
    daily: { publicKey: dailyPublic, privateKey: dailyPrivate },
    drillSecretsPath,
    adminSeedsPath,
    omens,
  };
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  return state;
}

/** Runs the injection demo, then one fire test per curve, and writes the fire-test records. */
export async function rehearse({ state, outDir, log = () => {} }) {
  const rpc = makeRpc(TESTNET_RPC);
  const seeds = JSON.parse(fs.readFileSync(state.adminSeedsPath, "utf8"));
  const out = { demo: null, fireTests: [] };
  const submit = classicalSubmitter({ network: NETWORK, account: state.keeper.id, privateKey: state.keeper.privateKey });
  // `execute` is open to anyone, so it is tried from an unrelated account (the keeper), not the agent's key.
  const anyoneCall = async (method, args) => {
    try {
      return { ok: true, hash: await submit({ receiver: state.vault, method, args, gas: TGAS(30) }) };
    } catch (e) {
      return { ok: false, error: String(e.message ?? e) };
    }
  };

  out.demo = await runInjectionDemo({
    vault: state.vault,
    supplier: state.supplier,
    attacker: "kaigen-attacker.testnet",
    rpc,
    agentCall: agentCaller({ network: NETWORK, vault: state.vault, privateKey: state.daily.privateKey }),
    anyoneCall,
    adminCancel: adminCanceller({ network: NETWORK, vault: state.vault, seedHex: seeds[state.vault] }),
    payable: 10n ** 21n, // 0.001 NEAR
    limit: NEAR,
    log,
  });
  log({ step: "demo", ok: out.demo.ok });

  // The demo ends with the vault burning the agent's key, which is the point. Give the vault its agent key
  // back (the admin adds it again) so the fire test below starts from the armed state it requires.
  await adminCaller({ network: NETWORK, vault: state.vault, seedHex: seeds[state.vault] })("add_daily_key", { public_key: state.daily.publicKey, allowance: null });
  log({ step: "the admin re-adds the agent's key for the fire test" });

  const dir = path.join(outDir, "fire-tests");
  fs.mkdirSync(dir, { recursive: true });
  const omenIds = ["drill-ed25519-omen", "drill-secp256k1-omen"];
  for (let i = 0; i < omenIds.length; i++) {
    const seq = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).length + 1;
    const cfg = { kizashi: state.kizashi, vaults: [state.vault], submitter: state.keeper.id, omenId: omenIds[i], seq };
    const chain = makeDrillChain({
      rpc,
      submit,
      network: NETWORK,
      cfg,
      drillSecretsPath: state.drillSecretsPath,
      adminSeedsPath: state.adminSeedsPath,
      dailyKeys: { [state.vault]: state.daily.publicKey },
      omens: state.omens,
    });
    try {
      const rec = await runFireTest({ chain, cfg });
      fs.writeFileSync(path.join(dir, `${String(seq).padStart(4, "0")}.json`), JSON.stringify(rec, null, 2));
      out.fireTests.push({ omen: omenIds[i], ok: true, rec });
      log({ step: "fire test passed", omen: omenIds[i], claim_tx: rec.claim_tx });
    } catch (e) {
      if (e.record) fs.writeFileSync(path.join(dir, `${String(seq).padStart(4, "0")}.failed.json`), JSON.stringify(e.record, null, 2));
      out.fireTests.push({ omen: omenIds[i], ok: false, error: String(e.message ?? e), record: e.record });
      log({ step: "fire test FAILED", omen: omenIds[i], error: String(e.message ?? e) });
    }
  }
  return out;
}

export function renderRehearsal(state, out) {
  const lines = [`testnet kizashi ${state.kizashi}`, `testnet vault   ${state.vault}`, "", renderDemo(out.demo), ""];
  for (const f of out.fireTests) lines.push(`${f.ok ? "PASS" : "FAIL"}  fire test with the ${f.omen}${f.ok ? "" : `  (${f.error})`}`);
  const ok = out.demo.ok && out.fireTests.every((f) => f.ok);
  lines.push("", ok ? "RESULT: the lockdown and every attack defence worked on a real chain." : "RESULT: SOMETHING FAILED. See above; do not claim it works.");
  return { text: lines.join("\n"), ok };
}

/**
 * Deletes the sub-accounts a previous run made and sends their balances back to the funder, so the same
 * funded account can be used again (the public faucet allows one request per IP per 12 hours).
 * The vault is deleted with its post-quantum key: its only full-access key.
 */
export async function recycle({ outDir, log = () => {} }) {
  const state = JSON.parse(fs.readFileSync(path.join(outDir, "state.json"), "utf8"));
  const keys = JSON.parse(fs.readFileSync(path.join(outDir, "accounts.json"), "utf8"));
  const seeds = JSON.parse(fs.readFileSync(state.adminSeedsPath, "utf8"));
  const funder = state.vault.slice(state.vault.indexOf(".") + 1);
  const del = (id, signer) => send(id, signer, id, [actions.deleteAccount({ beneficiaryId: funder })]);

  for (const id of [state.kizashi, state.keeper.id, state.supplier]) {
    await del(id, signerFromPrivateKey(keys[id].privateKey));
    log({ step: "account deleted, balance returned", id, to: funder });
  }
  const pq = signerFromSeed(Uint8Array.from(Buffer.from(seeds[state.vault], "hex")));
  try {
    await del(state.vault, pq);
    log({ step: "account deleted with its ML-DSA-65 key, balance returned", id: state.vault, to: funder });
  } finally {
    pq.destroy();
  }
  fs.renameSync(path.join(outDir, "state.json"), path.join(outDir, "state.recycled.json"));
}
