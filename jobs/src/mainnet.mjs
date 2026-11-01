// KAIGEN mainnet tooling: stage 0 to 3 and the lock (stage 5) of docs/PLAN-submission-and-mainnet.md.
//
//   gates    stage 0, read-only: chain, protocol, ML-DSA key types, intents.near methods, balances and state
//   plan     prints every transaction stages 1 to 3 would send; sends nothing, needs no key
//   execute  stages 1 to 3 only; refuses without --yes and without a deployer key file
//   lock     stage 5: ONE transaction deleting every Kizashi access key, behind a fresh release gate
//
// Everything here is DRY-RUN BY DEFAULT and has no way to send on its own: the sender is handed in per call
// (`loadKey` returns `{ accountId, publicKey, send }`, built by chain.mjs from a key file), and this module never
// imports the signing library. Reads go through the injected `rpc`. The private key never reaches this file.
import fs from "node:fs";
import path from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { compare, productionOmens } from "../../scripts/omens.mjs";
import { checkUsdcRegistration, loadDrillKeys, predeploy, report as predeployReport, wasmExports } from "../../scripts/predeploy.mjs";
import { classifyKeys } from "./classify.mjs";
import { codeHashOf, validateGate } from "./verify.mjs";

export class Refused extends Error {
  constructor(message) {
    super(message);
    this.name = "Refused";
  }
}

/**
 * The oldest protocol this tool lets stage 0 call "ready". 86 is what mainnet ran on 30 Oct 2026 (its `status` also said
 * the node binary supports 88); it is the version G1 will first be attempted on, not a version where ML-DSA is known to
 * work: the post-quantum flow has only been proven on testnet protocol 88. `mainnet.minProtocol` raises it.
 */
export const MIN_PROTOCOL = 86;
const MAINNET = "mainnet";
const EMPTY_CODE_HASH = "11111111111111111111111111111111";
/** NEAR's storage price: 1e19 yoctoNEAR per byte of state or code. */
const STORAGE_YOCTO_PER_BYTE = 10n ** 19n;
const NEAR = 10n ** 24n;
const DEFAULT_MARGIN_NEAR = "0.5";
const INIT_GAS_TGAS = 30;
/** NEAR allows at most 100 actions in one transaction. */
const MAX_LOCK_ACTIONS = 100;
const ERAS = ["Calm", "Warning", "Kaigen"];
const PLACEHOLDER_KEY = "<public key of the key file>";
/** AddKey starts a key's nonce at block_height * 1e6 and each signed transaction raises it, so an exact multiple means "never signed". */
const NONCE_RANGE = 1_000_000n;
/** The size of an ML-DSA-65 public key, which is the only ML-DSA spelling the nodes parse (as `ml-dsa-65:<base58>`). */
const ML_DSA_65_PUBLIC_KEY_BYTES = 1952;

const result = (name, ok, detail, extra = {}) => ({ name, ok, detail, ...extra });
const message = (e) => String(e?.message ?? e);
const guarded = async (name, fn) => {
  try {
    return await fn();
  } catch (e) {
    return result(name, false, `could not check: ${message(e)}`);
  }
};

// ---- amounts ------------------------------------------------------------------------------------

function parseNear(text, what) {
  if (typeof text !== "string" || !/^\d+(\.\d{1,24})?$/.test(text)) throw new Error(`${what} must be a decimal NEAR amount like "0.5", got ${JSON.stringify(text)}`);
  const [whole, frac = ""] = text.split(".");
  return BigInt(whole) * NEAR + BigInt(frac.padEnd(24, "0"));
}
const fmtNear = (yocto) => `${yocto / NEAR}.${String((yocto % NEAR) / 10n ** 20n).padStart(4, "0")}`;
const storageOf = (bytes) => BigInt(bytes) * STORAGE_YOCTO_PER_BYTE;
const margin = (dep) => parseNear(dep.mainnet?.marginNear ?? DEFAULT_MARGIN_NEAR, "mainnet.marginNear");

// ---- inputs -------------------------------------------------------------------------------------

