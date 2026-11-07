// prodvault: a PRODUCTION-build Mamori vault on testnet, built the way the mainnet one will be, so the live demo can show the
// real 24-hour delay and a cage-check that has nothing drill-shaped to be red about. `plant-key` (plantkey.mjs) then plants and
// removes a key on it for the cage-check red / green shot.
//
//   1 create   the funder creates the vault sub-account `pv-<8 hex>.<funder>` with 4.9 NEAR and a fresh classical key
//   2 deploy   the vault (classical key) deploys out/prod/mamori.wasm and calls `init` IN THE SAME TRANSACTION: `init` is
//              `#[init] #[private]`, so only a transaction signed by the vault's own key can run it, and nobody can init first
//   3 enrol    the vault (classical key) adds a fresh ML-DSA-65 key as a full-access key
//   4 lock     the ML-DSA key deletes the classical key: the ML-DSA key is now the ONLY key (exactly as testnet.mjs does it)
//   5 policy   the ML-DSA admin allowlists one supplier, turns the allowlist on, and adds one agent daily key (allowance null,
//              which is what the rehearsal passes: the vault then applies its own default)
//   6 verify   views, code hash and cage-check (cage.mjs) against the vault, GREEN / RED / UNKNOWN per row
//
// DRY RUN BY DEFAULT: without `yes` this only reads the chain (status, accounts, key lists) and prints the plan. Nothing here
// signs: the sender, the signers and the key makers are handed in (bin.mjs builds them from globaltx.mjs), so a test drives the
// whole path with fake chain objects. Testnet only: a node that says it is mainnet is refused whatever the flags.
//
// Secrets. Every key is written to `dir` (gitignored: it must be .kaigen-testnet*) BEFORE it can hold anything, and none is ever
// printed or logged: the output carries account ids, public keys and transaction hashes only.
import fs from "node:fs";
import path from "node:path";
import { cageCheck, DEFAULT_MAX_ALLOWANCE_YOCTO, exitCodeOf, renderCage } from "./cage.mjs";
import { assertMamori, availableYocto, describeWasm, formatNear, GlobalUsage, isAccountId, MIN_DELAY_SECS, MIN_PROTOCOL_MLDSA, Refused, TESTNET_RPC } from "./globalcontract.mjs";
import { saveKeys } from "./testnet.mjs";
import { report } from "./verify.mjs";


const NEAR = 10n ** 24n;
/** out/prod/mamori.wasm is 432,906 bytes: storage 4.329 NEAR at 1e19 yocto per byte, so 4.9 NEAR leaves about 0.57 NEAR to work with. */
export const VAULT_YOCTO = 4_900n * 10n ** 21n;
export const DAILY_LIMIT_YOCTO = NEAR;
export const DELAY_SECS = MIN_DELAY_SECS;
/** What the funder keeps free beyond the 4.9 NEAR it sends (gas of the creating transaction, with room). */
export const FUNDER_MARGIN_YOCTO = NEAR / 10n;
/** The vault must keep at least this much beyond its code's storage, or the first calls run out of balance. */
const VAULT_WORKING_MIN_YOCTO = NEAR / 4n;
const STORAGE_YOCTO_PER_BYTE = 10n ** 19n;
const INIT_GAS_TGAS = 30;
const POLICY_CALL_TGAS = 30;
const SECRET_DIR_PREFIX = ".kaigen-testnet";

const message = (e) => String(e?.message ?? e);
const result = (name, ok, detail, extra = {}) => ({ name, ok, detail, ...extra });
const guarded = async (name, fn) => {
  try {
    return await fn();
  } catch (e) {
    return result(name, false, `could not check: ${message(e)}`);
  }
};

/** What this tool does not show, printed with every dry run and every report so a GREEN is not read as more than it is. */
export const NOT_COVERED = [
  "the Kizashi this vault follows is the one given with --kizashi, a testnet / drill one: nothing here shows the PRODUCTION omens, a production Kizashi or anything on mainnet",
  "testnet only, no audit, not run on mainnet",
  "no payment, strike, burn, withdrawal or fire test was run; the withdrawal delay is the production 24 hours, so a withdrawal cannot finish inside a demo",
  "cage-check is one final block in time: a key added after it is not seen",
  "the allowlisted supplier is a name only: the account is not created or checked here (it must exist before a payment to it)",
];

