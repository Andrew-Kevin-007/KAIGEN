// M6: publish Mamori as a NEAR global contract BY CODE HASH, then attach a vault to it (docs/v3/GLOBAL-CONTRACT.md).
//
//   1 publish  the funder signs DeployGlobalContract (mode CodeHash: immutable, referenced by hash, never by account)
//   2 create   the funder creates the vault sub-account with the vault's ML-DSA-65 admin key as its ONLY key
//   3 attach   the vault signs, with that ML-DSA key, ONE transaction: UseGlobalContract(hash) + init(...) in the same
//              transaction, so nobody can initialise the instance first. `init` is `#[init] #[private]`: it needs
//              predecessor == the vault itself, which only a transaction signed by the vault's own key gives
//   4 verify   RPC: the vault's global_contract_hash equals the published hash, the published code on chain hashes
//              to it, the views answer, and cage-check (cage.mjs) runs
//
// DRY RUN BY DEFAULT: without `yes` this reads the chain (status, protocol config, accounts, global code by hash)
// and prints the plan. Nothing here signs: the sender, the funder and the admin signer are handed in per call
// (bin.mjs builds them from globaltx.mjs), so a test drives the whole path with fake chain objects. Testnet only:
// a node that says it is mainnet is refused whatever the flags.
//
// Cost. The burn is estimated from nearcore's runtime config (0.0001 NEAR per byte of published code, the same
// as the docs' "10 NEAR per 100 KB"). That is an estimate. The figure that counts is MEASURED in step 1 from the
// funder's balance before and after, and printed after the run.
import fs from "node:fs";
import path from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { cageCheck, DEFAULT_MAX_ALLOWANCE_YOCTO, exitCodeOf, normalizeCodeHash, renderCage } from "./cage.mjs";
import { report } from "./verify.mjs";

export const TESTNET_RPC = "https://rpc.testnet.fastnear.com";
const NEAR = 10n ** 24n;
/** NEAR's storage price for an account's own state: 1e19 yoctoNEAR per byte. */
const STORAGE_YOCTO_PER_BYTE = 10n ** 19n;
/** nearcore near-parameters 77.yaml: `global_contract_storage_amount_per_byte` 0.0001 NEAR, burnt. 100 KB x this = the docs' 10 NEAR. */
export const GLOBAL_YOCTO_PER_BYTE = 10n ** 20n;
/** The protocol where nearcore turns global contracts on (near-parameters 77.yaml). */
export const MIN_PROTOCOL_GLOBAL = 77;
/** The protocol @fastnear/api requires for ML-DSA-65 keys (`ensureProtocol85`). */
export const MIN_PROTOCOL_MLDSA = 85;
export const INIT_GAS_TGAS = 30;
/** MIN_DELAY_SECS of contracts/mamori/src/lib.rs: a production `init` refuses less. */
export const MIN_DELAY_SECS = 86_400;
const DEFAULT_MARGIN = NEAR / 2n;
const EMPTY_CODE_HASH = "11111111111111111111111111111111";
const MAMORI_EXPORTS = ["init", "send_small", "request_withdraw", "execute", "config"];

export class GlobalUsage extends Error {}
export class Refused extends Error {
  constructor(message) {
    super(message);
    this.name = "Refused";
  }
}

const message = (e) => String(e?.message ?? e);
const sleepFor = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- amounts and names ------------------------------------------------------------------------------------------

/** "0.25" NEAR as yocto; anything else throws GlobalUsage. */
export function parseNear(text, flag) {
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(text ?? "");
  if (!m) throw new GlobalUsage(`${flag} ${JSON.stringify(text)} is not an amount in NEAR such as 1 or 0.25`);
  return BigInt(m[1]) * NEAR + BigInt((m[2] ?? "").padEnd(24, "0") || "0");
}