/** Wasm builds, init files and the PUBLIC drill keys named by deployments.json (`mainnet.*`). */
export function loadInputs({ dep, root }) {
  const m = dep.mainnet ?? {};
  const at = (p) => path.resolve(root, p);
  const need = (name) => {
    if (typeof m[name] !== "string" || !m[name]) throw new Error(`deployments.json: mainnet.${name} is not set`);
    return at(m[name]);
  };
  const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  const wasm = (sub, name) => fs.readFileSync(path.join(root, "out", sub, `${name}.wasm`));
  return {
    wasm: { prod: { kizashi: wasm("prod", "kizashi"), mamori: wasm("prod", "mamori") }, drill: { kizashi: wasm("drill", "kizashi"), mamori: wasm("drill", "mamori") } },
    kizashiInit: json(need("kizashiInit")),
    drillInit: json(need("drillInit")),
    drillKeys: loadDrillKeys(need("drillKeys")),
  };
}

// ---- the plan -----------------------------------------------------------------------------------

const deploy = (code) => ({ type: "DeployContract", codeBase64: code.toString("base64"), bytes: code.length, codeHash: codeHashOf(code) });
const call = (method, args) => ({ type: "FunctionCall", method, args, gasTgas: INIT_GAS_TGAS, depositYocto: 0n });
/** Storage the account pays itself when it deploys code to itself (a transfer in from elsewhere is a deposit instead). */
const selfStorage = (t) => (t.receiver === t.signer ? t.actions.filter((a) => a.type === "DeployContract").reduce((sum, a) => sum + storageOf(a.bytes), 0n) : 0n);
const depositOf = (actions) => actions.reduce((sum, a) => sum + (a.type === "Transfer" ? BigInt(a.yocto) : 0n) + (a.type === "FunctionCall" ? BigInt(a.depositYocto ?? 0) : 0n), 0n);

/**
 * The transactions of stages 1 to 3 as plain data. `publicKey` is the key the new accounts get; without a key
 * file it is a placeholder, so `plan` can run with no secret anywhere near it.
 */
export function buildPlan({ dep, inputs, publicKey = PLACEHOLDER_KEY }) {
  const m = dep.mainnet ?? {};
  const deployer = m.deployer;
  if (typeof deployer !== "string" || !deployer) throw new Error("deployments.json: mainnet.deployer is not set");
  for (const k of ["kizashi", "mamoriReference"]) if (typeof dep[k] !== "string" || !dep[k]) throw new Error(`deployments.json: ${k} is not set`);
  const drillVaults = dep.drill?.vaults;
  if (typeof dep.drill?.kizashi !== "string" || !Array.isArray(drillVaults) || drillVaults.length === 0) throw new Error("deployments.json: drill.kizashi and drill.vaults are not set");
  const { wasm, kizashiInit, drillInit } = inputs;
  const extra = margin(dep);
  const vault = m.drillVault ?? {};

  const created = (id, code) => {
    if (!id.endsWith(`.${deployer}`)) throw new Error(`${id} is not a sub-account of ${deployer}: the deployer can only create its own sub-accounts, so create ${id} some other way first`);
    return [{ type: "CreateAccount" }, { type: "Transfer", yocto: storageOf(code.length) + extra }, { type: "AddKey", publicKey, permission: "FullAccess" }];
  };
  const tx = (stage, n, title, signer, receiver, actions) => ({ id: `${stage}.${n}`, title, signer, receiver, actions, depositYocto: depositOf(actions) });

  const stage1 = [];
  const drillKizashi = dep.drill.kizashi;
  stage1.push(tx(1, 1, "create the drill Kizashi account", deployer, drillKizashi, created(drillKizashi, wasm.drill.kizashi)));
  stage1.push(tx(1, 2, "deploy and initialise the drill Kizashi (one transaction)", drillKizashi, drillKizashi, [deploy(wasm.drill.kizashi), call("new", { omens: drillInit.omens, usdc: drillInit.usdc ?? null })]));
  drillVaults.forEach((v, i) => {
    stage1.push(tx(1, 3 + 2 * i, `create drill vault ${v}`, deployer, v, created(v, wasm.drill.mamori)));
    stage1.push(
      tx(1, 4 + 2 * i, `deploy and initialise drill vault ${v} (one transaction)`, v, v, [
        deploy(wasm.drill.mamori),
        call("init", { kizashi: drillKizashi, daily_limit: vault.dailyLimitYocto ?? String(NEAR), delay_secs: vault.delaySecs ?? 300 }),
      ]),
    );
  });

  const stage2 = [
    tx(2, 1, "create the Mamori reference account", deployer, dep.mamoriReference, created(dep.mamoriReference, wasm.prod.mamori)),
    tx(2, 2, "deploy production Mamori to the reference account (code only, not initialised)", dep.mamoriReference, dep.mamoriReference, [deploy(wasm.prod.mamori)]),
  ];

  const stage3 = [
    tx(3, 1, "deploy and initialise production Kizashi (one transaction, no key is deleted)", dep.kizashi, dep.kizashi, [
      deploy(wasm.prod.kizashi),
      call("new", { omens: kizashiInit.omens, usdc: kizashiInit.usdc }),
    ]),
  ];

  return {
    stages: [
      { stage: 1, title: "mainnet drill pair", keyAccount: deployer, txs: stage1 },
      { stage: 2, title: "production Mamori reference", keyAccount: deployer, txs: stage2 },
      { stage: 3, title: "production Kizashi, unlocked", keyAccount: dep.kizashi, txs: stage3 },
    ],
    notes: [
      "Stage 1 ends with gate G1, which this tool does not run: sign the ML-DSA admin flow and the fire test on the drill pair yourself. Stage 2 refuses until the chain shows each drill vault's only full-access key is an ML-DSA key that has signed a transaction.",
      `Stage 3 is signed by the Kizashi account itself, so ${dep.kizashi} must already exist, be funded and be registered with the USDC token. No key is deleted until \`mainnet lock\`.`,
      "Deposits are estimates: storage at 1e19 yoctoNEAR per byte of code plus the margin, and gas is extra.",
    ],
  };
}