// ---- the secrets folder -------------------------------------------------------------------------------------------

/**
 * Throws Refused when `dir` is inside the repository but not under a `.kaigen-testnet*` folder: those are the only secret folders
 * .gitignore covers. A folder outside the repository is the caller's own business.
 */
export function assertSecretsDir(dir, root) {
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (inside && !rel.split(path.sep)[0].startsWith(SECRET_DIR_PREFIX)) {
    throw new Refused(`${dir} is inside the repository but not under ${SECRET_DIR_PREFIX}*, the only folders .gitignore covers: the seeds and keys would be at risk of being committed. Set KAIGEN_TESTNET_DIR to a ${SECRET_DIR_PREFIX}* folder or one outside the repository`);
  }
  return path.resolve(dir);
}

/** Keeps a secret file readable by its owner only where the OS supports that, and never leaves it half written. */
export function writeSecretJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

// ---- chain checks shared with plant-key ---------------------------------------------------------------------------

/** A check that the node is the chain asked for and is not mainnet. `status` is read by the caller once. */
export function chainCheck(status, expectedChain = "testnet") {
  const name = "chain is the one asked for, and is not mainnet";
  const id = status?.chain_id;
  if (id === "mainnet" || expectedChain === "mainnet") return result(name, false, `chain_id ${id}: this tool is testnet only`);
  return result(name, id === expectedChain, `chain_id ${id}, asked for ${expectedChain}`);
}

/** The key list the chain shows, with the one full-access ML-DSA key a locked vault must end with. */
export const fullAccessKeys = (keys) => (keys ?? []).filter((k) => k.access_key?.permission === "FullAccess").map((k) => k.public_key);

// ---- the plan -----------------------------------------------------------------------------------------------------

/** `pv-<8 hex>.<funder>`; `suffix` is 8 hex digits (random in a real run, fixed in a test). */
export const prodVaultId = (suffix, funderId) => `pv-${suffix}.${funderId ?? "<funder>"}`;

/**
 * Everything the run would send, as plain data (the action descriptors of globaltx.mjs). Pure: no chain, no keys.
 * `funderId` may be null in a dry run without a funder file; the vault id then carries a placeholder.
 */
