// `make verify`: checks KAIGEN's public claims against mainnet instead of asking anyone to trust us.
//
//   0. the RPC really is the network we say it is
//   1. the deployed code is the code in this repo (code hashes match a rebuild), and the
//      production build carries no drill-only entry point
//   2. every omen key re-derives from its published seed and matches `kizashi.omens()`
//   3. Kizashi has no access keys left (no admin, no upgrade)
//   4. the published fire tests happened against the drill contracts, and the drill vaults'
//      classical keys were gone afterwards
//
// `verifyRelease` is the mainnet gate (`verify --release`): it hard-codes mainnet, reads everything from two
// independent RPC hosts at one pinned block and fails on any disagreement, checks Kizashi is funded, and
// writes the gate file that `mainnet lock` requires. Before the lock (`--pre-lock`) Kizashi still holds its
// keys, so that one check becomes "the keys are readable"; after the lock the plain run needs none left.
//
// Each check returns { name, ok, detail }. A check that cannot run says so and counts as failed:
// "could not check" must never read as "verified". Evidence in a fire-test record is never taken at
// its word: transactions are matched to the contract, method and vault they must have hit.
import fs from "node:fs";
import path from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { compare, productionOmens } from "../../scripts/omens.mjs";
import { lockedDown } from "./firetest.mjs";
import { describeOwed, listOwed } from "./keeper.mjs";

export const codeHashOf = (bytes) => base58.encode(sha256(bytes));

/** A fire test older than this many blocks (about two weeks at one block per second) is stale. */
export const MAX_FIRE_TEST_AGE_BLOCKS = 1_300_000;

const result = (name, ok, detail) => ({ name, ok, detail });
const guarded = (name, fn) => fn().catch((e) => result(name, false, `could not check: ${e.message ?? e}`));

/** 0. The node answers for the network named in the config, or for `expected` when the caller hard-codes it. */
export const checkChain = ({ rpc, dep, expected }) =>
  guarded("rpc is on the expected network", async () => {
    const want = expected ?? dep.network ?? "mainnet";
    const st = await rpc.status();
    return result("rpc is on the expected network", st.chain_id === want, `chain_id ${st.chain_id}, expected ${want}`);
  });

/** 1. Deployed code hashes against the wasm built from this repo. */
export async function checkCodeHashes({ rpc, dep, wasmDir }) {
  const out = [];
  const read = (f) => fs.readFileSync(path.join(wasmDir, f));
  out.push(
    await guarded("code hash: kizashi", async () => {
      const acc = await rpc.account(dep.kizashi);
      if (!acc) return result("code hash: kizashi", false, `${dep.kizashi} does not exist`);
      const local = codeHashOf(read("kizashi.wasm"));
      return result("code hash: kizashi", acc.code_hash === local, `chain ${acc.code_hash}, local ${local}`);
    }),
  );
  out.push(
    await guarded("code hash: mamori", async () => {
      // Vaults use Mamori as a global contract (by hash) or deploy it directly; read whichever applies.
      const acc = await rpc.account(dep.mamoriReference);
      if (!acc) return result("code hash: mamori", false, `${dep.mamoriReference} does not exist`);
      const onChain = acc.global_contract_hash ?? acc.code_hash;
      const local = codeHashOf(read("mamori.wasm"));
      return result("code hash: mamori", onChain === local, `chain ${onChain}, local ${local}`);
    }),
  );
  // A drill build deployed as production would hand anyone a `reset`. Read the wasm's exports.
  out.push(
    await guarded("production build has no drill entry point", async () => {
      const names = ["kizashi.wasm", "mamori.wasm"].flatMap((f) => WebAssembly.Module.exports(new WebAssembly.Module(read(f))).map((e) => `${f}:${e.name}`));
      const leaked = names.filter((n) => n.endsWith(":reset"));
      return result("production build has no drill entry point", leaked.length === 0, leaked.length ? `exports ${leaked.join(", ")}` : "no reset export");
    }),
  );
  return out;
}

/** 1b. The drill contracts are the drill builds of the same code. */
export const checkDrillCode = ({ rpc, dep, drillWasmDir }) =>
  guarded("code hash: drill kizashi", async () => {
    if (!dep.drill) return result("code hash: drill kizashi", false, "deployments.json has no drill section");
    const acc = await rpc.account(dep.drill.kizashi);
    if (!acc) return result("code hash: drill kizashi", false, `${dep.drill.kizashi} does not exist`);
    const local = codeHashOf(fs.readFileSync(path.join(drillWasmDir, "kizashi.wasm")));
    return result("code hash: drill kizashi", acc.code_hash === local, `chain ${acc.code_hash}, local ${local}`);
  });