const summarize = (a) => {
  switch (a.type) {
    case "DeployContract":
      return `DeployContract ${a.bytes.toLocaleString("en-US")} bytes, code hash ${a.codeHash}`;
    case "FunctionCall":
      return `FunctionCall ${a.method} ${JSON.stringify(a.args, (k, v) => (k === "omens" ? `${v.length} omens` : v))} (${a.gasTgas} Tgas)`;
    case "Transfer":
      return `Transfer ~${fmtNear(BigInt(a.yocto))} NEAR`;
    case "AddKey":
      return `AddKey ${a.publicKey} (full access)`;
    default:
      return a.type + (a.publicKey ? ` ${a.publicKey}` : "");
  }
};

export function renderPlan(plan) {
  const lines = ["KAIGEN mainnet plan. Nothing is sent: this only prints what stages 1 to 3 would send.", ""];
  const totals = new Map();
  for (const s of plan.stages) {
    lines.push(`STAGE ${s.stage}: ${s.title} (signed with the key file of ${s.keyAccount})`);
    for (const t of s.txs) {
      lines.push(`  ${t.id}  ${t.signer} -> ${t.receiver}   ${t.title}`);
      for (const a of t.actions) lines.push(`        ${summarize(a)}`);
      if (t.depositYocto > 0n) lines.push(`        deposit ~${fmtNear(t.depositYocto)} NEAR`);
      // An account that deploys to itself pays the code's storage from its own balance.
      const own = selfStorage(t);
      if (own > 0n) lines.push(`        needs ~${fmtNear(own)} NEAR already on ${t.receiver} for the code's storage`);
      totals.set(s.keyAccount, (totals.get(s.keyAccount) ?? 0n) + t.depositYocto + own);
    }
    lines.push("");
  }
  lines.push("Estimated deposits, by key file:");
  for (const [account, yocto] of totals) lines.push(`  ${account}: ~${fmtNear(yocto)} NEAR over its stages, plus gas`);
  lines.push("", ...plan.notes.map((n) => `Note: ${n}`));
  return lines.join("\n");
}

// ---- stage 0: read-only gates -------------------------------------------------------------------

/**
 * A well-formed ML-DSA-65 public key nobody holds: a fixed phrase's hash, repeated to full length. The nodes parse
 * `ml-dsa-65:` keys of exactly 1952 bytes and reject every other spelling, `ml-dsa-65-hash:` included, as an unknown
 * key type (queried on mainnet 86 and testnet 88, 30 Oct 2026).
 */
const probeKey = () => {
  const seed = sha256(Buffer.from("kaigen/ml-dsa-probe"));
  return `ml-dsa-65:${base58.encode(Uint8Array.from({ length: ML_DSA_65_PUBLIC_KEY_BYTES }, (_, i) => seed[i % seed.length]))}`;
};