export function planProdVault({ wasm, wasmPath, funderId = null, kizashi, supplier, suffix, adminPublicKey = "<ML-DSA-65 public key, generated when run with --yes>", bootstrapPublicKey = "<fresh classical key, generated when run with --yes>", agentPublicKey = "<fresh agent daily key, generated when run with --yes>" }) {
  const shape = assertMamori(wasm);
  const w = describeWasm(wasm, wasmPath);
  if (!/^[0-9a-f]{8}$/.test(suffix ?? "")) throw new GlobalUsage("the vault name suffix must be 8 hex digits");
  if (funderId !== null && !isAccountId(funderId)) throw new GlobalUsage(`funder ${JSON.stringify(funderId)} is not a NEAR account id`);
  if (funderId !== null && /(^|\.)near$/.test(funderId)) throw new Refused(`the funder ${funderId} looks like a mainnet account: this tool is testnet only`);
  if (!isAccountId(kizashi)) throw new GlobalUsage(`--kizashi ${JSON.stringify(kizashi)} is not a NEAR account id`);
  const vault = prodVaultId(suffix, funderId);
  if (funderId !== null && !isAccountId(vault)) throw new GlobalUsage(`the vault name ${JSON.stringify(vault)} is not a NEAR account id (is the funder name too long?)`);
  const supplierId = supplier ?? (funderId === null ? "supplier.<funder>" : `supplier.${funderId}`);
  if (funderId !== null && !isAccountId(supplierId)) throw new GlobalUsage(`--supplier ${JSON.stringify(supplierId)} is not a NEAR account id`);
  const storage = BigInt(w.bytes) * STORAGE_YOCTO_PER_BYTE;
  if (VAULT_YOCTO < storage + VAULT_WORKING_MIN_YOCTO) {
    throw new Refused(`the vault gets ${formatNear(VAULT_YOCTO)} NEAR but ${w.bytes} bytes of code need ${formatNear(storage)} NEAR of storage and about ${formatNear(VAULT_WORKING_MIN_YOCTO)} NEAR to work with: this wasm is too large for 4.9 NEAR`);
  }
  const init = { kizashi, daily_limit: DAILY_LIMIT_YOCTO.toString(), delay_secs: DELAY_SECS };
  const call = (method, args, gasTgas) => ({ type: "FunctionCall", method, args, gasTgas, depositYocto: 0 });
  return {
    wasm: w,
    hasAttest: shape.attest,
    funder: funderId,
    vault,
    kizashi,
    supplier: supplierId,
    init,
    estimate: { vaultYocto: VAULT_YOCTO, storageYocto: storage, workingYocto: VAULT_YOCTO - storage, marginYocto: FUNDER_MARGIN_YOCTO, neededYocto: VAULT_YOCTO + FUNDER_MARGIN_YOCTO },
    steps: [
      { id: "create", title: "create the vault with 4.9 NEAR and a fresh classical key (it exists only to deploy and enrol the ML-DSA key)", signer: funderId, receiver: vault, actions: [{ type: "CreateAccount" }, { type: "Transfer", yocto: VAULT_YOCTO }, { type: "AddKey", publicKey: bootstrapPublicKey }] },
      { id: "deploy", title: "deploy the production wasm and run init in the SAME transaction (nobody can initialise first)", signer: `${vault} (its classical key)`, receiver: vault, actions: [{ type: "DeployContract", code: wasm }, call("init", init, INIT_GAS_TGAS)] },
      { id: "enrol", title: "enrol the ML-DSA-65 admin key as a full-access key", signer: `${vault} (its classical key)`, receiver: vault, actions: [{ type: "AddKey", publicKey: adminPublicKey }] },
      { id: "lock", title: "the ML-DSA key deletes the classical key: it is now the vault's ONLY key", signer: `${vault} (its ML-DSA-65 key)`, receiver: vault, actions: [{ type: "DeleteKey", publicKey: bootstrapPublicKey }] },
      {
        id: "policy",
        title: "allowlist one supplier, turn the allowlist on, add one agent daily key",
        signer: `${vault} (its ML-DSA-65 key)`,
        receiver: vault,
        actions: [call("allow_recipient", { account: supplierId }, POLICY_CALL_TGAS), call("enforce_allowlist", { on: true }, POLICY_CALL_TGAS), call("add_daily_key", { public_key: agentPublicKey, allowance: null }, POLICY_CALL_TGAS)],
      },
    ],
  };
}

// ---- reads --------------------------------------------------------------------------------------------------------

