// stretchdrill: the stretch items of docs/v3/STRETCH-DESIGN.md (the safe account, sweep_to_safe, the policy-key split) exercised
// on a REAL chain, against the existing DRILL rehearsal vault (delay 10 s) that KAIGEN_TESTNET_DIR/state.json names. Until now
// they ran in unit tests only.
//
//   1 safe     the vault's ML-DSA admin sets the safe account (default: the rehearsal's supplier; never the vault), waits the
//              withdrawal delay, and attest() shows it in force
//   2 sweep    a daily key queues a small NEAR request (the funder tops the vault up if it is short); the admin calls
//              sweep_to_safe; the chain shows the value moved ONLY to the safe account, the vault fell by that amount (plus
//              the gas it paid as signer) and the sweep event is in the logs
//   3 refuse   a stranger, a daily key, and "safe account = the vault" are each refused; nothing moved
//   4 policy   set_policy_account, a propose_* that apply runs after its wait (and refuses before it), another proposal
//              cancelled by cancel_proposal; attest() read after each
//   5 cage     cage-check against the vault, rows printed. A drill vault is RED on ATTEST-2 by design (drill build, delay < 24 h).
//   6 watcher  (stretchext.mjs) add_watcher, set_emergency, a watcher's sweep inside the window, refused outside it / for anything else
//   7 proposals the other three propose_* methods, applied after the wait, effects read back
//   8 ft       a NEP-141 sweep with the ft-mock fixture, and a failed transfer (sweep_failed, nothing lost)
//   The policy actor (step 4), the watcher and the token are sub-accounts of the funder, each with its own key in KAIGEN_TESTNET_DIR.
//
// DRY RUN BY DEFAULT: without `yes` this only reads the chain and prints the plan and the preflight. Nothing here signs: the
// senders are handed in (bin.mjs builds them from globaltx.mjs / chain.mjs), so a test drives the whole path with fakes.
// Testnet only: a node or a state file that says mainnet is refused. Secrets are never printed: output carries account ids,
// public keys, amounts and transaction hashes only.
import { cageCheck, DEFAULT_MAX_ALLOWANCE_YOCTO, exitCodeOf, IDS, renderCage } from "./cage.mjs";
import { formatNear, GlobalUsage, isAccountId, Refused, TESTNET_RPC } from "./globalcontract.mjs";
import { chainCheck } from "./prodvault.mjs";
import { ensureActor, extPlan, extPreflight, EXT_STEPS, runFt, runProposals, runWatcher } from "./stretchext.mjs";
import { bal, call, check, executorsOf, freeYocto, gasBurntOf, logsOf, message, NEAR, refusalOf, SECRET_FREE } from "./stretchkit.mjs";
import { report } from "./verify.mjs";

export { refusalOf };

/** The request that gets swept: small, far under the pending limit (1 NEAR daily limit x its multiple). */
export const SWEEP_YOCTO = NEAR / 100n;
/** What the vault must hold beyond its code's storage and the sweep: it signs every admin transaction and pays their gas. */
export const VAULT_WORKING_YOCTO = (NEAR * 15n) / 100n;
/** Gas the vault, as signer, may burn across the sweep (60 Tgas prepaid is about 0.006 NEAR; the rest is refunded). */
export const SWEEP_GAS_SLACK_YOCTO = NEAR / 20n;
const TGAS_SWEEP = 60;
/** A daily key's refusal: the chain's access-key layer (before the contract runs) or the contract's own gate. */
export const ACCESS_KEY_REFUSAL_OR_CONTRACT = /MethodNameMismatch|method name|not permitted|not allowed|signer key|AccessKey|panicked|admin or watcher only/i;
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the plan ----------------------------------------------------------------------------------------------------