async function mldsaProbe(rpc) {
  const name = "ML-DSA key types are parsed by the node (necessary, not sufficient)";
  try {
    await rpc.call("query", { request_type: "view_access_key", finality: "final", account_id: "near", public_key: probeKey() });
    return result(name, true, "the node answered for an ML-DSA key; the full proof is stage 1's G1 on a drill account");
  } catch (e) {
    // "No such key" means the key type parsed; "unknown key type" means the node does not know it.
    if (e.kind === "UNKNOWN_ACCESS_KEY" || /access key .*does not exist/i.test(message(e))) {
      return result(name, true, "the node parses ml-dsa-65 keys; whether the protocol accepts ML-DSA signatures and keys in transactions is proved by stage 1's G1, not here");
    }
    return result(name, false, `the node rejected an ML-DSA key: ${message(e)}`);
  }
}

async function intentsMethods(rpc) {
  const name = "intents.near methods";
  try {
    const code = await rpc.call("query", { request_type: "view_code", finality: "final", account_id: "intents.near" });
    const names = wasmExports(Buffer.from(code.code_base64, "base64")).filter((e) => e.kind === "func").map((e) => e.name);
    return result(name, true, `${names.length} exported methods: ${names.join(", ")}`);
  } catch (e) {
    return result(name, true, `could not discover: ${message(e)} (informational: read the methods from the contract's docs for gate G4)`, { skipped: true });
  }
}

/** Stage 0. Read-only RPC queries only. A check that cannot run fails, except the informational intents.near probe. */
export async function runGates({ rpc, dep, inputs }) {
  const out = [];
  const minProtocol = dep.mainnet?.minProtocol ?? MIN_PROTOCOL;
  let status;
  out.push(
    await guarded("rpc is on mainnet", async () => {
      status = await rpc.status();
      return result("rpc is on mainnet", status.chain_id === MAINNET, `chain_id ${status.chain_id}`);
    }),
  );
  out.push(
    await guarded("protocol version", async () => {
      status ??= await rpc.status();
      const newest = status.latest_protocol_version ?? "an unknown protocol";
      return result("protocol version", status.protocol_version >= minProtocol, `protocol ${status.protocol_version}, minimum ${minProtocol}; this node supports up to ${newest}; the post-quantum flow was proven on testnet protocol 88, so a pass here only means G1 may be attempted`);
    }),
  );
  out.push(await mldsaProbe(rpc), await intentsMethods(rpc));

  out.push(
    await guarded("deployer account", async () => {
      if (!inputs) throw new Error("the wasm builds and init files could not be loaded");
      const plan = buildPlan({ dep, inputs });
      const deployer = dep.mainnet.deployer;
      const need = plan.stages.filter((s) => s.keyAccount === deployer).flatMap((s) => s.txs).reduce((sum, t) => sum + t.depositYocto, 0n) + margin(dep);
      const acc = await rpc.account(deployer);
      if (!acc) return result("deployer account", false, `${deployer} does not exist`);
      const ok = BigInt(acc.amount) >= need;
      return result("deployer account", ok, `${deployer} holds ${fmtNear(BigInt(acc.amount))} NEAR${ok ? "," : " but"} needs about ${fmtNear(need)} NEAR for stages 1 and 2`);
    }),
  );
  out.push(
    await guarded("kizashi account", async () => {
      const acc = await rpc.account(dep.kizashi);
      if (!acc) return result("kizashi account", true, `${dep.kizashi} does not exist yet: create and fund it before stage 3`, { skipped: true });
      const prod = inputs ? codeHashOf(inputs.wasm.prod.kizashi) : null;
      if (prod && acc.code_hash === prod) return result("kizashi account", true, `${dep.kizashi} already runs the production build (stage 3 is done)`);
      if (acc.code_hash !== EMPTY_CODE_HASH) return result("kizashi account", false, `${dep.kizashi} already runs other code (${acc.code_hash})`);
      const need = inputs ? storageOf(inputs.wasm.prod.kizashi.length) + margin(dep) : 0n;
      const holds = BigInt(acc.amount);
      return holds >= need
        ? result("kizashi account", true, `${dep.kizashi} exists, has no contract, holds ${fmtNear(holds)} NEAR`)
        : result("kizashi account", true, `${dep.kizashi} holds ${fmtNear(holds)} NEAR, stage 3 needs about ${fmtNear(need)} NEAR: not funded enough yet`, { skipped: true });
    }),
  );
  out.push(
    await guarded("Kizashi is registered with the USDC token", async () => {
      if (!inputs?.kizashiInit?.usdc) throw new Error("no USDC token id in the Kizashi init file");
      return checkUsdcRegistration({ rpc, usdc: inputs.kizashiInit.usdc, kizashi: dep.kizashi });
    }),
  );
  return out;
}