/** Read-only: what the run depends on. Never throws for a read that fails: that is a failed check. */
export async function preflight({ rpc, plan, funderKey = null, expectedChain = "testnet" }) {
  const checks = [];
  let status;
  checks.push(
    await guarded("chain is the one asked for, and is not mainnet", async () => {
      status = await rpc.status();
      return chainCheck(status, expectedChain);
    }),
  );
  checks.push(
    await guarded("protocol supports ML-DSA-65 keys", async () => {
      const v = status?.protocol_version;
      return result("protocol supports ML-DSA-65 keys", Number.isInteger(v) && v >= MIN_PROTOCOL_MLDSA, `protocol ${v}; ML-DSA-65 from ${MIN_PROTOCOL_MLDSA}`);
    }),
  );
  checks.push(
    await guarded("the vault's storage fits in 4.9 NEAR", async () => result("the vault's storage fits in 4.9 NEAR", true, `${plan.wasm.bytes} bytes need ${formatNear(plan.estimate.storageYocto, 3)} NEAR of storage, leaving about ${formatNear(plan.estimate.workingYocto, 3)} NEAR`)),
  );
  checks.push(
    await guarded("the Kizashi account exists", async () => {
      const acc = await rpc.account(plan.kizashi);
      return result("the Kizashi account exists", acc !== null, acc ? `${plan.kizashi} (the vault follows it; a drill Kizashi, not the production omens)` : `${plan.kizashi} does not exist: a vault that follows nothing shows nothing`);
    }),
  );
  if (!isAccountId(plan.supplier)) {
    checks.push(result("the supplier account (information)", true, `${plan.supplier} is a placeholder until a funder file names the funder (or give --supplier)`, { skipped: true }));
  } else checks.push(
    await guarded("the supplier account (information)", async () => {
      const acc = await rpc.account(plan.supplier);
      return result("the supplier account (information)", true, acc ? `${plan.supplier} exists` : `${plan.supplier} does not exist yet: it is allowlisted by name, create it before a payment`);
    }),
  );
  if (plan.funder === null || funderKey === null) {
    checks.push(result("funder balance and key", true, "no funder file given, so the balance and the key were not checked (give --funder-file)", { skipped: true }));
  } else {
    checks.push(
      await guarded("funder balance covers 4.9 NEAR and a margin", async () => {
        const acc = await rpc.account(plan.funder);
        if (!acc) return result("funder balance covers 4.9 NEAR and a margin", false, `${plan.funder} does not exist`);
        const available = availableYocto(acc);
        return result("funder balance covers 4.9 NEAR and a margin", available >= plan.estimate.neededYocto, `available ${formatNear(available)} NEAR, needs ${formatNear(plan.estimate.neededYocto)} NEAR (${formatNear(plan.estimate.vaultYocto)} for the vault + ${formatNear(plan.estimate.marginYocto)} margin for gas)`);
      }),
    );
    checks.push(
      await guarded("funder file's key is a full-access key of the funder", async () => {
        const keys = await rpc.accessKeys(plan.funder);
        const mine = (keys ?? []).find((k) => k.public_key === funderKey);
        const full = mine?.access_key?.permission === "FullAccess";
        return result("funder file's key is a full-access key of the funder", full, mine ? `${funderKey} (${full ? "full access" : "function call"})` : `${funderKey} is not on ${plan.funder}`);
      }),
    );
  }
  if (plan.funder === null) {
    checks.push(result("vault account", true, `${plan.vault} is a placeholder until a funder file names the funder`, { skipped: true }));
  } else {
    checks.push(
      await guarded("vault name is free", async () => {
        const acc = await rpc.account(plan.vault);
        return result("vault name is free", acc === null, acc ? `${plan.vault} already exists: run again for a new name` : `${plan.vault} does not exist yet: step 1 creates it`);
      }),
    );
  }
  return { checks, ok: checks.every((c) => c.ok) };
}

// ---- the run ------------------------------------------------------------------------------------------------------

const secretFreeCopy = (rec) => JSON.parse(JSON.stringify(rec, (k, v) => (k === "privateKey" ? undefined : v)));

/**
 * Dry run unless `yes`. `sender` is `send({ signerId, signer, receiverId, actions }) -> { hash, outcome }` (globaltx.mjs),
 * `funder` is `{ accountId, publicKey, signer }`, `newKey()` returns `{ privateKey, publicKey, signer }`, and `makeAdmin({ vault, create })`
 * returns the vault's ML-DSA signer (its seed is on disk before it is returned). Returns the record without any secret.
 */