/** Pure: what the run would do, from the state file and the options. */
export function planStretchDrill({ state, safe, recipient = "stretchdrill-<8 hex>.testnet", funderId, existingActors }) {
  if (state?.network !== "testnet") throw new Refused(`the rehearsal state says network ${JSON.stringify(state?.network)}: stretchdrill is testnet only`);
  for (const k of ["vault", "supplier", "kizashi"]) if (!isAccountId(state[k])) throw new Refused(`state.json has no usable ${k}`);
  for (const k of ["vault", "supplier", "kizashi"]) if (/(^|\.)near$/.test(state[k])) throw new Refused(`${state[k]} looks like a mainnet account: stretchdrill is testnet only`);
  if (!state.keeper?.id || !state.keeper?.privateKey) throw new Refused("state.json has no keeper (the stranger / policy account of this drill)");
  if (!state.daily?.publicKey || !state.daily?.privateKey) throw new Refused("state.json has no daily key");
  const safeId = safe ?? state.supplier;
  if (!isAccountId(safeId)) throw new GlobalUsage(`--safe ${JSON.stringify(safeId)} is not a NEAR account id`);
  if (safeId === state.vault) throw new Refused("the safe account must not be the vault itself (the contract refuses it too)");
  if (safeId === state.keeper.id) throw new Refused("the safe account must not be the keeper: the keeper pays gas in the refusal steps, so the sweep's balance check would not be exact");
  const payee = [state.kizashi, state.supplier].find((a) => a !== safeId) ?? null;
  // The policy actor, the watcher and the token fixture are sub-accounts of the funder, each with its own key: custody of the policy key is
  // shown as distinct from the stranger (the keeper).
  const actors = extPlan({ funderId, existing: existingActors });
  return {
    vault: state.vault,
    safe: safeId,
    stranger: state.keeper.id,
    policy: actors.policy.id,
    funderId,
    actors,
    payee,
    recipient,
    sweepYocto: SWEEP_YOCTO,
    steps: [
      { n: 1, id: "safe", title: `admin sets the safe account to ${safeId}, waits the withdrawal delay, attest() shows it in force` },
      { n: 2, id: "sweep", title: `a daily key queues ${formatNear(SWEEP_YOCTO)} NEAR (payee ${payee}), the admin calls sweep_to_safe: value moves only to ${safeId}` },
      { n: 3, id: "refuse", title: `refused: ${state.keeper.id} (a stranger) and the daily key calling sweep_to_safe; set_safe_account(vault)` },
      { n: 4, id: "policy", title: `set_policy_account(${actors.policy.id}, its own key); the keeper proposing is refused; propose_allow_recipient applied after its wait (refused before it); a second proposal cancelled` },
      { n: 5, id: "cage", title: "cage-check against the vault, rows printed (a drill vault is RED on ATTEST-2 by design; runs last)" },
      ...EXT_STEPS(actors, safeId),
    ],
  };
}

// ---- reads -------------------------------------------------------------------------------------------------------

/** Read-only. Never throws for a failed read: that is a failed check. */
export async function preflight({ rpc, plan, state, adminHandle, io, expectedChain = "testnet" }) {
  const checks = [];
  const guarded = async (name, fn) => {
    try {
      checks.push(await fn());
    } catch (e) {
      checks.push(check(name, false, `could not check: ${SECRET_FREE(message(e))}`));
    }
  };
  await guarded("chain is the one asked for, and is not mainnet", async () => chainCheck(await rpc.status(), expectedChain));
  let attest = null;
  await guarded("the vault answers attest() and carries the stretch items", async () => {
    attest = await rpc.view(plan.vault, "attest");
    const has = attest && "safe_account" in attest && "policy_account" in attest && "proposals" in attest;
    return check("the vault answers attest() and carries the stretch items", has, has ? `drill_build ${attest.drill_build}, delay ${attest.config?.delay_secs} s, queue_len ${attest.queue_len}` : "attest() has no safe_account / policy_account / proposals: this vault runs code from before the stretch items");
  });
  await guarded("the vault is calm", async () => check("the vault is calm", attest?.config?.era === "Calm", `era ${attest?.config?.era}`));
  await guarded("the vault's delay is short enough for a drill", async () => {
    const d = Number(attest?.config?.delay_secs);
    return check("the vault's delay is short enough for a drill", Number.isFinite(d) && d <= 60, `delay_secs ${d} (the run waits it out several times)`);
  });
  await guarded("the admin seed on file is a full-access key of the vault", async () => {
    const keys = (await rpc.accessKeys(plan.vault)) ?? [];
    const ok = !!adminHandle && keys.some((k) => k.public_key === adminHandle && k.access_key?.permission === "FullAccess");
    return check("the admin seed on file is a full-access key of the vault", ok, adminHandle ? `${adminHandle} ${ok ? "is" : "is NOT"} a full-access key of ${plan.vault}` : "no admin seed for this vault");
  });
  await guarded("the daily key is recorded by the vault", async () => {
    const daily = await rpc.view(plan.vault, "daily_keys");
    return check("the daily key is recorded by the vault", Array.isArray(daily) && daily.includes(state.daily.publicKey), `daily_keys() lists ${Array.isArray(daily) ? daily.length : "?"} key(s)`);
  });
  await guarded("the pending limit holds the sweep request", async () => {
    const lim = BigInt(await rpc.view(plan.vault, "pending_limit", { token: null }));
    return check("the pending limit holds the sweep request", lim >= plan.sweepYocto, `pending limit ${formatNear(lim)} NEAR, request ${formatNear(plan.sweepYocto)} NEAR`);
  });
  for (const [role, id] of [["safe", plan.safe], ["stranger (keeper)", plan.stranger], ["payee", plan.payee]]) {
    if (!id) continue;
    await guarded(`the ${role} account exists`, async () => check(`the ${role} account exists`, (await rpc.account(id)) !== null, id));
  }
  await guarded("the vault's free balance (information)", async () => {
    const acc = await rpc.account(plan.vault);
    const free = freeYocto(acc);
    const need = plan.sweepYocto + VAULT_WORKING_YOCTO;
    return check("the vault's free balance (information)", true, `${formatNear(free)} NEAR free beyond storage, ${formatNear(need)} NEAR needed${free < need ? `: the funder will top it up by ${formatNear(need - free)} NEAR` : ""}`);
  });
  const free0 = await rpc.account(plan.vault).then(freeYocto, () => 0n);
  const need0 = plan.sweepYocto + VAULT_WORKING_YOCTO;
  checks.push(...(await extPreflight({ rpc, plan, io, vaultTopUp: free0 < need0 ? need0 - free0 : 0n })));
  return { checks, ok: checks.every((c) => c.ok), attest };
}