/** 1c. Every drill vault runs the drill build of Mamori (by its own code, or by the global contract it references). */
export const checkDrillVaultCode = ({ rpc, dep, drillWasmDir }) =>
  guarded("code hash: drill vault", async () => {
    const vaults = dep.drill?.vaults;
    if (!Array.isArray(vaults) || vaults.length === 0) return result("code hash: drill vault", false, "deployments.json has no drill vaults");
    const local = codeHashOf(fs.readFileSync(path.join(drillWasmDir, "mamori.wasm")));
    const bad = [];
    for (const v of vaults) {
      const acc = await rpc.account(v);
      const onChain = acc && (acc.global_contract_hash ?? acc.code_hash);
      if (!acc) bad.push(`${v} does not exist`);
      else if (onChain !== local) bad.push(`${v}: chain ${onChain}, local ${local}`);
    }
    return result("code hash: drill vault", bad.length === 0, bad.join("; ") || `${vaults.length} vault(s) run ${local}`);
  });

/** 2. Omen keys against their derivation: key bytes, curve and level. */
export const checkOmens = ({ rpc, dep }) =>
  guarded("omens re-derive from their seeds", async () => {
    const view = await rpc.view(dep.kizashi, "omens");
    const problems = compare(view);
    const extra = view.length - productionOmens().length;
    if (extra !== 0) problems.push(`${Math.abs(extra)} ${extra > 0 ? "unexpected" : "missing"} omen(s) on chain`);
    const broken = view.filter((o) => o.death).map((o) => o.id);
    // A broken omen is the product working, not a derivation failure: report it, do not fail on it.
    const note = broken.length ? ` (already broken: ${broken.join(", ")})` : "";
    return result("omens re-derive from their seeds", problems.length === 0, (problems.join("; ") || `${view.length} omens match`) + note);
  });

/** 3. No admin and no upgrade path. */
export const checkNoAccessKeys = ({ rpc, dep }) =>
  guarded("kizashi has no access keys", async () => {
    const keys = await rpc.accessKeys(dep.kizashi);
    if (keys === null) return result("kizashi has no access keys", false, `${dep.kizashi} does not exist`);
    return result("kizashi has no access keys", keys.length === 0, `${keys.length} access key(s)`);
  });

const firstMethod = (t) => t.transaction?.actions?.[0]?.FunctionCall?.method_name;