export async function runProdVault({ plan, rpc, funder = null, sender, newKey, makeAdmin, dir, yes = false, expectedChain = "testnet", log = () => {} }) {
  if (yes && !funder) throw new Refused("--yes needs --funder-file (or KAIGEN_FUNDER_FILE): the funder creates and funds the vault");
  if (yes && funder.accountId !== plan.funder) throw new Refused(`the funder file is for ${funder.accountId} but the plan was made for ${plan.funder}`);
  const pre = await preflight({ rpc, plan, funderKey: funder?.publicKey ?? null, expectedChain });
  if (!yes) return { dryRun: true, plan, pre };
  if (!pre.ok) throw new Refused(`preflight failed, nothing was sent:\n${report(pre.checks).text}`);

  // Every key exists on disk before it can hold anything. Order: classical bootstrap, ML-DSA admin (its seed), agent key.
  fs.mkdirSync(dir, { recursive: true });
  const boot = newKey();
  saveKeys(dir, { id: plan.vault, privateKey: boot.privateKey, publicKey: boot.publicKey });
  const admin = makeAdmin({ vault: plan.vault, create: true });
  const agent = newKey();
  const recordFile = path.join(dir, `prodvault-${plan.vault}.json`);
  const rec = {
    mode: "prodvault",
    network: expectedChain,
    vault: plan.vault,
    funder: plan.funder,
    kizashi: plan.kizashi,
    supplier: plan.supplier,
    codeHash: plan.wasm.codeHash,
    bytes: plan.wasm.bytes,
    init: plan.init,
    adminHandle: admin.publicKeyHandle,
    bootstrapPublicKey: boot.publicKey,
    daily: { publicKey: agent.publicKey, privateKey: agent.privateKey },
    txs: {},
    completed: [],
  };
  const save = () => writeSecretJson(recordFile, rec);
  save();
  const step = (id) => plan.steps.find((s) => s.id === id).actions;
  const bind = (actions, from, to) => actions.map((a) => (a.type === "AddKey" && a.publicKey === from ? { ...a, publicKey: to } : a));
  const done = (id, hash, line) => {
    rec.txs[id] = hash;
    rec.completed.push(id);
    save();
    log({ step: line, tx: hash });
  };
  const keysOf = async () => {
    const keys = await rpc.accessKeys(plan.vault);
    if (keys === null) throw new Refused(`${plan.vault} is not visible on the node; re-check in a moment`);
    return keys;
  };

  try {
    const placeholder = (id) => step(id).find((a) => a.type === "AddKey")?.publicKey;
    // 1 create
    const created = await sender({ signerId: plan.funder, signer: funder.signer, receiverId: plan.vault, actions: bind(step("create"), placeholder("create"), boot.publicKey) });
    done("create", created.hash, "vault created with 4.9 NEAR and a classical key");

    // 2 deploy + init, one transaction, signed by the vault itself
    const deployed = await sender({ signerId: plan.vault, signer: boot.signer, receiverId: plan.vault, actions: step("deploy") });
    done("deploy", deployed.hash, "production wasm deployed and init run in the same transaction");

    // 3 enrol the ML-DSA key; do not go on to delete the classical key unless the chain shows the new one
    const enrolled = await sender({ signerId: plan.vault, signer: boot.signer, receiverId: plan.vault, actions: bind(step("enrol"), placeholder("enrol"), admin.publicKey) });
    done("enrol", enrolled.hash, "ML-DSA-65 admin key enrolled");
    if (!fullAccessKeys(await keysOf()).includes(admin.publicKeyHandle)) {
      throw new Refused(`the ML-DSA key ${admin.publicKeyHandle} is not listed on ${plan.vault} after it was added: the classical key was NOT deleted, nothing is locked`);
    }

    // 4 lock: the ML-DSA key deletes the classical key
    const locked = await sender({ signerId: plan.vault, signer: admin, receiverId: plan.vault, actions: step("lock").map((a) => ({ ...a, publicKey: boot.publicKey })) });
    done("lock", locked.hash, "the vault's classical full-access key is deleted; only the ML-DSA-65 key remains");
    const after = await keysOf();
    if (after.length !== 1 || !fullAccessKeys(after).includes(admin.publicKeyHandle)) {
      throw new Refused(`after the lock ${plan.vault} should have exactly one key, the ML-DSA admin; it lists ${after.map((k) => k.public_key).join(", ") || "none"}`);
    }

    // 5 policy
    const policy = await sender({ signerId: plan.vault, signer: admin, receiverId: plan.vault, actions: step("policy").map((a) => (a.method === "add_daily_key" ? { ...a, args: { ...a.args, public_key: agent.publicKey } } : a)) });
    done("policy", policy.hash, "supplier allowlisted, allowlist on, agent daily key added");
  } catch (e) {
    // The record and the keys stay on disk; nothing is retried here, because a half-built vault is a decision for the person.
    e.message = `${message(e)}
(prodvault stopped after: ${rec.completed.join(", ") || "nothing sent"}; the keys and the record are in ${dir}; ${plan.vault} is left as it is)`;
    throw e;
  } finally {
    admin.destroy?.();
  }

  // 6 verify
  const checks = await verifyProdVault({ rpc, plan, agentPublicKey: agent.publicKey, adminHandle: admin.publicKeyHandle });
  rec.verify = checks.checks;
  rec.cage = { verdict: checks.cage?.verdict ?? null, rows: checks.cage?.conditions.map((c) => ({ id: c.id, status: c.status })) ?? null };
  rec.ok = checks.checks.every((c) => c.ok) && checks.cage?.verdict === "GREEN";
  save();
  return { dryRun: false, plan, pre, rec: secretFreeCopy(rec), checks: checks.checks, cage: checks.cage, recordFile };
}