// ---- execute: stages 1 to 3 ---------------------------------------------------------------------

function assertMainnetConfig(dep) {
  if (dep?.network !== MAINNET) throw new Refused(`deployments.json says network ${JSON.stringify(dep?.network)}: the mainnet tooling only runs against ${MAINNET}`);
}

async function assertMainnetChain(rpc) {
  const st = await rpc.status();
  if (st.chain_id !== MAINNET) throw new Refused(`the rpc reports chain_id ${st.chain_id}, not ${MAINNET}`);
}

const hasSigned = (k) => {
  const nonce = k.access_key?.nonce;
  return (typeof nonce === "number" || typeof nonce === "string") && BigInt(nonce) % NONCE_RANGE !== 0n;
};

/**
 * Kizashi's key exists to be deleted by the lock. The same key on the deployer, the Mamori reference or a drill account
 * would be a secret that outlives the lock (the plan says "never reused"), so it must be a key of its own.
 */
async function assertOwnKey({ publicKey, dep, rpc }) {
  const others = [dep.mainnet?.deployer, dep.mamoriReference, dep.drill?.kizashi, ...(dep.drill?.vaults ?? [])].filter(Boolean);
  for (const id of others) {
    const keys = await rpc.accessKeys(id);
    if (keys?.truncated) throw new Refused(`${id} has too many keys to read in full: cannot confirm that the Kizashi key file's key is not among them`);
    if (keys?.some((k) => k.public_key === publicKey)) {
      throw new Refused(`the key file's key ${publicKey} is also an access key of ${id}: Kizashi needs a key of its own, because the lock deletes it here and nowhere else`);
    }
  }
}

/** Evidence that the previous stage happened, read from the chain. */
async function assertPreviousStage({ stage, dep, inputs, rpc }) {
  const runs = async (id, wantHash, what) => {
    const acc = await rpc.account(id);
    if (!acc) throw new Refused(`the previous stage has not been completed: ${id} does not exist`);
    const have = acc.global_contract_hash ?? acc.code_hash;
    if (have !== wantHash) throw new Refused(`${id} does not run the ${what} build (chain ${have}, expected ${wantHash})`);
  };
  if (stage === 2) {
    await runs(dep.drill.kizashi, codeHashOf(inputs.wasm.drill.kizashi), "drill Kizashi");
    for (const v of dep.drill.vaults) await runs(v, codeHashOf(inputs.wasm.drill.mamori), "drill Mamori");
    // G1, read from the chain: the ML-DSA key replaced the classical key, so mainnet accepted both transactions.
    for (const v of dep.drill.vaults) {
      const keys = (await rpc.accessKeys(v)) ?? [];
      const c = classifyKeys(keys);
      if (c.postQuantumFullAccess.length === 0 || c.classicalFullAccess.length > 0) {
        throw new Refused(`gate G1 is not evidenced on chain: ${v} must have an ML-DSA full-access key and no classical full-access key (it has ${c.postQuantumFullAccess.length} post-quantum and ${c.classicalFullAccess.length} classical full-access key(s))`);
      }
      // The right key set alone is not G1: the classical key can delete itself after adding the ML-DSA key, and then
      // mainnet never verified an ML-DSA signature. A signed transaction moves the key's nonce off its starting value.
      if (!keys.some((k) => c.postQuantumFullAccess.includes(k.public_key) && hasSigned(k))) {
        throw new Refused(`gate G1 is not evidenced on chain: no ML-DSA key of ${v} has signed a transaction yet (its nonce is still where AddKey put it), so the classical key may have deleted itself. Sign the DeleteKey of the classical key with the ML-DSA key`);
      }
    }
  }
  if (stage === 3) {
    const ref = await rpc.account(dep.mamoriReference);
    if (!ref || (ref.global_contract_hash ?? ref.code_hash) !== codeHashOf(inputs.wasm.prod.mamori)) {
      throw new Refused(`stage 2 has not been completed: the Mamori reference ${dep.mamoriReference} does not run the production build`);
    }
    if (!(await rpc.account(dep.kizashi))) throw new Refused(`${dep.kizashi} does not exist: create and fund it first (stage 3 is signed by the Kizashi account itself)`);
    const checks = await predeploy({ init: inputs.kizashiInit, drillKeys: inputs.drillKeys, usdc: inputs.kizashiInit.usdc, wasm: inputs.wasm.prod.kizashi, rpc, kizashi: dep.kizashi });
    if (!predeployReport(checks).ok) {
      throw new Refused(`pre-deploy checks failed: ${checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`).join("; ")}`);
    }
  }
}

/** What each transaction still has to do: "todo" or "done". Refuses on anything that looks like someone else's account. */
async function assess({ st, rpc, publicKey }) {
  const willExist = new Set();
  const states = [];
  for (const tx of st.txs) {
    const acc = await rpc.account(tx.receiver);
    if (tx.actions.some((a) => a.type === "CreateAccount")) {
      if (!acc) {
        willExist.add(tx.receiver);
        states.push("todo");
        continue;
      }
      const keys = (await rpc.accessKeys(tx.receiver)) ?? [];
      if (!keys.some((k) => k.public_key === publicKey)) {
        throw new Refused(`${tx.receiver} already exists, and its keys are not the key file's key (${keys.length} key(s) on it): refusing to build on an account someone else may control`);
      }
      states.push("done");
      continue;
    }
    const dep = tx.actions.find((a) => a.type === "DeployContract");
    if (!acc && !willExist.has(tx.receiver)) throw new Refused(`${tx.receiver} does not exist`);
    if (!acc) states.push("todo");
    else if (acc.code_hash === dep.codeHash) states.push("done");
    else if (acc.code_hash === EMPTY_CODE_HASH) states.push("todo");
    else throw new Refused(`${tx.receiver} already runs other code (${acc.code_hash}): refusing to overwrite it`);
  }
  return states;
}