// ---- the run -----------------------------------------------------------------------------------------------------

/**
 * Dry run unless `yes`. `io`:
 *   rpc                         status, account, accessKeys, view(contract, method, args)
 *   admin(actions)              -> { hash, outcome }  the vault's ML-DSA admin signs, receiver = the vault
 *   keeper(actions)             -> { hash, outcome }  the keeper (a classical full-access key of an unrelated account) signs
 *   daily(method, args)         -> { ok, hash, error }  the vault's daily (function-call) key signs
 *   fund(yocto)                 -> { hash } | null    the funder sends the vault NEAR, or null when there is no funder
 *   nowNs()                     -> bigint             final block time, ns
 *   receiptNs(outcome)          -> bigint | undefined  block time (ns) the vault's receipt of a sent transaction ran at
 *   adminHandle                 the admin key as the chain lists it
 */
export async function runStretchDrill({ plan, state, io, yes = false, expectedChain = "testnet", wasmHash = null, cage = cageCheck, sleep = sleepReal, log = () => {} }) {
  const pre = await preflight({ rpc: io.rpc, plan, state, adminHandle: io.adminHandle, io, expectedChain });
  if (!yes) return { dryRun: true, plan, pre };
  if (!pre.ok) throw new Refused(`preflight failed, nothing was sent:\n${report(pre.checks).text}`);

  const { rpc } = io;
  const { vault } = plan;
  const until = async (fn, { tries = 40, ms = 1500 } = {}) => {
    for (let i = 0; i < tries; i++) {
      const v = await fn();
      if (v) return v;
      await sleep(ms);
    }
    return null;
  };
  const waitNs = (target) => until(async () => (await io.nowNs()) >= target, { tries: 80, ms: 1000 });
  const attest = () => rpc.view(vault, "attest");
  const admin = (method, args, gas) => io.admin([call(method, args, gas)]);
  const keeper = (method, args, gas, receiver) => io.keeper([call(method, args, gas)], receiver);
  const asPolicy = (method, args, gas) => io.asActor("policy", vault, [call(method, args, gas)]);
  const refused = async (fn, re) => {
    try {
      await fn();
    } catch (e) {
      const r = refusalOf(e);
      return { refused: true, matches: re.test(r.raw), ...r };
    }
    return { refused: false };
  };
  const refusalCheck = (name, r, expected) =>
    check(name, r.refused && r.matches, r.refused ? `refused${r.text ? `: "${r.text}"` : ` (${r.raw.slice(0, 120)})`}${r.matches ? "" : `; expected ${expected}`}` : "NOT refused: the call went through", r.tx);

  const results = [];
  let dead = false;
  const state_ = { queueId: null, payee: null };
  // `needs` marks a step as independent of the cascade: it runs unless a step it really depends on did not pass, and its own failure
  // does not stop the others (steps 6 to 8 are reported separately).
  const runStep = async (s, fn, { needs = null } = {}) => {
    const out = { n: s.n, id: s.id, title: s.title, checks: [] };
    results.push(out);
    const blocked = needs ? needs.some((id) => !results.find((r) => r.id === id)?.ok) : dead && s.id !== "cage";
    if (blocked) {
      out.skipped = true;
      out.ok = false;
      return;
    }
    try {
      const rest = await fn(out.checks);
      if (Array.isArray(rest)) out.checks.push(...rest);
    } catch (e) {
      out.checks.push(check("step ran to the end", false, SECRET_FREE(message(e))));
    }
    out.ok = out.checks.length > 0 && out.checks.every((c) => c.ok);
    out.txs = out.checks.map((c) => c.tx).filter(Boolean);
    if (!out.ok && !needs) dead = true;
    log({ step: s.id, ok: out.ok, txs: out.txs });
  };
  const step = (id) => plan.steps.find((s) => s.id === id);
  const ctx = { plan, io, rpc, vault, attest, admin, keeper, until, waitNs, refused, refusalCheck, sleep, results };

  // 1 safe account
  await runStep(step("safe"), async (cs) => {
    const cur = (await attest()).safe_account;
    if (cur?.current === plan.safe && !cur.pending) {
      // Resumed: an earlier run (or this one, interrupted) already put it in force. Setting it again would only restart the wait.
      cs.push(check("the safe account is already in force (resumed run), nothing to set", true, `attest() shows current ${cur.current}, nothing pending`));
      return;
    }
    let a0 = cur;
    if (cur?.pending?.account === plan.safe) {
      cs.push(check("the safe account change is already waiting (resumed run)", true, `pending ${cur.pending.account}, effective_at ${cur.pending.effective_at}`));
    } else {
      const set = await admin("set_safe_account", { account: plan.safe });
      a0 = (await attest()).safe_account;
      cs.push(check("set_safe_account is accepted and attest() shows it waiting", a0?.pending?.account === plan.safe, `pending ${a0?.pending?.account ?? "none"}, effective_at ${a0?.pending?.effective_at ?? "?"}`, set.hash));
    }
    if (!a0?.pending) return;
    const reached = await waitNs(BigInt(a0.pending.effective_at));
    const now = await until(async () => ((await attest()).safe_account?.current === plan.safe ? await attest() : null));
    cs.push(check("after the delay attest() shows it in force, nothing pending", !!reached && now?.safe_account?.current === plan.safe && now.safe_account.pending === null, `current ${now?.safe_account?.current ?? "none"}, pending ${JSON.stringify(now?.safe_account?.pending ?? null)}`));
    return;
  });

  // 2 sweep
  let sweepBalances = null;
  await runStep(step("sweep"), async (cs) => {
    const accVault = await rpc.account(vault);
    const need = plan.sweepYocto + VAULT_WORKING_YOCTO;
    const free = freeYocto(accVault);
    if (free < need) {
      if (!io.fund) {
        cs.push(check("the vault holds enough NEAR", false, `free ${formatNear(free)} NEAR, needs ${formatNear(need)}; give --funder-file to top it up`));
        return;
      }
      const top = need - free;
      const f = await io.fund(top);
      const ok = !!(await until(async () => freeYocto(await rpc.account(vault)) >= need, { tries: 20 }));
      cs.push(check(`the funder topped the vault up by ${formatNear(top)} NEAR`, ok, ok ? "vault free balance now covers the sweep" : "balance did not rise", f.hash));
      if (!ok) return;
    }
    const nowNs = await io.nowNs();
    const live = (q) => q.token == null && BigInt(q.amount) === plan.sweepYocto && (q.expires_at === undefined || BigInt(q.expires_at) > nowNs + 60n * 10n ** 9n);
    const before = await rpc.view(vault, "queue");
    let queued = before.find(live);
    if (queued) {
      cs.push(check("a live NEAR request of the right size is already queued (resumed run): reused", true, `request ${queued.id}, ${formatNear(BigInt(queued.amount))} NEAR to ${queued.to}`));
    } else {
      const ids = before.map((q) => String(q.id));
      const req = await io.daily("request_withdraw", { token: null, amount: plan.sweepYocto.toString(), to: plan.payee });
      if (!req.ok) {
        cs.push(check("the daily key queues the request", false, SECRET_FREE(req.error ?? "failed")));
        return;
      }
      queued = (await rpc.view(vault, "queue")).find((q) => !ids.includes(String(q.id)));
      cs.push(check("the daily key queues the request", !!queued && BigInt(queued.amount) === plan.sweepYocto, queued ? `request ${queued.id}, ${formatNear(BigInt(queued.amount))} NEAR to ${queued.to}` : "no new queue entry", req.hash));
    }
    if (!queued) return;
    state_.queueId = String(queued.id);
    state_.payee = queued.to === plan.safe ? null : queued.to;

    // The refusals of step 3 run between the request and the sweep: they need a live request to try on.
    sweepBalances = { vault: bal(await rpc.account(vault)), safe: bal(await rpc.account(plan.safe)), payee: state_.payee ? bal(await rpc.account(state_.payee)) : null };
    return;
  });

  // 3 refusals, with the request still queued
  await runStep(step("refuse"), async (cs) => {
    const id = state_.queueId;
    const queueHas = async () => (await rpc.view(vault, "queue")).some((q) => String(q.id) === id);
    const safeBefore = bal(await rpc.account(plan.safe));
    const stranger = await refused(() => keeper("sweep_to_safe", { id }), /admin or watcher only/);
    cs.push(refusalCheck(`a stranger (${plan.stranger}) calling sweep_to_safe is refused`, stranger, "\"admin or watcher only\""));
    const daily = await refused(async () => {
      const r = await io.daily("sweep_to_safe", { id });
      if (r.ok) return;
      throw new Error(r.error);
    }, ACCESS_KEY_REFUSAL_OR_CONTRACT);
    const layer = !daily.refused ? null : /admin or watcher only|panicked/i.test(daily.raw) ? "the contract" : "the access key's permission, before the contract ran";
    cs.push(refusalCheck(`a daily key calling sweep_to_safe is refused${layer ? ` (by ${layer})` : ""}`, daily, "an access-key permission rejection (the key may call send_small and request_withdraw only) or a contract refusal"));
    const toVault = await refused(() => admin("set_safe_account", { account: vault }), /cannot be the vault itself/);
    cs.push(refusalCheck("set_safe_account(the vault itself) is refused", toVault, "\"the safe account cannot be the vault itself\""));
    const safeAfter = bal(await rpc.account(plan.safe));
    cs.push(check("nothing moved and the request is still queued", (await queueHas()) && safeAfter === safeBefore, `request ${id} ${(await queueHas()) ? "still queued" : "GONE"}, safe balance ${safeAfter === safeBefore ? "unchanged" : "CHANGED"}`));
    const a = (await attest()).safe_account;
    cs.push(check("attest() still shows the safe account in force, nothing pending", a?.current === plan.safe && a.pending === null, `current ${a?.current ?? "none"}, pending ${JSON.stringify(a?.pending ?? null)}`));
    return;
  });

  // 2 (second half): the sweep itself, after the refusals proved the request survives them
  const sweepStep = results.find((r) => r.id === "sweep");
  if (!dead && sweepStep.ok) {
    const cs = [];
    try {
      const id = state_.queueId;
      const swept = await admin("sweep_to_safe", { id }, TGAS_SWEEP);
      cs.push(check("the admin's sweep_to_safe is accepted", true, `request ${id}`, swept.hash));
      ctx.sweepGasBurnt = gasBurntOf(swept.outcome) || null;
      const logs = logsOf(swept.outcome).join("\n");
      cs.at(-1).evidence = [`sweep tx ${swept.hash}`, `gas burnt by the whole sweep tx: ${(Number(ctx.sweepGasBurnt ?? 0n) / 1e12).toFixed(2)} Tgas (attached ${TGAS_SWEEP} Tgas)`, ...logsOf(swept.outcome).map((l) => `log: ${SECRET_FREE(l).slice(0, 400)}`)];
      const event = /sweep_to_safe/.test(logs) && logs.includes(plan.safe);
      cs.push(check("the sweep event is in the logs, naming the safe account", event, event ? "EVENT sweep_to_safe found" : "no sweep_to_safe event naming the safe account in the transaction's logs"));
      cs.push(check("no sweep_failed in the logs", !/sweep_failed/.test(logs), /sweep_failed/.test(logs) ? "the transfer FAILED" : "none"));
      const executors = executorsOf(swept.outcome);
      const stray = [...executors].filter((e) => e !== vault && e !== plan.safe);
      cs.push(check("every receipt ran on the vault or the safe account only", stray.length === 0 && !(state_.payee && executors.has(state_.payee)), `executors: ${[...executors].join(", ")}`));
      const got = await until(async () => {
        const s = bal(await rpc.account(plan.safe));
        return s - sweepBalances.safe >= plan.sweepYocto ? s : null;
      });
      const safeNow = bal(await rpc.account(plan.safe));
      const vaultNow0 = bal(await rpc.account(vault));
      const evid = [`vault balance before ${sweepBalances.vault} yocto, after ${vaultNow0} yocto`, `safe account ${plan.safe} before ${sweepBalances.safe} yocto, after ${safeNow} yocto`];
      cs.push(check("the safe account received exactly the amount", got !== null && safeNow - sweepBalances.safe === plan.sweepYocto, `${formatNear(safeNow - sweepBalances.safe)} NEAR received, ${formatNear(plan.sweepYocto)} NEAR swept`));
      cs.at(-1).evidence = evid;
      const vaultNow = bal(await rpc.account(vault));
      const fell = sweepBalances.vault - vaultNow;
      cs.push(check("the vault fell by the amount (plus the gas it paid as signer)", fell >= plan.sweepYocto && fell <= plan.sweepYocto + SWEEP_GAS_SLACK_YOCTO, `fell ${formatNear(fell, 6)} NEAR, amount ${formatNear(plan.sweepYocto)} NEAR, gas share ${formatNear(fell - plan.sweepYocto, 6)} NEAR`));
      if (state_.payee) {
        const payeeNow = bal(await rpc.account(state_.payee));
        cs.push(check("the request's own payee received nothing", payeeNow === sweepBalances.payee, `${state_.payee} balance ${payeeNow === sweepBalances.payee ? "unchanged" : "CHANGED"}`));
      }
      const gone = !(await rpc.view(vault, "queue")).some((q) => String(q.id) === id);
      cs.push(check("the request left the queue", gone, gone ? `request ${id} gone` : `request ${id} STILL queued`));
    } catch (e) {
      cs.push(check("sweep ran to the end", false, SECRET_FREE(message(e))));
    }
    sweepStep.checks.push(...cs);
    sweepStep.ok = sweepStep.checks.every((c) => c.ok);
    sweepStep.txs = sweepStep.checks.map((c) => c.tx).filter(Boolean);
    if (!sweepStep.ok) dead = true;
  }

  // 4 policy
  await runStep(step("policy"), async (cs) => {
    if (!(await ensureActor(ctx, "policy", cs))) return;
    const polKey = io.actorKey("policy");
    cs.push(check("the policy account's key is not the keeper's (the stranger's)", !io.keeperPublicKey || polKey.publicKey !== io.keeperPublicKey, `policy account ${plan.policy} holds ${polKey.publicKey}${io.keeperPublicKey ? `, keeper ${plan.stranger} holds ${io.keeperPublicKey}` : ""}`));
    if ((await attest()).policy_account === plan.policy) {
      cs.push(check("the policy account is already set (resumed run)", true, `policy_account ${plan.policy}`));
    } else {
      const set = await admin("set_policy_account", { account: plan.policy });
      const a = await attest();
      cs.push(check("set_policy_account is accepted and attest() shows it", a.policy_account === plan.policy, `policy_account ${a.policy_account}`, set.hash));
    }
    const imposter = await refused(() => keeper("propose_allow_recipient", { account: plan.recipient }), /policy account only/);
    cs.push(refusalCheck(`the keeper (${plan.stranger}) proposing is refused: it is not the policy account`, imposter, "\"policy account only\""));
    const known = () => attest().then((x) => x.proposals.map((p) => String(p.id)));
    const newest = async (beforeIds) => (await attest()).proposals.find((p) => !beforeIds.includes(String(p.id)));

    let ids = await known();
    const p1 = await asPolicy("propose_allow_recipient", { account: plan.recipient });
    const one = await newest(ids);
    cs.push(check("propose_allow_recipient by the policy account is queued, nothing changed yet", !!one && BigInt(one.executable_at) > BigInt(one.proposed_at), one ? `proposal ${one.id}, runs from ${one.executable_at}` : "no new proposal in attest()", p1.hash));
    if (!one) return;
    const listedEarly = (await rpc.view(vault, "allowlist")).accounts.includes(plan.recipient);
    cs.push(check("the recipient is not on the allowlist before apply", !listedEarly, listedEarly ? "ALREADY listed" : "not listed"));

    // The early apply goes FIRST, straight after the proposal: the delay is seconds and every transaction takes several, so trying
    // it later finds the delay already over. Whether it was early is decided by the block time its receipt ran at against the
    // proposal's own runs-from time: a refusal is expected only if the apply really ran before it; one that ran at or after it
    // is legitimate (the chain is slower than the delay); one that SUCCEEDED before it would be a contract bug and fails the step.
    const exec = BigInt(one.executable_at);
    let earlyRes = null;
    const early = await refused(async () => {
      earlyRes = await keeper("apply", { id: String(one.id) });
    }, /still locked/);
    let appliedEarly = false;
    if (early.refused) {
      cs.push(refusalCheck("apply before the delay is refused", early, "\"still locked\""));
      if (!early.matches) return;
    } else {
      const ranAt = (io.receiptNs ? await io.receiptNs(earlyRes.outcome) : undefined) ?? (await io.nowNs());
      if (ranAt < exec) {
        cs.push(check("apply before the delay is refused", false, `NOT refused: it ran at chain time ${ranAt} ns, BEFORE the proposal's runs-from ${exec} ns (proposed ${one.proposed_at}): a contract bug, not a test-order slip`, earlyRes.hash));
        return;
      }
      appliedEarly = true;
      cs.push(check("apply before the delay could not be tested: the delay was already over when it ran", true, `it ran at chain time ${ranAt} ns, at or after runs-from ${exec} ns: the chain is slower than the ${(exec - BigInt(one.proposed_at)) / 10n ** 9n} s delay, so the apply was legitimate`, earlyRes.hash));
    }

    ids = await known();
    const p2 = await asPolicy("propose_set_token_limit", { token: "stretchdrill-token.testnet", limit: "1000" });
    const two = await newest(ids);
    cs.push(check("a second proposal (propose_set_token_limit) is queued", !!two, two ? `proposal ${two.id}` : "no new proposal in attest()", p2.hash));
    if (!two) return;
    const cancelled = await admin("cancel_proposal", { id: String(two.id) });
    const afterCancel = (await attest()).proposals.map((p) => String(p.id));
    cs.push(check("cancel_proposal removes the second proposal", !afterCancel.includes(String(two.id)), `waiting: ${afterCancel.join(", ") || "none"}`, cancelled.hash));

    // Resumable: a proposal that is already gone (applied early, or by an earlier run) is not applied again.
    let applied = null;
    if ((await attest()).proposals.some((p) => String(p.id) === String(one.id))) {
      await waitNs(exec);
      applied = await keeper("apply", { id: String(one.id) });
    }
    const finalAttest = await attest();
    const listed = (await rpc.view(vault, "allowlist")).accounts.includes(plan.recipient);
    cs.push(check(`apply ${appliedEarly ? "(run early, legitimately)" : "after the delay"} runs it: the recipient is on the allowlist, the proposal is gone`, listed && !finalAttest.proposals.some((p) => String(p.id) === String(one.id)), `allowlist ${listed ? "lists" : "does NOT list"} ${plan.recipient}; ${finalAttest.proposals.length} proposal(s) waiting`, applied?.hash ?? null));
    return;
  });

  // 6 watcher, 7 the other propose_* methods, 8 a NEP-141 sweep
  await runStep(step("watcher"), (cs) => runWatcher(ctx, cs), { needs: ["safe"] });
  await runStep(step("proposals"), (cs) => runProposals(ctx, cs), { needs: ["policy"] });
  await runStep(step("ft"), (cs) => runFt(ctx, cs), { needs: ["safe"] });

  // 5 cage-check (last: it reads the vault after everything above)
  await runStep(step("cage"), async () => {
    const onChain = (await rpc.account(vault))?.code_hash;
    const pinned = wasmHash ?? onChain;
    const result = await cage({ rpc, account: vault, policy: { admin: io.adminHandle, pinnedCodeHash: pinned, maxAllowanceYocto: DEFAULT_MAX_ALLOWANCE_YOCTO, extraMethods: [] } });
    results.cage = result;
    const red = result.conditions.filter((c) => c.status === "RED").map((c) => c.id);
    const unexpected = red.filter((id) => id !== IDS.productionBuild);
    const drill = (await attest()).drill_build === true;
    const ok = unexpected.length === 0 && (drill ? red.includes(IDS.productionBuild) : true);
    return [check("cage-check ran; the only RED row is ATTEST-2 (a drill vault, by design)", ok, `verdict ${result.verdict}, exit ${exitCodeOf(result)}; RED: ${red.join(", ") || "none"}; code hash pinned to ${wasmHash ? "the given wasm" : "the vault's own on-chain hash (no wasm given)"}`)];
  });

  results.sort((a, b) => a.n - b.n);
  return { dryRun: false, plan, pre, results, cage: results.cage ?? null, ok: results.every((r) => r.ok) };
}