/** Step 6, reads only. The admin is compared by the handle the ML-DSA library derived from the key, so no stand-in admin is needed. */
export async function verifyProdVault({ rpc, plan, agentPublicKey, adminHandle }) {
  const checks = [];
  checks.push(
    await guarded("the vault's only full-access key is the ML-DSA-65 admin", async () => {
      const keys = (await rpc.accessKeys(plan.vault)) ?? [];
      const full = fullAccessKeys(keys);
      const others = keys.filter((k) => k.access_key.permission !== "FullAccess").length;
      return result("the vault's only full-access key is the ML-DSA-65 admin", full.length === 1 && full[0] === adminHandle, `full access: ${full.join(", ") || "none"}; expected only ${adminHandle}; ${others} function-call key(s) besides (the agent's daily key)`);
    }),
  );
  checks.push(
    await guarded("views answer (config) and equal the init arguments", async () => {
      const cfg = await rpc.view(plan.vault, "config");
      const wrong = [];
      if (cfg.kizashi !== plan.init.kizashi) wrong.push(`kizashi ${cfg.kizashi}`);
      if (Number(cfg.delay_secs) !== plan.init.delay_secs) wrong.push(`delay_secs ${cfg.delay_secs}`);
      if (String(cfg.daily_limit) !== plan.init.daily_limit) wrong.push(`daily_limit ${cfg.daily_limit}`);
      return result("views answer (config) and equal the init arguments", wrong.length === 0, wrong.length ? `differs from init: ${wrong.join(", ")}` : `kizashi ${cfg.kizashi}, delay_secs ${cfg.delay_secs}, daily_limit ${cfg.daily_limit}, era ${cfg.era}`);
    }),
  );
  checks.push(
    await guarded("the agent daily key is recorded by the vault", async () => {
      const daily = await rpc.view(plan.vault, "daily_keys");
      return result("the agent daily key is recorded by the vault", Array.isArray(daily) && daily.includes(agentPublicKey), `daily_keys() lists ${Array.isArray(daily) ? daily.length : "?"} key(s)`);
    }),
  );
  let cage = null;
  const cageName = "cage-check runs and every row is GREEN";
  checks.push(
    await guarded(cageName, async () => {
      cage = await cageCheck({ rpc, account: plan.vault, policy: { admin: adminHandle, pinnedCodeHash: plan.wasm.codeHash, maxAllowanceYocto: DEFAULT_MAX_ALLOWANCE_YOCTO, extraMethods: [] } });
      return result(cageName, exitCodeOf(cage) === 0, `verdict ${cage.verdict} at block ${cage.block.height}: ${cage.conditions.map((c) => `${c.id} ${c.status}`).join(", ")}`);
    }),
  );
  checks.push(
    await guarded("the allowlist is on", async () => {
      const on = cage?.info.allowlist_enforced;
      return result("the allowlist is on", on === true, on === null || on === undefined ? "attest() did not report it" : `attest() reports allowlist_enforced ${on}`);
    }),
  );
  return { checks, cage };
}

// ---- output -------------------------------------------------------------------------------------------------------

const describeAction = (a) => {
  switch (a.type) {
    case "DeployContract":
      return `DeployContract(${a.code.length} bytes)`;
    case "Transfer":
      return `Transfer(${formatNear(a.yocto)} NEAR)`;
    case "AddKey":
      return `AddKey(full access, ${a.publicKey.length > 60 ? `${a.publicKey.slice(0, 24)}...` : a.publicKey})`;
    case "DeleteKey":
      return `DeleteKey(${a.publicKey.length > 60 ? `${a.publicKey.slice(0, 24)}...` : a.publicKey})`;
    case "FunctionCall":
      return `FunctionCall(${a.method}, ${JSON.stringify(a.args)}, ${a.gasTgas} Tgas)`;
    default:
      return a.type;
  }
};