async function assertFunds({ st, states, rpc, dep }) {
  const funder = st.keyAccount;
  const spend = st.txs.reduce((sum, t, i) => {
    if (states[i] === "done" || t.signer !== funder) return sum;
    return sum + t.depositYocto + selfStorage(t);
  }, 0n);
  if (spend === 0n) return;
  const need = spend + margin(dep);
  const acc = await rpc.account(funder);
  if (!acc || BigInt(acc.amount) < need) throw new Refused(`${funder} holds ${fmtNear(BigInt(acc?.amount ?? 0))} NEAR but stage ${st.stage} needs about ${fmtNear(need)} NEAR`);
}

/** Checks after a stage: the code on chain is the code planned, and a freshly initialised Kizashi answers. */
async function postCheck({ st, rpc }) {
  const out = [];
  for (const tx of st.txs) {
    const d = tx.actions.find((a) => a.type === "DeployContract");
    if (!d) continue;
    out.push(
      await guarded(`${tx.receiver} runs the planned build`, async () => {
        const acc = await rpc.account(tx.receiver);
        return result(`${tx.receiver} runs the planned build`, acc?.code_hash === d.codeHash, `chain ${acc?.code_hash}, planned ${d.codeHash}`);
      }),
    );
    const init = tx.actions.find((a) => a.type === "FunctionCall");
    if (!init) continue;
    out.push(
      await guarded(`${tx.receiver} era is Calm`, async () => {
        const era = await rpc.view(tx.receiver, "era");
        return result(`${tx.receiver} era is Calm`, era === "Calm", `era ${JSON.stringify(era)}`);
      }),
    );
    if (init.method === "new") {
      out.push(
        await guarded(`${tx.receiver} omens match the init list`, async () => {
          const view = await rpc.view(tx.receiver, "omens");
          const want = init.args.omens;
          const same = view.length === want.length && want.every((o) => view.some((v) => v.id === o.id && v.public_key === o.public_key && v.curve === o.curve && v.level === o.level));
          const problems = tx.id === "3.1" ? compare(view) : [];
          return result(`${tx.receiver} omens match the init list`, same && problems.length === 0, problems.join("; ") || (same ? `${view.length} omens` : "the omens on chain differ from the init list"));
        }),
      );
    }
  }
  return out;
}

/**
 * Sends one stage. Refuses unless every precondition holds: stages 1 to 3 only, `yes === true`, a key file path,
 * mainnet config and chain, the key file's account matching the stage's signer, the previous stage's evidence on chain,
 * no account of someone else in the way, enough funds. Already finished steps are skipped, so a stopped stage
 * can simply be run again.
 */