// ---- output ------------------------------------------------------------------------------------------------------

export function renderStretch(out) {
  const { plan } = out;
  const lines = [`stretchdrill on ${plan.vault} (safe account ${plan.safe}; stranger ${plan.stranger}; policy account ${plan.policy}; watcher ${plan.actors.watcher.id}; token ${plan.actors.token.id})`, "", "steps:", ...plan.steps.map((s) => `  ${s.n}. ${s.title}`), "", "preflight (read-only):", report(out.pre.checks).text];
  if (!out.dryRun) {
    lines.push("");
    for (const r of out.results) {
      lines.push(`${r.skipped ? "SKIP" : r.ok ? "PASS" : "FAIL"}  step ${r.n} ${r.id}  ${r.title}${r.txs?.length ? `  tx ${r.txs.join(" ")}` : ""}`);
      for (const c of r.checks) {
        lines.push(`        ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}${c.tx ? `  [tx ${c.tx}]` : ""}`);
        for (const e of c.evidence ?? []) lines.push(`              ${e}`);
      }
    }
    if (out.cage) lines.push("", renderCage(out.cage), "", "NOTE: this is a DRILL vault (drill build, delay of seconds), so cage-check is RED on ATTEST-2 by design; that is not a failure of the stretch items.");
    lines.push("", out.ok ? "RESULT: the stretch items worked on a real chain." : "RESULT: SOMETHING FAILED. See above; do not claim it works.");
  }
  lines.push("", "NOT COVERED:", ...NOT_COVERED.map((l) => `  - ${l}`));
  return lines.join("\n");
}