/** 4. Fire-test records, checked against what the chain says rather than what the record says. */
export async function checkFireTests({ rpc, archival, dir, dep, maxAgeBlocks = MAX_FIRE_TEST_AGE_BLOCKS }) {
  if (!fs.existsSync(dir)) return [result("fire tests published", false, `no records in ${dir}`)];
  const all = fs.readdirSync(dir).filter((f) => /^\d+(\.failed)?\.json$/.test(f)).sort();
  const files = all.filter((f) => !f.includes(".failed"));
  if (files.length === 0) return [result("fire tests published", false, "no fire tests yet")];
  if (!dep?.drill?.kizashi || !Array.isArray(dep.drill.vaults) || dep.drill.vaults.length === 0) {
    return [result("fire tests published", false, "deployments.json has no drill kizashi and vaults to check them against")];
  }
  const out = [];

  // The newest attempt decides: a string of failures after one old success must not read as healthy.
  const newest = all.at(-1);
  if (newest.includes(".failed")) out.push(result("latest fire test attempt", false, `${newest} is a failed attempt newer than the last success`));

  for (const f of files) {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const name = `fire test #${rec.seq}`;
    out.push(
      await guarded(name, async () => {
        const problems = [];
        const want = [...dep.drill.vaults].sort().join(",");
        if (!Array.isArray(rec.vaults) || [...rec.vaults].sort().join(",") !== want) problems.push("record's vaults are not the configured drill vaults");
        if (rec.kizashi !== dep.drill.kizashi) problems.push("record names a different Kizashi");
        if (!(rec.verified_block >= rec.claim_block)) problems.push("keys were checked before the claim");

        const claim = await archival.tx(rec.claim_tx, rec.submitter);
        if (claim.status?.SuccessValue === undefined) problems.push("claim tx did not succeed");
        if (claim.transaction?.receiver_id !== dep.drill.kizashi || firstMethod(claim) !== "claim") problems.push("claim tx was not a claim on the drill Kizashi");
        const logged = claim.receipts_outcome.some((r) => r.outcome.executor_id === dep.drill.kizashi && r.outcome.logs.some((l) => l.startsWith("EVENT_JSON:") && l.includes('"event":"claim"')));
        if (!logged) problems.push("the drill Kizashi emitted no claim event in that tx");

        for (const v of dep.drill.vaults) {
          const hash = rec.trip_txs?.[v];
          if (!hash) {
            problems.push(`no trip tx recorded for ${v}`);
            continue;
          }
          const t = await archival.tx(hash, rec.submitter);
          if (t.status?.SuccessValue === undefined) problems.push(`trip ${v} did not succeed`);
          if (t.transaction?.receiver_id !== v || firstMethod(t) !== "trip") problems.push(`trip tx for ${v} was not a trip on that vault`);
          const keys = await archival.accessKeys(v, rec.verified_block);
          if (keys === null) problems.push(`${v} missing at block ${rec.verified_block}`);
          else if (keys.truncated) problems.push(`${v} has too many keys to check at block ${rec.verified_block}`);
          else if (!lockedDown(keys)) problems.push(`${v} still had classical keys at block ${rec.verified_block}`);
        }
        return result(name, problems.length === 0, problems.join("; ") || `claim, ${dep.drill.vaults.length} trip(s), keys gone at block ${rec.verified_block}`);
      }),
    );
  }

  // Recency, by blocks (never the local clock): the rehearsal must be running, not just have run once.
  out.push(
    await guarded("fire tests are recent", async () => {
      const last = JSON.parse(fs.readFileSync(path.join(dir, files.at(-1)), "utf8"));
      const head = (await rpc.status()).sync_info.latest_block_height;
      const age = head - last.verified_block;
      return result("fire tests are recent", age <= maxAgeBlocks, `latest verified ${age.toLocaleString("en-US")} blocks ago, limit ${maxAgeBlocks.toLocaleString("en-US")}`);
    }),
  );
  return out;
}

export async function verifyAll({ rpc, archival = rpc, dep, wasmDir, drillWasmDir, fireTestDir }) {
  return [
    await checkChain({ rpc, dep }),
    ...(await checkCodeHashes({ rpc, dep, wasmDir })),
    await checkDrillCode({ rpc, dep, drillWasmDir: drillWasmDir ?? path.join(wasmDir, "..", "drill") }),
    await checkDrillVaultCode({ rpc, dep, drillWasmDir: drillWasmDir ?? path.join(wasmDir, "..", "drill") }),
    await checkOmens({ rpc, dep }),
    await checkNoAccessKeys({ rpc, dep }),
    ...(await checkFireTests({ rpc, archival, dir: fireTestDir, dep })),
  ];
}