export async function executeStage({ stage, dep, getInputs, rpc, yes, keyFile, loadKey, log = () => {} }) {
  if (![1, 2, 3].includes(stage)) throw new Refused(`stage ${stage} is not sent by "execute": stages 1 to 3 only (0 is "gates", 4 is "verify --release --pre-lock", 5 is "lock")`);
  if (yes !== true) throw new Refused("not sending: --yes was not given. This is a dry run; `mainnet plan` prints every transaction");
  if (!keyFile) throw new Refused("not sending: KAIGEN_DEPLOYER_KEY_FILE is not set (the path of the JSON key file of the signing account)");
  assertMainnetConfig(dep);
  const inputs = getInputs();
  const key = loadKey(keyFile);
  const st = buildPlan({ dep, inputs, publicKey: key.publicKey }).stages[stage - 1];
  if (key.accountId !== st.keyAccount) throw new Refused(`the key file is for ${key.accountId}, but stage ${stage} is signed by ${st.keyAccount}`);

  await assertMainnetChain(rpc);
  if (stage === 3) await assertOwnKey({ publicKey: key.publicKey, dep, rpc });
  await assertPreviousStage({ stage, dep, inputs, rpc });
  const states = await assess({ st, rpc, publicKey: key.publicKey });
  await assertFunds({ st, states, rpc, dep });

  log({ event: "stage", stage, title: st.title, signer: st.keyAccount, todo: st.txs.filter((_, i) => states[i] === "todo").map((t) => t.id) });
  const sent = [];
  const skipped = [];
  for (const [i, tx] of st.txs.entries()) {
    if (states[i] === "done") {
      skipped.push(tx.id);
      log({ event: "skipped", id: tx.id, reason: "already on chain" });
      continue;
    }
    log({ event: "tx", id: tx.id, title: tx.title, signer: tx.signer, receiver: tx.receiver, actions: tx.actions.map(summarize), deposit_near: fmtNear(tx.depositYocto) });
    let hash;
    try {
      hash = await key.send({ signerId: tx.signer, receiverId: tx.receiver, actions: tx.actions });
    } catch (e) {
      throw new Error(`stage ${stage} stopped at transaction ${tx.id} (${tx.title}): ${message(e)}; nothing after it was sent. Check the chain, then run the stage again: finished steps are skipped`);
    }
    sent.push({ id: tx.id, hash });
    log({ event: "sent", id: tx.id, hash });
  }

  const checks = await postCheck({ st, rpc });
  log({ event: "post-check", results: checks });
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) throw new Error(`stage ${stage} was sent but the post-check failed: ${failed.map((c) => `${c.name} (${c.detail})`).join("; ")}`);
  return { stage, sent, skipped, checks };
}

// ---- the lock (stage 5) -------------------------------------------------------------------------

/** The newest `release-gate-*.json` in `dir` by its own `createdAt`, or null. Files that are not gates are ignored. */
export function findLatestGate(dir) {
  if (!fs.existsSync(dir)) return null;
  let best = null;
  for (const f of fs.readdirSync(dir).filter((n) => /^release-gate-.*\.json$/.test(n))) {
    let gate;
    try {
      gate = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      continue;
    }
    const t = Date.parse(gate?.createdAt);
    if (gate?.kind !== "kaigen-release-gate" || Number.isNaN(t)) continue;
    if (!best || t > best.t) best = { file: path.join(dir, f), gate, t };
  }
  return best && { file: best.file, gate: best.gate };
}

async function postLockChecks({ rpc, dep, attempts, sleep }) {
  const out = [];
  const name = "kizashi has no access keys";
  let keys = null;
  let failure = null;
  for (let i = 0; i < attempts; i++) {
    try {
      keys = await rpc.accessKeys(dep.kizashi);
      failure = null;
      if (Array.isArray(keys) && keys.length === 0) break;
    } catch (e) {
      failure = e;
    }
    if (i < attempts - 1) await sleep(3000);
  }
  if (failure) out.push(result(name, false, `could not check: ${message(failure)}`));
  else out.push(result(name, Array.isArray(keys) && keys.length === 0, Array.isArray(keys) ? `${keys.length} key(s) still on the account` : `${dep.kizashi} does not exist`));

  out.push(
    await guarded("era() answers", async () => {
      const era = await rpc.view(dep.kizashi, "era");
      return result("era() answers", ERAS.includes(era), ERAS.includes(era) ? `era ${era}` : `reported ${JSON.stringify(era)}, not one of ${ERAS.join(", ")}`);
    }),
    await guarded("omens() answers", async () => {
      const view = await rpc.view(dep.kizashi, "omens");
      const problems = compare(view);
      if (view.length !== productionOmens().length) problems.push(`${view.length} omens, ${productionOmens().length} derived`);
      return result("omens() answers", problems.length === 0, problems.join("; ") || `${view.length} omens re-derive`);
    }),
    await guarded("bounty() answers", async () => {
      const b = await rpc.view(dep.kizashi, "bounty");
      const ok = typeof b?.near === "string" && /^\d+$/.test(b.near);
      return result("bounty() answers", ok, ok ? `${b.near} yoctoNEAR spendable, usdc ${b.usdc_token ?? "none"}` : `unexpected answer ${JSON.stringify(b)}`);
    }),
  );
  return out;
}