export const NOT_COVERED = [
  "a drill build with a delay of seconds on testnet: not the production 24 h delay, not mainnet, no audit",
  "the documented failure of an UNREGISTERED safe account: the ft-mock fixture has no storage_deposit, so the failed-transfer path (sweep_failed, request gone, value stays) was shown with an oversized request, the same code path, not with a real registration check",
  "a real NEP-141 token (storage registration, ft_transfer_call, real decimals): the fixture is a look-alike; also not run: a watcher's NEP-141 sweep and a sweep of an expired request",
  "key custody: the policy and watcher keys are files on this machine in the gitignored testnet folder; that shows they are distinct keys, not how a real owner holds them (hardware wallet, multisig)",
];

// ---- command line ------------------------------------------------------------------------------------------------

export const STRETCHDRILL_USAGE =
  "usage: kaigen-jobs stretchdrill [--safe <account>] [--funder-file <file>] [--wasm <file>] [--ft-wasm <file>] [--rpc <url>] [--yes]\n" +
  "  Testnet only. Dry run unless --yes: it reads the chain and prints the plan and the preflight; nothing is signed.\n" +
  "  Runs against the DRILL rehearsal vault named by KAIGEN_TESTNET_DIR/state.json, signed by its ML-DSA admin seed.\n" +
  "  --safe         the safe account (default: the rehearsal's supplier). Never the vault or the keeper\n" +
  "  --funder-file  JSON {\"account_id\",\"private_key\"}: creates the policy, watcher and token sub-accounts (<name>.<funder>), tops the vault up if short (default KAIGEN_FUNDER_FILE, then <dir>/funder.json)\n" +
  "  --ft-wasm      the NEP-141 look-alike fixture (default FT_MOCK_WASM, then D:/HACK-Projects/toolchain/w3-wasm/ft_mock.wasm); deployed only if its account does not exist yet\n" +
  "  --wasm         the drill wasm cage-check pins the code hash to (default out/drill/mamori.wasm if present, else the vault's own on-chain hash)\n" +
  "  --rpc          default https://rpc.testnet.fastnear.com. A node that says it is mainnet is refused";

/** `argv` is what follows `stretchdrill`. */
export function parseStretchArgs(argv, defaults = {}) {
  const valued = new Set(["--safe", "--funder-file", "--wasm", "--ft-wasm", "--rpc", "--chain-id"]);
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
  return { safe: seen["--safe"], funderFile: seen["--funder-file"] ?? defaults.funderFile, wasm: seen["--wasm"] ?? defaults.wasm, ftWasm: seen["--ft-wasm"] ?? defaults.ftWasm, rpc: seen["--rpc"] ?? TESTNET_RPC, chainId, yes };
}