export function report(results) {
  const lines = results.map((r) => `${r.skipped ? "SKIP" : r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
  const failed = results.filter((r) => !r.ok).length;
  lines.push("", failed === 0 ? `All ${results.length} checks passed.` : `${failed} of ${results.length} checks FAILED.`);
  return { text: lines.join("\n"), ok: failed === 0 };
}

// ---- release mode (mainnet gate) ---------------------------------------------------------------

export const RELEASE_NETWORK = "mainnet";
export const GATE_KIND = "kaigen-release-gate";
/** A gate older than this is stale: the chain, the balance or the code may have changed since. */
export const MAX_GATE_AGE_MS = 24 * 60 * 60 * 1000;
const GATE_CLOCK_SKEW_MS = 5 * 60 * 1000;
/** NEAR's storage price: 1e19 yoctoNEAR per byte. */
const STORAGE_YOCTO_PER_BYTE = 10n ** 19n;

const KEYS_BEFORE_LOCK = "kizashi access keys are readable (the lock deletes them)";
const KEYS_AFTER_LOCK = "kizashi has no access keys";
export const COMPLETE_CHECK = "all required checks ran";
export const NOTHING_OWED_CHECK = "no claimant is owed a payout";
export const DEPLOYER_KEY_CHECK = "deployer key is not left on the mamori reference";
const REQUIRED_BASE = [
  "deployments file is mainnet",
  "rpc hosts are independent",
  "rpc hosts agree on one final block",
  "rpc is on the expected network",
  "code hash: kizashi",
  "code hash: mamori",
  "production build has no drill entry point",
  "code hash: drill kizashi",
  "code hash: drill vault",
  "omens re-derive from their seeds",
  "kizashi balance covers the bounty",
  NOTHING_OWED_CHECK,
  DEPLOYER_KEY_CHECK,
  "fire tests are recent",
];
export const requiredChecks = (stage) => [...REQUIRED_BASE, stage === "pre-lock" ? KEYS_BEFORE_LOCK : KEYS_AFTER_LOCK];

/** Required checks that are absent from `checks` (a check that never ran must not read as a pass). */
export function missingChecks(checks, stage) {
  const names = checks.map((c) => c.name);
  const missing = requiredChecks(stage).filter((n) => !names.includes(n));
  if (!names.some((n) => n.startsWith("fire test #"))) missing.push("fire test #<n>");
  return missing;
}

/** J-net: the file under test cannot choose its own network. */
export const checkMainnetConfig = (dep) =>
  result("deployments file is mainnet", dep?.network === RELEASE_NETWORK, `deployments.json says network ${JSON.stringify(dep?.network)}, release mode needs ${RELEASE_NETWORK}`);

/** "Independent" is judged by operator: the last two labels of the host name (fastnear.com, near.org). */
const operatorOf = (url) => new URL(url).hostname.split(".").slice(-2).join(".");

export function checkIndependentHosts(hosts) {
  const name = "rpc hosts are independent";
  try {
    if (!Array.isArray(hosts) || hosts.length !== 2) return result(name, false, "could not check: release mode needs exactly two RPC hosts (rpc and rpcSecondary in deployments.json)");
    const [a, b] = hosts.map(operatorOf);
    return result(name, a !== b, a === b ? `both hosts belong to ${a}: that is one operator, not two` : `${a} and ${b}`);
  } catch (e) {
    return result(name, false, `could not check: ${e.message ?? e}`);
  }
}

/** Kizashi must hold at least the configured bounty, spendable, by two independent measures. */
export const checkBounty = ({ rpc, dep }) =>
  guarded("kizashi balance covers the bounty", async () => {
    const name = "kizashi balance covers the bounty";
    const want = typeof dep.bountyYocto === "string" && /^\d+$/.test(dep.bountyYocto) ? BigInt(dep.bountyYocto) : 0n;
    if (want === 0n) return result(name, false, "deployments.json has no valid bountyYocto (a positive whole number of yoctoNEAR, as a string)");
    const acc = await rpc.account(dep.kizashi);
    if (!acc) return result(name, false, `${dep.kizashi} does not exist`);
    // Storage staking is locked, not spendable: 100 NEAR holding 99 NEAR of storage pays a 1 NEAR bounty.
    const spendable = BigInt(acc.amount) - BigInt(acc.storage_usage) * STORAGE_YOCTO_PER_BYTE;
    const own = BigInt((await rpc.view(dep.kizashi, "bounty")).near);
    const ok = spendable >= want && own >= want;
    return result(name, ok, `${ok ? "" : "below the configured bounty: "}account spendable ${spendable}, bounty() says ${own}, configured ${want} yoctoNEAR`);
  });

/** K3: a payout still owed to a claimant of a broken omen blocks the release; the retry command is printed, never sent. */
export const checkNothingOwed = ({ rpc, dep }) =>
  guarded(NOTHING_OWED_CHECK, async () => {
    const owed = await listOwed({ rpc, kizashi: dep.kizashi });
    return result(NOTHING_OWED_CHECK, owed.length === 0, owed.length === 0 ? "every claimant of a broken omen has been paid" : owed.map(describeOwed).join(" | "));
  });

/** T3: the deployer's own full-access key must not be left on the Mamori reference, where it could redeploy the code vaults trust. */
export const checkDeployerKeyOnReference = ({ rpc, dep }) =>
  guarded(DEPLOYER_KEY_CHECK, async () => {
    const deployer = dep.mainnet?.deployer;
    if (typeof deployer !== "string" || deployer === "") return result(DEPLOYER_KEY_CHECK, false, "deployments.json has no mainnet.deployer to compare against");
    const [mine, ref] = [await rpc.accessKeys(deployer), await rpc.accessKeys(dep.mamoriReference)];
    if (mine === null) return result(DEPLOYER_KEY_CHECK, false, `${deployer} does not exist`);
    if (ref === null) return result(DEPLOYER_KEY_CHECK, false, `${dep.mamoriReference} does not exist`);
    if (mine.truncated || ref.truncated) return result(DEPLOYER_KEY_CHECK, false, "more keys than could be read");
    const full = (k) => k.access_key?.permission === "FullAccess";
    const own = new Set(mine.filter(full).map((k) => k.public_key));
    const left = ref.filter((k) => full(k) && own.has(k.public_key)).map((k) => k.public_key);
    return result(DEPLOYER_KEY_CHECK, left.length === 0, left.length ? `${deployer}'s full-access key ${left.join(", ")} is still on ${dep.mamoriReference}, so it could redeploy the code` : `none of ${deployer}'s full-access keys is on ${dep.mamoriReference}`);
  });

/** Before the lock: the keys the lock will delete can be read, so the lock has something real to act on. */
export const checkKeysBeforeLock = ({ rpc, dep }) =>
  guarded(KEYS_BEFORE_LOCK, async () => {
    const keys = await rpc.accessKeys(dep.kizashi);
    if (keys === null) return result(KEYS_BEFORE_LOCK, false, `${dep.kizashi} does not exist`);
    if (keys.truncated) return result(KEYS_BEFORE_LOCK, false, "more keys than could be read");
    return result(KEYS_BEFORE_LOCK, true, `${keys.length} access key(s)`);
  });

// ---- two hosts, one block --------------------------------------------------------------------

const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([p], [q]) => (p < q ? -1 : 1)).map(([k, x]) => [k, sorted(x)])) : v);
const canon = (v) => JSON.stringify(sorted(v));
const brief = (v) => String(canon(v)).slice(0, 100);
const byKey = (keys) => (keys === null ? null : [...keys].sort((x, y) => (x.public_key < y.public_key ? -1 : 1)));
const txEvidence = (t) => ({
  status: t.status,
  hash: t.transaction?.hash,
  signer: t.transaction?.signer_id,
  receiver: t.transaction?.receiver_id,
  actions: t.transaction?.actions,
  receipts: (t.receipts_outcome ?? []).map((r) => ({ id: r.id, executor: r.outcome?.executor_id, logs: r.outcome?.logs, status: r.outcome?.status })),
});

/**
 * An rpc-shaped object over two hosts. Every read goes to both, and any difference throws: a node that lies
 * or lags cannot make a check pass alone. Reads without a block id are pinned to ONE final block (the older of
 * the two hosts' heads, so both have it), chosen once per run.
 */
export function makeCrossRpc(nodes) {
  if (!Array.isArray(nodes) || nodes.length !== 2) throw new Error("cross-checking needs exactly two rpc hosts");
  const [a, b] = nodes;
  let pinned;
  const pin = () => (pinned ??= Promise.all([a.finalBlock(), b.finalBlock()]).then(([x, y]) => (x.height <= y.height ? x : y)));
  const at = async (blockId) => blockId ?? (await pin()).hash;
  const both = async (label, read, norm = (x) => x) => {
    const [x, y] = await Promise.all([read(a), read(b)]);
    if (canon(norm(x)) !== canon(norm(y))) throw new Error(`rpc hosts disagree on ${label}: ${brief(norm(x))} vs ${brief(norm(y))}`);
    return x;
  };
  return {
    finalBlock: pin,
    status: async () => {
      const [x, y] = await Promise.all([a.status(), b.status()]);
      if (x.chain_id !== y.chain_id || x.protocol_version !== y.protocol_version) throw new Error(`rpc hosts disagree on status: ${x.chain_id}/${x.protocol_version} vs ${y.chain_id}/${y.protocol_version}`);
      return x;
    },
    account: async (id, blockId) => both(`account ${id}`, async (r) => r.account(id, await at(blockId))),
    view: async (id, method, args = {}, blockId) => both(`${id}.${method}`, async (r) => r.view(id, method, args, await at(blockId))),
    accessKeys: async (id, blockId) => both(`access keys of ${id}`, async (r) => r.accessKeys(id, await at(blockId)), byKey),
    tx: (hash, signerId) => both(`tx ${hash}`, (r) => r.tx(hash, signerId), txEvidence),
  };
}

const unavailable = (why) =>
  new Proxy({}, {
    get: () => async () => {
      throw new Error(why);
    },
  });

/** The mainnet gate. `rpcs` and `archivals` are two hosts each; `hosts` are the URLs behind `rpcs`. */
export async function verifyRelease({ rpcs, hosts, archivals, dep, wasmDir, drillWasmDir, fireTestDir, preLock = false, now = () => new Date() }) {
  const stage = preLock ? "pre-lock" : "post-lock";
  const results = [checkMainnetConfig(dep), checkIndependentHosts(hosts)];
  const cross = makeCrossRpc(rpcs);
  const archive = Array.isArray(archivals) && archivals.length === 2 ? makeCrossRpc(archivals) : unavailable("release mode needs two archival hosts (archivalRpc and archivalRpcSecondary in deployments.json)");

  let block = null;
  results.push(
    await guarded("rpc hosts agree on one final block", async () => {
      block = await cross.finalBlock();
      return result("rpc hosts agree on one final block", true, `both hosts serve block ${block.height} ${block.hash}`);
    }),
    await checkChain({ rpc: cross, dep, expected: RELEASE_NETWORK }),
    ...(await checkCodeHashes({ rpc: cross, dep, wasmDir })),
    await checkDrillCode({ rpc: cross, dep, drillWasmDir }),
    await checkDrillVaultCode({ rpc: cross, dep, drillWasmDir }),
    await checkOmens({ rpc: cross, dep }),
    preLock ? await checkKeysBeforeLock({ rpc: cross, dep }) : await checkNoAccessKeys({ rpc: cross, dep }),
    await checkBounty({ rpc: cross, dep }),
    await checkNothingOwed({ rpc: cross, dep }),
    await checkDeployerKeyOnReference({ rpc: cross, dep }),
    ...(await checkFireTests({ rpc: cross, archival: archive, dir: fireTestDir, dep })),
  );
  const missing = missingChecks(results, stage);
  results.push(result(COMPLETE_CHECK, missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : `${results.length} checks ran`));

  let kizashiCodeHash = null;
  try {
    kizashiCodeHash = (await cross.account(dep.kizashi))?.code_hash ?? null;
  } catch {
    // The code hash check already failed for the same reason.
  }
  const gate = {
    kind: GATE_KIND,
    version: 1,
    createdAt: now().toISOString(),
    network: RELEASE_NETWORK,
    stage,
    kizashi: dep.kizashi,
    kizashiCodeHash,
    block,
    hosts: hosts ?? null,
    ok: results.every((r) => r.ok) && block !== null && kizashiCodeHash !== null,
    checks: results,
  };
  return { results, gate };
}

/** Writes the gate under a timestamped name, and returns the path. Failing gates are written too, as evidence. */
export function writeGate(dir, gate) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `release-gate-${gate.createdAt.replaceAll(":", "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(gate, null, 2));
  return file;
}

/** Whether `mainnet lock` may rely on this gate: fresh, complete, every check passing, this Kizashi, before the lock. */
export function validateGate({ gate, dep, now = new Date(), maxAgeMs = MAX_GATE_AGE_MS, stage = "pre-lock" }) {
  if (!gate || gate.kind !== GATE_KIND || gate.version !== 1) return { ok: false, problems: ["not a KAIGEN release gate file"] };
  const problems = [];
  if (gate.stage !== stage) problems.push(`the gate is a ${gate.stage} gate, the lock needs a ${stage} gate (verify --release --pre-lock)`);
  if (gate.network !== RELEASE_NETWORK) problems.push(`the gate was made for ${gate.network}, not ${RELEASE_NETWORK}`);
  if (gate.kizashi !== dep.kizashi) problems.push(`the gate is for ${gate.kizashi}, not ${dep.kizashi}`);
  if (gate.ok !== true) problems.push("the gate says the verification did not pass");
  if (typeof gate.kizashiCodeHash !== "string") problems.push("the gate has no Kizashi code hash");
  const made = Date.parse(gate.createdAt);
  if (Number.isNaN(made)) problems.push("the gate's createdAt is missing or not a date");
  else if (now.getTime() - made > maxAgeMs) problems.push(`the gate is older than 24 hours (made ${gate.createdAt})`);
  else if (made - now.getTime() > GATE_CLOCK_SKEW_MS) problems.push(`the gate's createdAt ${gate.createdAt} is in the future`);
  const checks = Array.isArray(gate.checks) ? gate.checks : [];
  for (const c of checks) if (c?.ok !== true) problems.push(`the gate has a failed check: ${c?.name}`);
  const missing = missingChecks(checks, stage);
  if (!checks.some((c) => c?.name === COMPLETE_CHECK)) missing.push(COMPLETE_CHECK);
  if (missing.length) problems.push(`the gate is missing required check(s): ${missing.join(", ")}`);
  return { ok: problems.length === 0, problems };
}