/**
 * Stage 5. ONE transaction carrying a DeleteKey for every access key of Kizashi. Irreversible, so every
 * precondition is checked and printed before anything is sent, and it only sends with `irreversible === true`.
 * Without it this is a dry run: it validates and prints, and sends nothing.
 */
export async function lockKizashi({ dep, rpc, gate, irreversible, keyFile, loadKey, now = new Date(), log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 5 }) {
  if (!gate) throw new Refused("no release gate file: run `verify --release --pre-lock` first, the lock only acts on a gate made in the last 24 hours");
  const verdict = validateGate({ gate, dep, now });
  if (!verdict.ok) throw new Refused(`the release gate is not acceptable: ${verdict.problems.join("; ")}`);
  assertMainnetConfig(dep);
  await assertMainnetChain(rpc);

  const acc = await rpc.account(dep.kizashi);
  if (!acc) throw new Refused(`${dep.kizashi} does not exist`);
  if (acc.code_hash !== gate.kizashiCodeHash) throw new Refused(`the code hash on ${dep.kizashi} changed since the gate was made (gate ${gate.kizashiCodeHash}, chain ${acc.code_hash}): verify again`);

  // Re-read the key list now, never trust the gate's copy, and print it before anything else happens.
  const listed = await rpc.accessKeys(dep.kizashi);
  if (listed?.truncated) throw new Refused(`${dep.kizashi} has too many keys to read in full: refusing to lock with keys unseen`);
  const keys = (listed ?? []).map((k) => k.public_key);
  if (keys.length > MAX_LOCK_ACTIONS) throw new Refused(`${dep.kizashi} has more than ${MAX_LOCK_ACTIONS} keys: one transaction cannot delete them all, so the lock would not be atomic`);
  log({ event: "keys", account: dep.kizashi, count: keys.length, keys });
  if (keys.length === 0) return { sent: false, nothingToDo: true, ok: true, keys };
  if (irreversible !== true) {
    log({ event: "dry-run", note: `would send ONE transaction deleting these ${keys.length} key(s) from ${dep.kizashi}. Add --i-understand-this-is-irreversible to send it` });
    return { sent: false, dryRun: true, ok: true, keys };
  }
  if (!keyFile) throw new Refused("not sending: KAIGEN_DEPLOYER_KEY_FILE is not set (the key file of the Kizashi account, whose key this transaction deletes)");

  const key = loadKey(keyFile);
  if (key.accountId !== dep.kizashi) throw new Refused(`the key file is for ${key.accountId}, but the lock must be signed by Kizashi (${dep.kizashi})`);
  if (!keys.includes(key.publicKey)) throw new Refused(`the key file's key ${key.publicKey} is not one of the keys on ${dep.kizashi}, so it cannot sign the lock`);
  await assertOwnKey({ publicKey: key.publicKey, dep, rpc });

  const actions = keys.map((publicKey) => ({ type: "DeleteKey", publicKey }));
  log({ event: "sending", account: dep.kizashi, delete: keys.length });
  let hash;
  let warning;
  try {
    hash = await key.send({ signerId: dep.kizashi, receiverId: dep.kizashi, actions });
  } catch (e) {
    // The outcome is unknown (a timeout can follow a transaction that landed): read the chain instead of assuming.
    warning = `the send call failed (${message(e)}); the result below is what the chain shows`;
  }
  if (hash) log({ event: "sent", hash });
  log({ event: "post-check" });
  const post = await postLockChecks({ rpc, dep, attempts, sleep });
  const ok = post.every((r) => r.ok);
  log({ event: "post-check-result", ok, results: post });
  return { sent: hash ? true : "unknown", ok, hash, keys, post, ...(warning ? { warning } : {}) };
}