export function formatNear(yocto, decimals = 4) {
  const v = BigInt(yocto);
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const scaled = (abs + 5n * 10n ** BigInt(23 - decimals)) / 10n ** BigInt(24 - decimals);
  const whole = scaled / 10n ** BigInt(decimals);
  const frac = String(scaled % 10n ** BigInt(decimals)).padStart(decimals, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const isAccountId = (id) => typeof id === "string" && id.length >= 2 && id.length <= 64 && ACCOUNT_ID.test(id);

/** The wasm's sha256 as the chain spells a code hash (base58) and as `sha256sum` prints it (hex). */
export function describeWasm(wasm, wasmPath = "<given bytes>") {
  const digest = sha256(wasm);
  return { path: wasmPath, bytes: wasm.length, sha256Hex: Buffer.from(digest).toString("hex"), codeHash: base58.encode(digest) };
}

export const estimateBurnYocto = (bytes) => BigInt(bytes) * GLOBAL_YOCTO_PER_BYTE;

/** Throws Refused unless `wasm` is a wasm module with Mamori's entry points: 37 NEAR must not be burnt on the wrong file. */
export function assertMamori(wasm) {
  const names = new Set(WebAssembly.Module.exports(assertWasm(wasm)).map((e) => e.name));
  const missing = MAMORI_EXPORTS.filter((n) => !names.has(n));
  if (missing.length > 0) throw new Refused(`this is not Mamori: the wasm has no ${missing.join(", ")} export`);
  return { attest: names.has("attest") };
}

// ---- the plan ---------------------------------------------------------------------------------------------------

/** The deterministic default vault: `gv-<first 8 hex of the wasm sha256>.<funder>`. */
export const defaultVaultId = (sha256Hex, funderId) => `gv-${sha256Hex.slice(0, 8)}.${funderId ?? "<funder>"}`;

/**
 * Everything the run would send, as plain data (the action descriptors of globaltx.mjs). Pure: no chain, no keys.
 * `funderId` may be null in a dry run without a funder file; the vault id then carries a placeholder.
 */
export function planGlobalContract({ wasm, wasmPath, funderId = null, vault, kizashi, dailyLimitYocto, delaySecs, vaultYocto, adminPublicKey = "<ML-DSA-65 public key, generated when run with --yes>" }) {
  const shape = assertMamori(wasm);
  const w = describeWasm(wasm, wasmPath);
  const vaultId = vault ?? defaultVaultId(w.sha256Hex, funderId);
  if (funderId !== null && !isAccountId(funderId)) throw new GlobalUsage(`funder ${JSON.stringify(funderId)} is not a NEAR account id`);
  if (funderId !== null && !(vaultId.endsWith(`.${funderId}`) && isAccountId(vaultId))) throw new GlobalUsage(`the vault ${JSON.stringify(vaultId)} must be a sub-account of the funder: <name>.${funderId}`);
  if (!isAccountId(kizashi)) throw new GlobalUsage(`--kizashi ${JSON.stringify(kizashi)} is not a NEAR account id`);
  if (!Number.isSafeInteger(delaySecs) || delaySecs < 0) throw new GlobalUsage("--delay-secs must be a whole number of seconds");
  const burn = estimateBurnYocto(w.bytes);
  const needed = burn + vaultYocto + DEFAULT_MARGIN;
  const init = { kizashi, daily_limit: dailyLimitYocto.toString(), delay_secs: delaySecs };
  return {
    wasm: w,
    hasAttest: shape.attest,
    funder: funderId,
    vault: vaultId,
    init,
    estimate: { burnYocto: burn, vaultYocto, marginYocto: DEFAULT_MARGIN, neededYocto: needed },
    steps: [
      { id: "publish", title: "publish the wasm as a global contract by code hash (immutable)", signer: funderId, receiver: funderId, actions: [{ type: "DeployGlobalContract", code: wasm, mode: "CodeHash" }] },
      {
        id: "create",
        title: "create the vault with the ML-DSA-65 admin key as its only key",
        signer: funderId,
        receiver: vaultId,
        actions: [{ type: "CreateAccount" }, { type: "Transfer", yocto: vaultYocto }, { type: "AddKey", publicKey: adminPublicKey }],
      },
      {
        id: "attach",
        title: "the vault uses the global contract by hash and runs init in the same transaction",
        signer: `${vaultId} (its ML-DSA-65 admin key)`,
        receiver: vaultId,
        actions: [{ type: "UseGlobalContract", codeHash: w.codeHash }, { type: "FunctionCall", method: "init", args: init, gasTgas: INIT_GAS_TGAS, depositYocto: 0 }],
      },
    ],
  };
}

/** The default account of a publish-only run: `gp-<first 8 hex of the wasm sha256>.<funder>`. */
export const defaultPublishAccountId = (sha256Hex, funderId) => `gp-${sha256Hex.slice(0, 8)}.${funderId ?? "<funder>"}`;

/** Throws Refused unless `wasm` is a wasm module the engine compiles; returns the compiled module. */
export function assertWasm(wasm) {
  if (!(wasm.length > 8 && wasm[0] === 0 && wasm[1] === 0x61 && wasm[2] === 0x73 && wasm[3] === 0x6d)) throw new Refused("the file is not a wasm module (no \\0asm header)");
  try {
    return new WebAssembly.Module(wasm);
  } catch (e) {
    throw new Refused(`the file does not compile as wasm: ${message(e)}`);
  }
}

/**
 * Publish-only plan (`globalcontract publish`): publish ANY valid wasm by code hash, create a sub-account of the funder with an
 * ML-DSA-65 key, attach it by hash with NO init. Same shape as `planGlobalContract` with `init: null`, so the runner, the
 * preflight and the output are the same code. Pure: no chain, no keys.
 */
export function planPublishOnly({ wasm, wasmPath, funderId = null, account, accountYocto, adminPublicKey = "<ML-DSA-65 public key, generated when run with --yes>" }) {
  assertWasm(wasm);
  const w = describeWasm(wasm, wasmPath);
  const accountId = account ?? defaultPublishAccountId(w.sha256Hex, funderId);
  if (funderId !== null && !isAccountId(funderId)) throw new GlobalUsage(`funder ${JSON.stringify(funderId)} is not a NEAR account id`);
  if (funderId !== null && !(accountId.endsWith(`.${funderId}`) && isAccountId(accountId))) throw new GlobalUsage(`the account ${JSON.stringify(accountId)} must be a sub-account of the funder: <name>.${funderId}`);
  const burn = estimateBurnYocto(w.bytes);
  return {
    wasm: w,
    hasAttest: true,
    funder: funderId,
    vault: accountId,
    init: null,
    estimate: { burnYocto: burn, vaultYocto: accountYocto, marginYocto: DEFAULT_MARGIN, neededYocto: burn + accountYocto + DEFAULT_MARGIN },
    steps: [
      { id: "publish", title: "publish the wasm as a global contract by code hash (immutable)", signer: funderId, receiver: funderId, actions: [{ type: "DeployGlobalContract", code: wasm, mode: "CodeHash" }] },
      { id: "create", title: "create a sub-account with a new ML-DSA-65 key as its only key", signer: funderId, receiver: accountId, actions: [{ type: "CreateAccount" }, { type: "Transfer", yocto: accountYocto }, { type: "AddKey", publicKey: adminPublicKey }] },
      { id: "attach", title: "the account uses the global contract by hash (no init)", signer: `${accountId} (its ML-DSA-65 key)`, receiver: accountId, actions: [{ type: "UseGlobalContract", codeHash: w.codeHash }] },
    ],
  };
}

// ---- reads ------------------------------------------------------------------------------------------------------

/** The global code published under `codeHash`: `{ present: true, hash, bytes }`, `{ present: false }` when the node has none, or throws. */
export async function readGlobalCode(rpc, codeHash) {
  try {
    const r = await rpc.call("query", { request_type: "view_global_contract_code", finality: "final", code_hash: codeHash });
    const code = Buffer.from(r.code_base64, "base64");
    return { present: true, hash: base58.encode(sha256(code)), reportedHash: r.hash, bytes: code.length };
  } catch (e) {
    if (e?.data?.cause?.name === "NO_GLOBAL_CONTRACT_CODE" || /NO_GLOBAL_CONTRACT_CODE/.test(message(e))) return { present: false };
    throw e;
  }
}

/**
 * What an execution outcome burnt, split into GAS and the rest. `tokens_burnt` is NOT gas alone: for DeployGlobalContract the
 * runtime also puts the storage charge into the receipt's `tokens_burnt` (a real testnet publish of 1,024 bytes on
 * 2026-11-04: receipt tokens_burnt 102436450525000000000000 = 364505250000 gas x 1e8 + exactly 1024 x 1e20). So the gas is taken
 * from the gas UNITS: gas_burnt x the gas price. The price is the transaction outcome's own (its tokens_burnt / gas_burnt, which
 * must divide exactly); the receipts that burnt tokens were bought at that same price; a refund receipt burns 0 tokens (its
 * gas_price is 0) and is not counted. Whatever tokens_burnt holds beyond that gas is the deploy (storage) charge.
 * `splittable` is false when the outcome does not carry what this needs; nothing is then guessed.
 */
export function splitOutcome(outcome) {
  const big = (x) => BigInt(x ?? 0);
  const txo = outcome?.transaction_outcome?.outcome;
  const receipts = (outcome?.receipts_outcome ?? []).map((r) => r.outcome ?? {});
  const txTokens = big(txo?.tokens_burnt);
  const tokensBurnt = txTokens + receipts.reduce((acc, o) => acc + big(o.tokens_burnt), 0n);
  const unsplit = { splittable: false, tokensBurntYocto: tokensBurnt };
  const txGas = big(txo?.gas_burnt);
  if (!txo || txGas === 0n || txTokens === 0n || txTokens % txGas !== 0n) return unsplit;
  const price = txTokens / txGas;
  const paying = receipts.filter((o) => big(o.tokens_burnt) > 0n);
  if (paying.some((o) => o.gas_burnt === undefined || o.gas_burnt === null)) return unsplit;
  const gasUnits = txGas + paying.reduce((acc, o) => acc + big(o.gas_burnt), 0n);
  const gasCost = gasUnits * price;
  if (gasCost > tokensBurnt) return unsplit;
  return { splittable: true, gasPriceYocto: price, gasUnits, gasCostYocto: gasCost, deployChargeYocto: tokensBurnt - gasCost, tokensBurntYocto: tokensBurnt };
}

/** The gas cost of a transaction: the split when the outcome allows it, else everything it burnt (right for create and attach, which have no deploy charge). */
export function gasCostOf(outcome) {
  const split = splitOutcome(outcome);
  return split.splittable ? split.gasCostYocto : split.tokensBurntYocto;
}

/**
 * The measurement of one publish: bytes, the funder's balance before and after when known, what the outcome burnt, the
 * gas / deploy-charge split of it, and the deploy charge per byte. No per-byte figure is produced unless the split is sound,
 * and never a 0 where the balance shows that something was paid: a contradiction is a warning, not a free price.
 */
export function measureFromOutcome({ outcome, bytes, before = null, after = null }) {
  const split = splitOutcome(outcome);
  const fell = before !== null && after !== null ? before - after : null;
  const m = {
    bytes: Number(bytes),
    funderBalanceBeforeYocto: before === null ? null : before.toString(),
    funderBalanceAfterYocto: after === null ? null : after.toString(),
    fellByYocto: fell === null ? null : fell.toString(),
    tokensBurntYocto: split.tokensBurntYocto.toString(),
    unexplainedYocto: fell === null ? null : (fell - split.tokensBurntYocto).toString(),
    gasPriceYocto: null,
    gasUnits: null,
    gasBurntYocto: null,
    storageBurnYocto: null,
    yoctoPerByte: null,
    yoctoPerByteRemainder: null,
    warnings: [],
    estimatedBurnYocto: estimateBurnYocto(bytes).toString(),
    note: "MEASURED from the publish transaction's own outcome: gas = gas_burnt x the gas price, deploy (storage) charge = tokens_burnt - gas. The balance before and after is shown beside it as a cross-check.",
  };
  if (!split.splittable) {
    m.warnings.push("the outcome does not carry a usable gas_burnt, so gas and the deploy charge cannot be told apart: no per-byte figure is given");
    return m;
  }
  m.gasPriceYocto = split.gasPriceYocto.toString();
  m.gasUnits = split.gasUnits.toString();
  m.gasBurntYocto = split.gasCostYocto.toString();
  m.storageBurnYocto = split.deployChargeYocto.toString();
  if (split.deployChargeYocto === 0n && fell !== null && fell - split.gasCostYocto > 0n) {
    m.warnings.push(`the balance fell by ${fell - split.gasCostYocto} yoctoNEAR more than the gas, yet the outcome shows no deploy charge: no per-byte figure is given (0 would be wrong)`);
    return m;
  }
  const n = BigInt(bytes);
  if (n > 0n) {
    m.yoctoPerByte = (split.deployChargeYocto / n).toString();
    m.yoctoPerByteRemainder = (split.deployChargeYocto % n).toString();
  }
  if (fell !== null && fell !== split.tokensBurntYocto) m.warnings.push(`the balance fell by ${formatNear(fell, 9)} NEAR but the outcome burnt ${formatNear(split.tokensBurntYocto, 9)} NEAR: something else moved the funder's balance, so trust the outcome's split, not the balance`);
  return m;
}

/** The MEASURED block, as lines. */
export function renderMeasured(m, otherGas = {}) {
  const lines = [`MEASURED publishing cost for ${m.bytes} bytes of code:`];
  if (m.fellByYocto !== null) lines.push(`  funder balance before ${formatNear(m.funderBalanceBeforeYocto, 6)} NEAR, after ${formatNear(m.funderBalanceAfterYocto, 6)} NEAR, fell by ${formatNear(m.fellByYocto, 6)} NEAR`);
  lines.push(`  the outcome burnt ${formatNear(m.tokensBurntYocto, 6)} NEAR in all (tokens_burnt, which includes the storage charge)`);
  if (m.gasBurntYocto !== null) lines.push(`  of which gas ${formatNear(m.gasBurntYocto, 9)} NEAR (${m.gasUnits} gas units x ${m.gasPriceYocto} yoctoNEAR) and the deploy charge ${formatNear(m.storageBurnYocto, 6)} NEAR`);
  if (m.yoctoPerByte !== null) {
    const rest = BigInt(m.yoctoPerByteRemainder) === 0n ? "exactly" : `and ${m.yoctoPerByteRemainder}/${m.bytes} of a yoctoNEAR`;
    lines.push(`  deploy charge / bytes = ${m.yoctoPerByte} yoctoNEAR per byte ${rest} (the estimate is ${GLOBAL_YOCTO_PER_BYTE} per byte, ${formatNear(m.estimatedBurnYocto, 6)} NEAR for this code)`);
  } else lines.push("  NO per-byte figure (see the warning)");
  const others = Object.entries(otherGas).map(([k, v]) => `${k} ${formatNear(v, 9)}`);
  if (others.length) lines.push(`  gas of the other transactions: ${others.join(", ")} NEAR`);
  m.warnings.forEach((w) => lines.push(`  WARNING: ${w}`));
  return lines;
}

/**
 * Read-only: the measurement of a publish that already happened, from `EXPERIMENTAL_tx_status` on its transaction. The
 * transaction view carries the code HASH, not the code, so the byte count comes from the code the node holds under that hash
 * (or from `bytes`, if given).
 */
export async function measurePublishTx({ rpc, txHash, signerId, bytes }) {
  const outcome = await rpc.call("EXPERIMENTAL_tx_status", { tx_hash: txHash, sender_account_id: signerId, wait_until: "FINAL" });
  const deploy = outcome?.transaction?.actions?.find((a) => a.DeployGlobalContract)?.DeployGlobalContract;
  if (!deploy) throw new Refused(`${txHash} is not a DeployGlobalContract transaction of ${signerId}`);
  if (outcome.status?.Failure) throw new Refused(`${txHash} failed on chain: ${JSON.stringify(outcome.status.Failure)}`);
  const codeHash = base58.encode(Buffer.from(deploy.code, "base64"));
  let n = bytes;
  if (n === undefined) {
    const code = await readGlobalCode(rpc, codeHash);
    if (!code.present) throw new Refused(`the node has no code under ${codeHash}; give --bytes`);
    n = code.bytes;
  }
  return { codeHash, measured: measureFromOutcome({ outcome, bytes: n }) };
}

export const availableYocto = (acc) => BigInt(acc.amount) - BigInt(acc.storage_usage) * STORAGE_YOCTO_PER_BYTE - BigInt(acc.locked ?? 0);
const result = (name, ok, detail, extra = {}) => ({ name, ok, detail, ...extra });
const guarded = async (name, fn) => {
  try {
    return await fn();
  } catch (e) {
    return result(name, false, `could not check: ${message(e)}`);
  }
};

/** Read-only: what the run depends on, and where an earlier run stopped. Never throws for a read that fails: that is a failed check. */
export async function preflight({ rpc, plan, funderKey = null, expectedChain = "testnet" }) {
  const checks = [];
  const facts = { published: "unknown", vaultAccount: null, vaultKeys: null, funderAvailable: null };
  let status;
  checks.push(
    await guarded("chain is the one asked for, and is not mainnet", async () => {
      status = await rpc.status();
      const id = status.chain_id;
      if (id === "mainnet" || expectedChain === "mainnet") return result("chain is the one asked for, and is not mainnet", false, `chain_id ${id}: this tool is testnet only`);
      return result("chain is the one asked for, and is not mainnet", id === expectedChain, `chain_id ${id}, asked for ${expectedChain}`);
    }),
  );
  checks.push(
    await guarded("protocol supports global contracts and ML-DSA-65 keys", async () => {
      const v = status?.protocol_version;
      const ok = Number.isInteger(v) && v >= MIN_PROTOCOL_MLDSA && v >= MIN_PROTOCOL_GLOBAL;
      return result("protocol supports global contracts and ML-DSA-65 keys", ok, `protocol ${v}; global contracts from ${MIN_PROTOCOL_GLOBAL}, ML-DSA-65 from ${MIN_PROTOCOL_MLDSA}`);
    }),
  );
  checks.push(
    await guarded("node reports global-contract host functions", async () => {
      const cfg = await rpc.call("EXPERIMENTAL_protocol_config", { finality: "final" });
      const on = cfg?.runtime_config?.wasm_config?.global_contract_host_fns;
      return result("node reports global-contract host functions", on !== false, `runtime_config.wasm_config.global_contract_host_fns ${on === undefined ? "not reported" : on}`);
    }),
  );
  checks.push(
    await guarded("published already? (read by code hash)", async () => {
      const code = await readGlobalCode(rpc, plan.wasm.codeHash);
      facts.published = code.present ? (code.hash === plan.wasm.codeHash ? "yes" : "mismatch") : "no";
      const detail = code.present ? `yes, ${code.bytes} bytes hashing to ${code.hash}: step 1 would be skipped (no second burn)` : "no: step 1 would publish it";
      return result("published already? (read by code hash)", facts.published !== "mismatch", detail);
    }),
  );
  if (plan.funder === null || funderKey === null) {
    checks.push(result("funder balance and key", true, "no funder file given, so the balance and the key were not checked (give --funder-file)", { skipped: true }));
  } else {
    checks.push(
      await guarded("funder balance covers the burn, the vault and a margin", async () => {
        const acc = await rpc.account(plan.funder);
        if (!acc) return result("funder balance covers the burn, the vault and a margin", false, `${plan.funder} does not exist`);
        facts.funderAvailable = availableYocto(acc);
        const need = plan.estimate.neededYocto;
        return result("funder balance covers the burn, the vault and a margin", facts.funderAvailable >= need, `available ${formatNear(facts.funderAvailable)} NEAR, needs about ${formatNear(need)} NEAR (estimated burn ${formatNear(plan.estimate.burnYocto)} + vault ${formatNear(plan.estimate.vaultYocto)} + margin ${formatNear(plan.estimate.marginYocto)}); a published code is not charged again`);
      }),
    );
    checks.push(
      await guarded("funder file's key is a full-access key of the funder", async () => {
        const keys = await rpc.accessKeys(plan.funder);
        const mine = (keys ?? []).find((k) => k.public_key === funderKey);
        return result("funder file's key is a full-access key of the funder", mine?.access_key?.permission === "FullAccess", mine ? `${funderKey} (${mine.access_key.permission === "FullAccess" ? "full access" : "function call"})` : `${funderKey} is not on ${plan.funder}`);
      }),
    );
  }
  if (!isAccountId(plan.vault)) {
    checks.push(result("vault account", true, `${plan.vault} is a placeholder until a funder file names the funder`, { skipped: true }));
  } else checks.push(
    await guarded("vault account", async () => {
      facts.vaultAccount = await rpc.account(plan.vault);
      facts.vaultKeys = facts.vaultAccount ? await rpc.accessKeys(plan.vault) : null;
      const acc = facts.vaultAccount;
      if (!acc) return result("vault account", true, `${plan.vault} does not exist yet: step 2 creates it`);
      const attached = acc.global_contract_hash === plan.wasm.codeHash;
      return result("vault account", true, `${plan.vault} exists (${attached ? "already attached to this hash: step 3 would be skipped" : acc.global_contract_hash ? `attached to ANOTHER hash ${acc.global_contract_hash}` : acc.code_hash !== EMPTY_CODE_HASH ? "has local code" : "no contract yet"}); the run resumes only if its admin seed is on file`);
    }),
  );
  if (plan.init && plan.init.delay_secs < MIN_DELAY_SECS) {
    checks.push(result("delay is at the production floor", true, `delay_secs ${plan.init.delay_secs} is under ${MIN_DELAY_SECS}: a production build's init panics (the attach transaction fails whole); only a drill build accepts it`));
  }
  const ok = checks.every((c) => c.ok);
  return { checks, facts, ok };
}

// ---- verification -----------------------------------------------------------------------------------------------

/**
 * Step 4, also usable alone on an existing vault. Reads only. `init` (optional) is compared with the vault's
 * `config()`; `adminHandle` (optional, `ml-dsa-65-hash:...`) becomes cage-check's admin.
 */
export async function verifyVault({ rpc, vault, codeHash, init = null, adminHandle = undefined }) {
  const checks = await hashAttachedChecks({ rpc, vault, codeHash });
  checks.push(
    await guarded("views answer (config)", async () => {
      const cfg = await rpc.view(vault, "config");
      const wrong = [];
      if (init && cfg.kizashi !== init.kizashi) wrong.push(`kizashi ${cfg.kizashi}`);
      if (init && Number(cfg.delay_secs) !== init.delay_secs) wrong.push(`delay_secs ${cfg.delay_secs}`);
      if (init && String(cfg.daily_limit) !== init.daily_limit) wrong.push(`daily_limit ${cfg.daily_limit}`);
      return result("views answer (config)", wrong.length === 0, wrong.length ? `differs from init: ${wrong.join(", ")}` : `kizashi ${cfg.kizashi}, delay_secs ${cfg.delay_secs}, daily_limit ${cfg.daily_limit}, era ${cfg.era}`);
    }),
  );
  let cage = null;
  const cageName = "cage-check runs and every condition is GREEN";
  checks.push(
    await guarded(cageName, async () => {
      cage = await cageCheck({ rpc, account: vault, policy: { admin: adminHandle, pinnedCodeHash: codeHash, maxAllowanceYocto: DEFAULT_MAX_ALLOWANCE_YOCTO, extraMethods: [] } });
      const rows = cage.conditions.map((c) => `${c.id} ${c.status}`).join(", ");
      return result(cageName, exitCodeOf(cage) === 0, `verdict ${cage.verdict} at block ${cage.block.height}: ${rows}`);
    }),
  );
  return { checks, cage };
}

/**
 * The two checks every attach has, whatever the contract is: the account's `global_contract_hash` equals the published hash
 * (no publisher account, no local code), and the node's copy of the code under that hash hashes to it. Reads only.
 */
export async function hashAttachedChecks({ rpc, vault, codeHash }) {
  const checks = [];
  checks.push(
    await guarded("vault's global_contract_hash equals the published hash", async () => {
      const acc = await rpc.account(vault);
      if (!acc) return result("vault's global_contract_hash equals the published hash", false, `${vault} does not exist`);
      if (acc.global_contract_account_id) return result("vault's global_contract_hash equals the published hash", false, `it follows the account ${acc.global_contract_account_id} (mutable), not a hash`);
      const noLocal = acc.code_hash === EMPTY_CODE_HASH;
      return result("vault's global_contract_hash equals the published hash", acc.global_contract_hash === codeHash && noLocal, `on chain ${acc.global_contract_hash ?? "none"}${noLocal ? "" : `, local code ${acc.code_hash}`}, published ${codeHash}`);
    }),
  );
  checks.push(
    await guarded("the code published under that hash hashes to it", async () => {
      const code = await readGlobalCode(rpc, codeHash);
      return result("the code published under that hash hashes to it", code.present && code.hash === codeHash, code.present ? `${code.bytes} bytes, sha256 ${code.hash}` : "the node has no code under that hash");
    }),
  );
  return checks;
}

// ---- the run ----------------------------------------------------------------------------------------------------

async function waitForCode(rpc, codeHash, { sleep, tries = 40, delayMs = 1500 }) {
  for (let i = 0; i < tries; i++) {
    const code = await readGlobalCode(rpc, codeHash);
    if (code.present) return code;
    await sleep(delayMs);
  }
  throw new Refused(`the published code is not visible on the node under ${codeHash} after ${tries} tries; wait and re-run, nothing is charged twice`);
}

/**
 * Dry run unless `yes`. `sender` is `send({ signerId, signer, receiverId, actions }) -> { hash, outcome }` (globaltx.mjs),
 * `funder` is `{ accountId, publicKey, signer }`, `makeAdmin({ vault, create })` returns the vault's ML-DSA signer or null
 * (seed on file first, written before the key is used). Steps that the chain already shows done are skipped, so a run
 * that died half way is safe to run again. Returns the record (no secrets).
 */
export async function runGlobalContract({ plan, rpc, funder = null, sender, makeAdmin, yes = false, expectedChain = "testnet", log = () => {}, sleep = sleepFor, recordFile }) {
  if (yes && !funder) throw new Refused("--yes needs --funder-file (or KAIGEN_FUNDER_FILE): the funder pays for the publication and creates the vault");
  if (yes && funder.accountId !== plan.funder) throw new Refused(`the funder file is for ${funder.accountId} but the plan was made for ${plan.funder}`);
  const pre = await preflight({ rpc, plan, funderKey: funder?.publicKey ?? null, expectedChain });
  if (!yes) return { dryRun: true, plan, pre };
  if (!pre.ok) throw new Refused(`preflight failed, nothing was sent:\n${report(pre.checks).text}`);
  const rec = { mode: plan.init ? "vault" : "publish", network: expectedChain, codeHash: plan.wasm.codeHash, sha256Hex: plan.wasm.sha256Hex, bytes: plan.wasm.bytes, funder: plan.funder, vault: plan.vault, init: plan.init, txs: {}, gasBurntYocto: {}, skipped: [] };
  const save = () => {
    if (!recordFile) return;
    fs.mkdirSync(path.dirname(recordFile), { recursive: true });
    fs.writeFileSync(recordFile, JSON.stringify(rec, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  };
  const action = (id) => plan.steps.find((s) => s.id === id).actions;

  // 1 publish
  if (pre.facts.published === "yes") {
    rec.skipped.push("publish: the code is already on chain under this hash");
    log({ step: "publish skipped: already on chain", codeHash: plan.wasm.codeHash });
  } else {
    const before = BigInt((await rpc.account(plan.funder)).amount);
    const sent = await sender({ signerId: plan.funder, signer: funder.signer, receiverId: plan.funder, actions: action("publish") });
    rec.txs.publish = sent.hash;
    log({ step: "published by code hash", tx: sent.hash });
    await waitForCode(rpc, plan.wasm.codeHash, { sleep });
    const after = BigInt((await rpc.account(plan.funder)).amount);
    rec.measured = measureFromOutcome({ outcome: sent.outcome, bytes: plan.wasm.bytes, before, after });
    rec.gasBurntYocto.publish = rec.measured.gasBurntYocto ?? rec.measured.tokensBurntYocto;
    log({ step: "measured cost of publishing", ...rec.measured });
  }
  save();

  // 2 create
  const vaultAccount = pre.facts.vaultAccount;
  let admin = null;
  try {
    if (vaultAccount) {
      admin = makeAdmin({ vault: plan.vault, create: false });
      const keys = pre.facts.vaultKeys ?? [];
      if (!admin) throw new Refused(`${plan.vault} already exists and no admin seed for it is on file: pick another --vault`);
      if (!keys.some((k) => k.public_key === admin.publicKeyHandle && k.access_key.permission === "FullAccess")) throw new Refused(`${plan.vault} exists but its admin seed on file does not match a full-access key on the account: pick another --vault`);
      rec.skipped.push("create: the vault already exists with the admin key on file");
      log({ step: "create skipped: the vault exists with the admin key on file", vault: plan.vault });
    } else {
      admin = makeAdmin({ vault: plan.vault, create: true });
      const create = action("create").map((a) => (a.type === "AddKey" ? { ...a, publicKey: admin.publicKey } : a));
      const sent = await sender({ signerId: plan.funder, signer: funder.signer, receiverId: plan.vault, actions: create });
      rec.txs.create = sent.hash;
      rec.gasBurntYocto.create = gasCostOf(sent.outcome).toString();
      rec.adminHandle = admin.publicKeyHandle;
      log({ step: "vault created, its only key is the ML-DSA-65 admin key", vault: plan.vault, tx: sent.hash, adminHandle: admin.publicKeyHandle });
    }
    rec.adminHandle = admin.publicKeyHandle;
    save();

    // 3 attach
    const acc = await rpc.account(plan.vault);
    if (!acc) throw new Refused(`${plan.vault} is not visible on the node after it was created; re-run in a moment, the finished steps are skipped`);
    if (acc.global_contract_hash === plan.wasm.codeHash) {
      rec.skipped.push("attach: the vault already uses this hash");
      log({ step: "attach skipped: the vault already uses this hash" });
    } else {
      if (acc.global_contract_hash || acc.global_contract_account_id || acc.code_hash !== EMPTY_CODE_HASH) throw new Refused(`${plan.vault} already has a contract (${acc.global_contract_hash ?? acc.global_contract_account_id ?? acc.code_hash}); not replacing it`);
      const sent = await sender({ signerId: plan.vault, signer: admin, receiverId: plan.vault, actions: action("attach") });
      rec.txs.attach = sent.hash;
      rec.gasBurntYocto.attach = gasCostOf(sent.outcome).toString();
      log({ step: plan.init ? "attached by hash and initialised in the same transaction" : "attached by hash (no init)", tx: sent.hash });
    }
  } finally {
    admin?.destroy?.();
  }
  save();

  // 4 verify
  const verified = plan.init
    ? await verifyVault({ rpc, vault: plan.vault, codeHash: plan.wasm.codeHash, init: plan.init, adminHandle: rec.adminHandle })
    : { checks: await hashAttachedChecks({ rpc, vault: plan.vault, codeHash: plan.wasm.codeHash }), cage: null };
  rec.verify = verified.checks;
  rec.ok = verified.checks.every((c) => c.ok);
  save();
  return { dryRun: false, plan, pre, rec, cage: verified.cage };
}

// ---- output -----------------------------------------------------------------------------------------------------

const describeAction = (a) => {
  switch (a.type) {
    case "DeployGlobalContract":
      return `DeployGlobalContract(mode CodeHash, ${a.code.length} bytes)`;
    case "UseGlobalContract":
      return `UseGlobalContract(CodeHash ${a.codeHash})`;
    case "Transfer":
      return `Transfer(${formatNear(a.yocto)} NEAR)`;
    case "AddKey":
      return `AddKey(full access, ${a.publicKey.length > 60 ? `${a.publicKey.slice(0, 24)}...` : a.publicKey})`;
    case "FunctionCall":
      return `FunctionCall(${a.method}, ${JSON.stringify(a.args)}, ${a.gasTgas} Tgas)`;
    default:
      return a.type;
  }
};

export function renderPlan(plan) {
  const e = plan.estimate;
  const lines = [
    `wasm        ${plan.wasm.path}`,
    `            ${plan.wasm.bytes} bytes, sha256 ${plan.wasm.sha256Hex}`,
    `code hash   ${plan.wasm.codeHash}  (what the chain calls it; global_contract_hash must equal this)`,
    `funder      ${plan.funder ?? "<none given>"}`,
    `${plan.init ? "vault      " : "account    "} ${plan.vault}`,
    plan.init ? `init        ${JSON.stringify(plan.init)}` : "init        none (publish-only mode: the account is attached to the hash and nothing is called)",
    "",
    "steps:",
    ...plan.steps.flatMap((s, i) => [`  ${i + 1}. ${s.title}`, `     signed by ${s.signer ?? "<funder>"}, receiver ${s.receiver ?? "<funder>"}: ${s.actions.map(describeAction).join(" + ")}`]),
    "",
    `cost ESTIMATE (not measured): publishing burns about ${formatNear(e.burnYocto)} NEAR (${plan.wasm.bytes} bytes x 0.0001 NEAR per byte, nearcore runtime config 77.yaml; the docs say 10 NEAR per 100 KB, burnt). The ${plan.init ? "vault" : "account"} gets ${formatNear(e.vaultYocto)} NEAR. The funder needs about ${formatNear(e.neededYocto)} NEAR available, plus gas. The measured figure is printed after a real run.`,
  ];
  if (plan.init && !plan.hasAttest) lines.push("note: this wasm has no attest() export (a v2 build): cage-check cannot reach GREEN with it.");
  return lines.join("\n");
}

export function renderRun(out) {
  const lines = [renderPlan(out.plan), "", "preflight (read-only):", report(out.pre.checks).text];
  if (out.dryRun) return lines.join("\n");
  lines.push("", "sent:", ...Object.entries(out.rec.txs).map(([k, v]) => `  ${k}  ${v}`), ...out.rec.skipped.map((s) => `  skipped: ${s}`));
  if (out.rec.measured) {
    const { publish: _published, ...otherGas } = out.rec.gasBurntYocto;
    lines.push("", ...renderMeasured(out.rec.measured, otherGas));
  } else if (out.rec.skipped.some((s) => s.startsWith("publish"))) {
    lines.push("", "NO MEASUREMENT: the code was already on chain under this hash, so this run paid nothing for it.");
  }
  lines.push("", "verification:", report(out.rec.verify).text);
  if (out.cage) lines.push("", renderCage(out.cage));
  return lines.join("\n");
}

// ---- command line -----------------------------------------------------------------------------------------------

export const GLOBAL_USAGE =
  "usage: kaigen-jobs globalcontract publish --wasm <file> [--funder-file <file>] [--vault <account>] [--vault-near <NEAR>] [--admin-seed-file <file>] [--rpc <url>] [--yes]\n" +
  "       kaigen-jobs globalcontract --kizashi <account> [--funder-file <file>] [--wasm <file>] [--vault <account>] [--vault-near <NEAR>] [--daily-limit <NEAR>] [--delay-secs <n>] [--admin-seed-file <file>] [--rpc <url>] [--yes]\n" +
  "       kaigen-jobs globalcontract --cost-of <publish tx hash> --signer <account> [--bytes <n>] [--rpc <url>]\n" +
  "       kaigen-jobs globalcontract --verify <vault> [--wasm <file> | --code-hash <base58|hex>] [--kizashi <account>] [--admin <ml-dsa-65-hash:...>] [--rpc <url>]\n" +
  "  Testnet only. Dry run unless --yes: it reads the chain and prints the plan, the preflight and the cost ESTIMATE; nothing is signed.\n" +
  "  --funder-file    JSON {\"account_id\",\"private_key\"} of a funded testnet account (default: KAIGEN_FUNDER_FILE). It publishes the code and creates the vault\n" +
  "  --wasm           default out/prod/mamori.wasm. Its sha256 is the code hash the vault is pinned to\n" +
  "  --kizashi        the Kizashi the vault follows (init argument, required)\n" +
  "  --vault          default gv-<8 hex of the wasm hash>.<funder>; must be a sub-account of the funder\n" +
  "  --vault-near     NEAR the funder puts on the vault (default 1)\n" +
  "  --daily-limit    NEAR cap per 24 h for init (default 1)\n" +
  "  --delay-secs     withdrawal delay for init (default 86400, the production floor; less only works with a drill build)\n" +
  "  --admin-seed-file where the vault's new ML-DSA-65 seed is written BEFORE the key is used (default <KAIGEN_TESTNET_DIR or .kaigen-testnet>/global-admin-seeds.json)\n" +
  "  publish          PUBLISH-ONLY: publish ANY valid wasm by code hash (--wasm is required, nothing is assumed), create a sub-account of the funder, attach it by hash with NO init, verify, and print the MEASURED cost (balance before/after, gas, bytes, yoctoNEAR per byte). --vault is that account (default gp-<8 hex>.<funder>), --vault-near its balance (default 0.1)\n" +
  "  --cost-of        read-only: the measured cost of a publish that already happened, from EXPERIMENTAL_tx_status on its transaction hash; needs --signer <account> (--bytes <n> if the node no longer holds the code)\n" +
  "  --verify         read-only: check an existing vault against the wasm hash (global_contract_hash, views, cage-check)\n" +
  "  --rpc            default https://rpc.testnet.fastnear.com. A node that says it is mainnet is refused";

const hashArg = (text) => {
  try {
    return normalizeCodeHash(text);
  } catch (e) {
    throw new GlobalUsage(e.message);
  }
};

/** `argv` is what follows `globalcontract`. `defaults`: { wasm, seedFile, funderFile }. */
export function parseGlobalArgs(allArgv, defaults) {
  const publish = allArgv[0] === "publish";
  const argv = publish ? allArgv.slice(1) : allArgv;
  const valued = new Set(["--funder-file", "--wasm", "--kizashi", "--vault", "--vault-near", "--daily-limit", "--delay-secs", "--admin-seed-file", "--rpc", "--verify", "--code-hash", "--admin", "--chain-id", "--cost-of", "--signer", "--bytes"]);
  const seen = {};
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes") yes = true;
    else if (valued.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new GlobalUsage(`${a} needs a value`);
      if (a in seen) throw new GlobalUsage(`${a} given twice`);
      seen[a] = v;
    } else throw new GlobalUsage(a.startsWith("--") ? `unknown option ${a}` : `unexpected argument ${JSON.stringify(a)}`);
  }
  if (seen["--cost-of"]) {
    if (publish || yes || seen["--verify"]) throw new GlobalUsage("--cost-of is read-only on its own: it takes no publish, --verify or --yes");
    if (!seen["--signer"]) throw new GlobalUsage("--cost-of needs --signer <the account that signed that transaction>");
    if (seen["--bytes"] !== undefined && !/^[1-9][0-9]*$/.test(seen["--bytes"])) throw new GlobalUsage("--bytes must be a positive whole number");
  } else if (seen["--signer"] || seen["--bytes"]) throw new GlobalUsage("--signer and --bytes belong to --cost-of");
  if (publish) {
    const used = ["--funder-file", "--wasm", "--vault", "--vault-near", "--admin-seed-file", "--rpc", "--chain-id"];
    const stray = Object.keys(seen).find((k) => !used.includes(k));
    if (stray) throw new GlobalUsage(`${stray} is not used by publish (it is for the vault run or --verify)`);
    if (!seen["--wasm"]) throw new GlobalUsage("publish needs --wasm <file>: it burns about 0.0001 NEAR per byte of whatever it is given, so nothing is assumed");
  }
  const chainId = seen["--chain-id"] ?? "testnet";
  if (chainId === "mainnet") throw new GlobalUsage("--chain-id mainnet: this tool is testnet only");
  if (seen["--verify"] && yes) throw new GlobalUsage("--verify is read-only and takes no --yes");
  if (seen["--wasm"] && seen["--code-hash"]) throw new GlobalUsage("--wasm and --code-hash exclude each other");
  const delayText = seen["--delay-secs"] ?? String(MIN_DELAY_SECS);
  const delay = Number(delayText);
  if (!/^\d+$/.test(delayText) || !Number.isSafeInteger(delay)) throw new GlobalUsage("--delay-secs must be a whole number of seconds");
  if (!publish && !seen["--verify"] && !seen["--cost-of"] && !seen["--kizashi"]) throw new GlobalUsage("give --kizashi <account>: the Kizashi the vault follows");
  return {
    mode: publish ? "publish" : seen["--cost-of"] ? "cost" : seen["--verify"] ? "verify" : "deploy",
    costOf: seen["--cost-of"],
    signer: seen["--signer"],
    bytes: seen["--bytes"] === undefined ? undefined : Number(seen["--bytes"]),
    verifyVault: seen["--verify"],
    wasm: seen["--wasm"] ?? defaults.wasm,
    codeHash: seen["--code-hash"] === undefined ? undefined : hashArg(seen["--code-hash"]),
    funderFile: seen["--funder-file"] ?? defaults.funderFile,
    kizashi: seen["--kizashi"],
    vault: seen["--vault"],
    vaultYocto: parseNear(seen["--vault-near"] ?? (publish ? "0.1" : "1"), "--vault-near"),
    dailyLimitYocto: parseNear(seen["--daily-limit"] ?? "1", "--daily-limit"),
    delaySecs: delay,
    seedFile: seen["--admin-seed-file"] ?? defaults.seedFile,
    admin: seen["--admin"],
    rpc: seen["--rpc"] ?? TESTNET_RPC,
    chainId,
    yes,
  };
}

/** Same output location rule as the other testnet jobs: gitignored, next to the rehearsal. */
export const defaultSeedFile = (root, env) => path.join(env.KAIGEN_TESTNET_DIR ?? path.join(root, ".kaigen-testnet"), "global-admin-seeds.json");