export function renderPlan(plan) {
  const e = plan.estimate;
  return [
    `wasm        ${plan.wasm.path}`,
    `            ${plan.wasm.bytes} bytes, sha256 ${plan.wasm.sha256Hex}`,
    `code hash   ${plan.wasm.codeHash}  (what the chain calls it; the vault's code_hash must equal this)`,
    `funder      ${plan.funder ?? "<none given>"}`,
    `vault       ${plan.vault}  (the 8 hex digits are random per run)`,
    `kizashi     ${plan.kizashi}`,
    `supplier    ${plan.supplier}`,
    `init        ${JSON.stringify(plan.init)}  (24 h delay: a production build refuses less)`,
    "",
    "steps:",
    ...plan.steps.flatMap((s, i) => [`  ${i + 1}. ${s.title}`, `     signed by ${s.signer ?? "<funder>"}, receiver ${s.receiver ?? "<funder>"}: ${s.actions.map(describeAction).join(" + ")}`]),
    "  6. read the chain and run cage-check against the vault (GREEN / RED / UNKNOWN per row)",
    "",
    `cost: the vault gets ${formatNear(e.vaultYocto)} NEAR (${formatNear(e.storageYocto, 3)} NEAR of it is the code's storage); the funder needs about ${formatNear(e.neededYocto)} NEAR available, plus gas.`,
  ].join("\n");
}

export function renderRun(out) {
  const lines = [renderPlan(out.plan), "", "preflight (read-only):", report(out.pre.checks).text];
  if (!out.dryRun) {
    lines.push("", "sent:", ...Object.entries(out.rec.txs).map(([k, v]) => `  ${k}  ${v}`));
    lines.push("", "verification:", report(out.checks).text);
    if (out.cage) lines.push("", renderCage(out.cage));
    lines.push("", `agent daily key (public): ${out.rec.daily.publicKey}`, `admin (ML-DSA-65, as the chain lists it): ${out.rec.adminHandle}`);
  }
  lines.push("", "NOT COVERED:", ...NOT_COVERED.map((l) => `  - ${l}`));
  return lines.join("\n");
}

// ---- command line -------------------------------------------------------------------------------------------------

export const PRODVAULT_USAGE =
  "usage: kaigen-jobs prodvault --kizashi <account> --funder-file <file> [--supplier <account>] [--wasm <file>] [--rpc <url>] [--yes]\n" +
  "  Testnet only. Dry run unless --yes: it reads the chain and prints the plan, the preflight and what is not covered; nothing is signed.\n" +
  "  --kizashi      the (drill) Kizashi the vault follows (init argument, required)\n" +
  "  --funder-file  JSON {\"account_id\",\"private_key\"} of a funded testnet account (default: KAIGEN_FUNDER_FILE). It needs about 5 NEAR available. Required with --yes\n" +
  "  --supplier     the one account to allowlist (default supplier.<funder>)\n" +
  "  --wasm         default out/prod/mamori.wasm; its sha256 is the code hash cage-check pins\n" +
  "  --rpc          default https://rpc.testnet.fastnear.com. A node that says it is mainnet is refused\n" +
  "  keys           written to KAIGEN_TESTNET_DIR (default .kaigen-testnet, gitignored): admin-seeds.json, accounts.json, prodvault-<vault>.json. Never printed.";

/** `argv` is what follows `prodvault`. `defaults`: { wasm, funderFile }. */
export function parseProdVaultArgs(argv, defaults) {
  const valued = new Set(["--kizashi", "--funder-file", "--supplier", "--wasm", "--rpc", "--chain-id"]);
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
  const chainId = seen["--chain-id"] ?? "testnet";
  if (chainId === "mainnet") throw new GlobalUsage("--chain-id mainnet: this tool is testnet only");
  if (!seen["--kizashi"]) throw new GlobalUsage("give --kizashi <account>: the Kizashi the vault follows");
  return {
    kizashi: seen["--kizashi"],
    funderFile: seen["--funder-file"] ?? defaults.funderFile,
    supplier: seen["--supplier"],
    wasm: seen["--wasm"] ?? defaults.wasm,
    rpc: seen["--rpc"] ?? TESTNET_RPC,
    chainId,
    yes,
  };
}

