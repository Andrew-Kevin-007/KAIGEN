// stretchdrill, steps 6 to 8 (and the separate policy account of step 4): what stretchdrill.mjs did not cover on the first real run.
//
//   6 watcher    add_watcher, a watcher refused with no window open, set_emergency (at most 7 days), a watcher's sweep_to_safe
//                succeeding inside the window and the value going only to the safe account, a watcher calling anything else
//                refused, the window ending by itself and being closed by the admin
//   7 proposals  the three propose_* methods step 4 did not run (set_token_limit, set_pending_limit, add_daily_key), each applied
//                after its wait by a stranger (apply is permissionless), the effect read from the views and the chain
//   8 ft         a NEP-141 sweep with the look-alike fixture (ft_mock.wasm): minted to the vault, swept, ft_balance_of shows the
//                amount moved ONLY to the safe account; then an oversized request whose ft_transfer fails: sweep_failed, request gone,
//                nothing lost
//
// The policy actor, the watcher and the token are SUB-ACCOUNTS OF THE FUNDER (<name>.<funder>), each created with its own fresh key,
// saved by bin.mjs in the gitignored KAIGEN_TESTNET_DIR before any NEAR moves. Nothing here signs by itself: every sender comes in
// through `io`, exactly as in stretchdrill.mjs, so the whole path runs with fakes in a unit test.
import { formatNear, isAccountId, Refused } from "./globalcontract.mjs";
import { bal, call, check, executorsOf, freeYocto, logsOf, message, NEAR, refusalOf, SECRET_FREE } from "./stretchkit.mjs";


/**
 * What a signer must HOLD before a call: the chain checks balance >= gas attached x price before it runs the call, and refunds what is
 * unused. The first real run measured it: a watcher with 0.0393 NEAR was refused an sweep_to_safe with 60 Tgas attached, "cost 0.0609 NEAR",
 * i.e. about 0.001015 NEAR per attached Tgas (ten times the 1e8 yocto/gas the node quotes). So this prices gas at 1.1e9 yocto per unit.
 */
export const EFFECTIVE_GAS_PRICE_YOCTO = 1_100_000_000n;
/** What a call really burns is far less (the admin's whole sweep cost the vault 0.0007 NEAR); this is the allowance per call. */
export const BURN_PER_CALL_YOCTO = NEAR / 500n;
const roundUp = (y, step = NEAR / 1000n) => ((y + step - 1n) / step) * step;
/** The balance an account needs to make `calls` calls, the largest with `maxTgas` attached, plus a margin. */
export const fundForCalls = (maxTgas, calls) => roundUp(BigInt(maxTgas) * 10n ** 12n * EFFECTIVE_GAS_PRICE_YOCTO + BigInt(calls) * BURN_PER_CALL_YOCTO + NEAR / 100n);
/** Gas attached to a watcher's sweep: twice what the admin's sweep burnt plus the callback's 10 Tgas, between 30 and 60. */
export const watcherSweepTgas = (adminBurntGas) => {
  if (!adminBurntGas) return 30;
  const t = Number((BigInt(adminBurntGas) + 10n ** 12n - 1n) / 10n ** 12n) * 2 + 10;
  return Math.min(60, Math.max(30, t));
};
/** What each new account is funded with, as little as works: gas for its own transactions, and for the token its wasm's storage. */
export const ACTOR_FUND_YOCTO = { policy: fundForCalls(30, 6), watcher: fundForCalls(30, 9), token: (NEAR * 95n) / 100n };
/** A token account that exists is topped up only if its free balance (beyond storage) falls under this. */
export const TOKEN_MIN_FREE_YOCTO = NEAR / 50n;
/** Gas the funder pays for the creation transactions themselves. */
export const FUNDING_GAS_MARGIN_YOCTO = NEAR / 50n;
/** Two distinct NEAR requests for the watcher steps (a live request of the same size is reused on a rerun), neither the step 2 size. */
export const WATCH_REQUEST_1_YOCTO = (NEAR * 11n) / 1000n;
export const WATCH_REQUEST_2_YOCTO = (NEAR * 12n) / 1000n;
export const WATCH_WINDOW_SECS = 120;
export const MAX_EMERGENCY_SECS = 7 * 86_400;
/** Token units (the fixture's smallest unit). The pending limit also bounds what may be asked for in 24 h, so it leaves room for reruns. */
export const TOKEN_CAP = 100_000n;
export const FT_MINT_TO = 1_000n;
export const FT_SWEEP = 100n;
export const FT_OVERSIZED = 5_000n;
export const FT_DECIMALS = 24;
export const KEY_ALLOWANCE_YOCTO = NEAR / 20n;
export const FT_MOCK_BYTES = 90_531;
const TGAS_FT = 100;

/** How much an existing account must be topped up: policy and watcher to their funding, the token to a small free balance. */
export function topUpOf(role, acc, plan, minYocto) {
  const want = minYocto ?? (role === "token" ? TOKEN_MIN_FREE_YOCTO : plan.actors[role].fundYocto);
  const free = freeYocto(acc);
  return free < want ? want - free : 0n;
}

const ROLE_SHORT = { policy: "sd-policy", watcher: "sd-watcher", token: "sd-token" };

/** The three new accounts, as sub-accounts of the funder. */
export function extPlan({ funderId, existing = {} }) {
  if (!isAccountId(funderId)) throw new Refused("stretchdrill needs the funder (the policy, watcher and token accounts are its sub-accounts): give --funder-file");
  const mk = (role) => {
    // An account an earlier run created (named in the actors file) is reused whoever the funder is now.
    const id = existing[role] ?? `${ROLE_SHORT[role]}.${funderId}`;
    if (!isAccountId(id)) throw new Refused(`${id} is not a usable account id`);
    return { role, id, fundYocto: ACTOR_FUND_YOCTO[role] };
  };
  return { policy: mk("policy"), watcher: mk("watcher"), token: mk("token") };
}

export const EXT_STEPS = (actors, safeId) => [
  { n: 6, id: "watcher", title: `add_watcher(${actors.watcher.id}); refused with no window; set_emergency; its sweep_to_safe inside the window pays only ${safeId}; anything else refused; the window ends and is closed` },
  { n: 7, id: "proposals", title: "propose_set_token_limit, propose_set_pending_limit, propose_add_daily_key by the policy account, applied after the wait by a stranger; effects read back" },
  { n: 8, id: "ft", title: `NEP-141 sweep (${actors.token.id}, ft-mock): ft_balance_of shows the amount moved only to ${safeId}; an oversized request fails as sweep_failed and loses nothing` },
];

// ---- reads -------------------------------------------------------------------------------------------------------

/** Read-only. Funding: the total the missing accounts and a vault top-up need, against what the funder holds. */
export async function extPreflight({ rpc, plan, io, vaultTopUp = 0n }) {
  const checks = [];
  const guarded = async (name, fn) => {
    try {
      checks.push(await fn());
    } catch (e) {
      checks.push(check(name, false, `could not check: ${SECRET_FREE(message(e))}`));
    }
  };
  const exists = {};
  const topUp = {};
  for (const role of ["policy", "watcher", "token"]) {
    const a = plan.actors[role];
    await guarded(`the ${role} account (information)`, async () => {
      const acc = await rpc.account(a.id);
      exists[role] = acc !== null;
      topUp[role] = acc ? topUpOf(role, acc, plan) : 0n;
      return check(`the ${role} account (information)`, true, `${a.id} ${acc ? `exists (reused), ${formatNear(freeYocto(acc), 3)} NEAR free${topUp[role] > 0n ? `, topped up by ${formatNear(topUp[role], 3)} NEAR` : ""}` : `will be created with ${formatNear(a.fundYocto, 3)} NEAR`}`);
    });
  }
  await guarded("the NEP-141 fixture wasm is readable (or the token already exists)", async () => {
    const have = io.ftWasm ? io.ftWasm.length : 0;
    return check("the NEP-141 fixture wasm is readable (or the token already exists)", have > 0 || exists.token === true, have > 0 ? `${have} bytes (expected ${FT_MOCK_BYTES})` : exists.token ? "not needed: the token account exists" : "no fixture wasm: give --ft-wasm");
  });
  await guarded("the funder holds the NEAR the new accounts need (total needed vs available)", async () => {
    const parts = [];
    let need = 0n;
    for (const role of ["policy", "watcher", "token"]) {
      const own = exists[role] === false ? plan.actors[role].fundYocto : (topUp[role] ?? 0n);
      if (own > 0n) {
        need += own;
        parts.push(`${role} ${formatNear(own, 3)}${exists[role] ? " top-up" : ""}`);
      }
    }
    if (vaultTopUp > 0n) {
      need += vaultTopUp;
      parts.push(`vault top-up ${formatNear(vaultTopUp, 3)}`);
    }
    if (need > 0n) {
      need += FUNDING_GAS_MARGIN_YOCTO;
      parts.push(`gas margin ${formatNear(FUNDING_GAS_MARGIN_YOCTO, 3)}`);
    }
    const name = "the funder holds the NEAR the new accounts need (total needed vs available)";
    if (need === 0n) return check(name, true, "needed 0 NEAR: every account exists and the vault is funded");
    const acc = await rpc.account(plan.funderId);
    const free = acc ? freeYocto(acc) : 0n;
    return check(name, free >= need, `needed ${formatNear(need, 3)} NEAR (${parts.join(", ")}) vs available ${formatNear(free, 3)} NEAR on ${plan.funderId}${free >= need ? "" : `: SHORT by ${formatNear(need - free, 3)} NEAR`}`);
  });
  return checks;
}

// ---- helpers for the steps ----------------------------------------------------------------------------------------

/**
 * The account of `role` exists with its own key. Created by the funder on the first run (the key is made and saved by `io.actorKey`
 * BEFORE any NEAR moves, so an interrupted run never loses it); reused, with its key checked, on a rerun.
 */
export async function ensureActor(ctx, role, cs, { minYocto } = {}) {
  const { plan, io, rpc } = ctx;
  const a = plan.actors[role];
  const key = io.actorKey(role);
  const acc = await rpc.account(a.id);
  if (acc) {
    const keys = (await rpc.accessKeys(a.id)) ?? [];
    const ours = keys.some((k) => k.public_key === key.publicKey && k.access_key?.permission === "FullAccess");
    cs.push(check(`the ${role} account ${a.id} exists (resumed run) and the key on file is its key`, ours, `${key.publicKey} ${ours ? "is" : "is NOT"} a full-access key of ${a.id}`));
    if (!ours) return false;
    // Reused, not recreated; topped up if the gas it will prepay has outgrown what it holds.
    const short = topUpOf(role, acc, plan, minYocto);
    if (short > 0n) {
      if (!io.funderSend) {
        cs.push(check(`the ${role} account is topped up`, false, `it is short by ${formatNear(short, 3)} NEAR and there is no funder: give --funder-file`));
        return false;
      }
      const t = await io.funderSend(a.id, [{ type: "Transfer", yocto: short }]);
      const now = await rpc.account(a.id);
      cs.push(check(`the funder topped ${a.id} up by ${formatNear(short, 3)} NEAR`, topUpOf(role, now, plan, minYocto) === 0n, `${formatNear(freeYocto(now), 4)} NEAR free now`, t.hash));
    }
    return true;
  }
  if (!io.funderSend) {
    cs.push(check(`the ${role} account ${a.id} is created`, false, `it does not exist and there is no funder: give --funder-file (it needs ${formatNear(a.fundYocto, 3)} NEAR)`));
    return false;
  }
  const actions = [{ type: "CreateAccount" }, { type: "Transfer", yocto: a.fundYocto }, { type: "AddKey", publicKey: key.publicKey }];
  if (role === "token") {
    if (!io.ftWasm) {
      cs.push(check("the NEP-141 fixture wasm is available", false, "give --ft-wasm"));
      return false;
    }
    actions.push({ type: "DeployContract", code: io.ftWasm }, call("new", { decimals: FT_DECIMALS }, 30));
  }
  const r = await io.funderSend(a.id, actions);
  const made = await rpc.account(a.id);
  const c = check(`the funder created ${a.id} with ${formatNear(a.fundYocto, 3)} NEAR and its own key ${key.publicKey}`, !!made, made ? `balance ${formatNear(BigInt(made.amount), 4)} NEAR, storage ${made.storage_usage} bytes` : "the account is not there", r.hash);
  cs.push(c);
  if (made && role === "token") {
    const dec = await rpc.view(a.id, "ft_decimals").catch(() => null);
    cs.push(check("the fixture is deployed and initialised: ft_decimals() answers", dec === FT_DECIMALS, `ft_decimals() = ${dec}`));
    return dec === FT_DECIMALS;
  }
  return !!made;
}

/** A NEAR (`token` null) or NEP-141 request of exactly `amount` queued by the daily key, or a live one of that size reused. */
async function queueRequest(ctx, { token, amount, to, label }) {
  const { io, rpc, vault } = ctx;
  const nowNs = await io.nowNs();
  const live = (q) => (q.token ?? null) === token && BigInt(q.amount) === amount && (q.expires_at === undefined || BigInt(q.expires_at) > nowNs + 60n * 10n ** 9n);
  const before = await rpc.view(vault, "queue");
  const found = before.find(live);
  const unit = token ? `${amount} token units` : `${formatNear(amount)} NEAR`;
  if (found) return { q: found, check: check(`${label}: a live request of ${unit} is already queued (resumed run): reused`, true, `request ${found.id} to ${found.to}`) };
  const ids = before.map((q) => String(q.id));
  const req = await io.daily("request_withdraw", { token, amount: amount.toString(), to });
  if (!req.ok) return { q: null, check: check(`${label}: the daily key queues ${unit}`, false, SECRET_FREE(req.error ?? "failed")) };
  const q = (await rpc.view(vault, "queue")).find((x) => !ids.includes(String(x.id)));
  return { q, check: check(`${label}: the daily key queues ${unit}`, !!q && BigInt(q.amount) === amount, q ? `request ${q.id} to ${q.to}` : "no new queue entry", req.hash) };
}

const eventIn = (logs, name) => logs.some((l) => l.includes(`"event":"${name}"`));

// ---- step 6: the watcher -------------------------------------------------------------------------------------------

export async function runWatcher(ctx, cs) {
  const { plan, io, rpc, vault, refused, refusalCheck, until, waitNs } = ctx;
  const w = plan.actors.watcher;
  const safe = plan.safe;
  const payee = plan.payee;
  const asWatcher = (method, args, gas) => io.asActor("watcher", vault, [call(method, args, gas)]);
  const emergency = async () => BigInt(await rpc.view(vault, "emergency_until"));
  const listed = async () => (await rpc.view(vault, "watchers")).includes(w.id);
  const inQueue = async (id) => (await rpc.view(vault, "queue")).some((q) => String(q.id) === String(id));
  const snap = async () => ({ vault: bal(await rpc.account(vault)), safe: bal(await rpc.account(safe)), payee: payee ? bal(await rpc.account(payee)) : null, watcher: bal(await rpc.account(w.id)) });

  // The gas attached to the watcher's sweep is measured from the admin's own sweep (step 2), with a margin, not a large fixed amount; the
  // watcher must hold that gas at the price the chain checks it at (fundForCalls), and is topped up if it holds less.
  const sweepTgas = watcherSweepTgas(ctx.sweepGasBurnt);
  if (!(await ensureActor(ctx, "watcher", cs, { minYocto: fundForCalls(sweepTgas, 9) }))) return;
  const s0 = (await ctx.attest()).safe_account;
  if (s0?.current !== safe) {
    cs.push(check("a safe account is in force", false, `attest() shows ${s0?.current ?? "none"}`));
    return;
  }

  // add_watcher
  if (await listed()) cs.push(check("the watcher is already registered (resumed run)", true, `watchers() lists ${w.id}`));
  else {
    const added = await ctx.admin("add_watcher", { account: w.id });
    cs.push(check("add_watcher is accepted and watchers() lists the account", await listed(), `watchers() = ${(await rpc.view(vault, "watchers")).join(", ")}`, added.hash));
  }
  cs.push(refusalCheck("add_watcher(the vault itself) is refused", await refused(() => ctx.admin("add_watcher", { account: vault }), /cannot be the vault itself/), "\"a watcher cannot be the vault itself\""));
  if ((await emergency()) > (await io.nowNs())) {
    const closed = await ctx.admin("set_emergency", { secs: 0 });
    cs.push(check("a window from an earlier run was still open: the admin closed it", (await emergency()) <= (await io.nowNs()), `emergency_until ${await emergency()}`, closed.hash));
  }

  const r1 = await queueRequest(ctx, { token: null, amount: WATCH_REQUEST_1_YOCTO, to: payee, label: "request 1" });
  cs.push(r1.check);
  const r2 = r1.q ? await queueRequest(ctx, { token: null, amount: WATCH_REQUEST_2_YOCTO, to: payee, label: "request 2" }) : null;
  if (r2) cs.push(r2.check);
  if (!r1.q || !r2?.q) return;
  const id1 = String(r1.q.id);
  const id2 = String(r2.q.id);

  // no window: refused
  cs.push(refusalCheck(`the watcher ${w.id} calling sweep_to_safe with NO window open is refused`, await refused(() => asWatcher("sweep_to_safe", { id: id1 }), /no emergency/), "\"no emergency: watchers can sweep only in a declared window\""));
  cs.push(refusalCheck(`set_emergency(${MAX_EMERGENCY_SECS + 1} s, over 7 days) is refused`, await refused(() => ctx.admin("set_emergency", { secs: MAX_EMERGENCY_SECS + 1 }), /at most 7 days/), "\"an emergency window lasts at most 7 days\""));

  // open a window
  const opened = await ctx.admin("set_emergency", { secs: WATCH_WINDOW_SECS });
  const until1 = await emergency();
  const t1 = await io.nowNs();
  const open = until1 > t1 && until1 <= t1 + BigInt(WATCH_WINDOW_SECS) * 10n ** 9n;
  cs.push(check(`set_emergency(${WATCH_WINDOW_SECS}) is accepted: emergency_until() is ahead, at most ${WATCH_WINDOW_SECS} s from now`, open, `emergency_until ${until1} ns, chain time ${t1} ns`, opened.hash));
  cs.at(-1).evidence = logsOf(opened.outcome).map((l) => `log: ${SECRET_FREE(l).slice(0, 300)}`);

  // inside the window the watcher still cannot do anything but sweep
  for (const [method, args] of [["set_safe_account", { account: w.id }], ["set_emergency", { secs: MAX_EMERGENCY_SECS }], ["cancel", { id: id2 }]]) {
    cs.push(refusalCheck(`the watcher calling ${method} (window open) is refused`, await refused(() => asWatcher(method, args), /admin only/), "\"admin only\""));
  }
  const s1 = (await ctx.attest()).safe_account;
  cs.push(check("nothing changed: same safe account, nothing pending, both requests queued, window unchanged", s1?.current === safe && s1.pending === null && (await inQueue(id1)) && (await inQueue(id2)) && (await emergency()) === until1, `safe ${s1?.current}, pending ${JSON.stringify(s1?.pending ?? null)}, emergency_until ${await emergency()}`));

  // the watcher's sweep, inside the window
  const before = await snap();
  const swept = await asWatcher("sweep_to_safe", { id: id1 }, sweepTgas);
  const logs = logsOf(swept.outcome);
  cs.push(check(`the watcher's sweep_to_safe is accepted inside the window`, true, `request ${id1}`, swept.hash));
  cs.at(-1).evidence = [`sweep tx ${swept.hash}`, `gas attached ${sweepTgas} Tgas (the admin's sweep burnt ${ctx.sweepGasBurnt ? (Number(ctx.sweepGasBurnt) / 1e12).toFixed(2) : "?"} Tgas; the watcher held at least ${formatNear(fundForCalls(sweepTgas, 9), 3)} NEAR)`, ...logs.map((l) => `log: ${SECRET_FREE(l).slice(0, 400)}`)];
  const text = logs.join("\n");
  cs.push(check("the sweep event names the watcher as the caller and the safe account as the destination", eventIn(logs, "sweep_to_safe") && text.includes(`"by":"${w.id}"`) && text.includes(`"safe":"${safe}"`), eventIn(logs, "sweep_to_safe") ? "EVENT sweep_to_safe found" : "no sweep_to_safe event"));
  cs.push(check("no sweep_failed in the logs", !eventIn(logs, "sweep_failed"), eventIn(logs, "sweep_failed") ? "the transfer FAILED" : "none"));
  const executors = executorsOf(swept.outcome);
  // The signer's own account legitimately appears: the transaction's first receipt and the gas refund execute there. What matters is where
  // the VALUE went, which the balance checks below assert.
  const stray = [...executors].filter((e) => e !== vault && e !== safe && e !== w.id);
  cs.push(check("every receipt ran on the vault, the safe account or the signing watcher only (no one else)", stray.length === 0 && !(payee && executors.has(payee)), `executors: ${[...executors].join(", ")}`));
  await until(async () => bal(await rpc.account(safe)) - before.safe >= WATCH_REQUEST_1_YOCTO);
  const after = await snap();
  cs.push(check("the safe account received exactly the amount", after.safe - before.safe === WATCH_REQUEST_1_YOCTO, `${formatNear(after.safe - before.safe, 6)} NEAR received, ${formatNear(WATCH_REQUEST_1_YOCTO, 6)} NEAR requested`));
  cs.at(-1).evidence = [`safe account ${safe} before ${before.safe} yocto, after ${after.safe} yocto`];
  const fell = before.vault - after.vault;
  cs.push(check("the vault fell by the amount (the watcher paid the gas, not the vault)", fell >= WATCH_REQUEST_1_YOCTO && fell <= WATCH_REQUEST_1_YOCTO + NEAR / 1000n, `fell ${formatNear(fell, 6)} NEAR, amount ${formatNear(WATCH_REQUEST_1_YOCTO, 6)} NEAR, extra ${formatNear(fell - WATCH_REQUEST_1_YOCTO, 6)} NEAR`));
  cs.at(-1).evidence = [`vault balance before ${before.vault} yocto, after ${after.vault} yocto`];
  cs.push(check("the signing watcher was not credited (it only paid gas)", after.watcher <= before.watcher, `${w.id} balance ${formatNear(before.watcher, 6)} -> ${formatNear(after.watcher, 6)} NEAR`));
  if (payee) cs.push(check("the request's own payee received nothing", after.payee === before.payee, `${payee} balance ${after.payee === before.payee ? "unchanged" : "CHANGED"}`));
  cs.push(check("the request left the queue; request 2 is untouched", !(await inQueue(id1)) && (await inQueue(id2)), `request ${id1} ${(await inQueue(id1)) ? "STILL queued" : "gone"}, request ${id2} ${(await inQueue(id2)) ? "queued" : "GONE"}`));

  // the window ends by itself
  const ended = await waitNs(until1);
  const outside = await refused(() => asWatcher("sweep_to_safe", { id: id2 }), /no emergency/);
  cs.push(refusalCheck(`the window ended by itself (emergency_until ${until1} ns passed): the watcher's sweep is refused`, { ...outside, refused: outside.refused && !!ended }, "\"no emergency\""));
  cs.push(check("request 2 survived the refused sweep", await inQueue(id2), `request ${id2} ${(await inQueue(id2)) ? "still queued" : "GONE"}`));

  // the admin closes a window (the longest one allowed)
  const longest = await ctx.admin("set_emergency", { secs: MAX_EMERGENCY_SECS });
  const until2 = await emergency();
  const t2 = await io.nowNs();
  cs.push(check("set_emergency(7 days, the most allowed) is accepted", until2 > t2 + BigInt(MAX_EMERGENCY_SECS - 600) * 10n ** 9n && until2 <= t2 + BigInt(MAX_EMERGENCY_SECS) * 10n ** 9n, `emergency_until ${until2} ns, chain time ${t2} ns`, longest.hash));
  const closed = await ctx.admin("set_emergency", { secs: 0 });
  cs.push(check("set_emergency(0) closes it: emergency_until() is 0", (await emergency()) === 0n, `emergency_until ${await emergency()}`, closed.hash));
  cs.push(refusalCheck("the watcher's sweep right after the admin closed the window is refused", await refused(() => asWatcher("sweep_to_safe", { id: id2 }), /no emergency/), "\"no emergency\""));

  // tidy up: the vault is left without the watcher and without the request
  const cancelled = await ctx.admin("cancel", { id: id2 });
  cs.push(check("the admin cancels request 2 (the queue is clean again)", !(await inQueue(id2)), `request ${id2} ${(await inQueue(id2)) ? "STILL queued" : "gone"}`, cancelled.hash));
  const removed = await ctx.admin("remove_watcher", { account: w.id });
  cs.push(check("remove_watcher: watchers() no longer lists the account", !(await listed()), `watchers() = [${(await rpc.view(vault, "watchers")).join(", ")}]`, removed.hash));
}

// ---- step 7: the other propose_* methods ----------------------------------------------------------------------------

export async function runProposals(ctx, cs) {
  const { plan, io, rpc, vault, until, waitNs } = ctx;
  const token = plan.actors.token.id;
  const asPolicy = (method, args, gas) => io.asActor("policy", vault, [call(method, args, gas)]);
  if ((await ctx.attest()).policy_account !== plan.policy) {
    cs.push(check("the separate policy account is the vault's policy account", false, `attest() shows ${(await ctx.attest()).policy_account}`));
    return;
  }
  const tokenLimit = async () => BigInt(await rpc.view(vault, "token_limit", { token }));
  const pendingLimit = async () => BigInt(await rpc.view(vault, "pending_limit", { token }));
  const dailyKeys = async () => rpc.view(vault, "daily_keys");

  // a fresh key per run: a removed daily key is remembered as revoked, so it is not added a second time
  let extra = io.actorKey("extraDaily", { create: false });
  if (!(extra && (await dailyKeys()).includes(extra.publicKey))) extra = io.actorKey("extraDaily", { fresh: true });
  const keyOnChain = async () => ((await rpc.accessKeys(vault)) ?? []).find((k) => k.public_key === extra.publicKey);

  const wanted = [
    { method: "propose_set_token_limit", args: { token, limit: TOKEN_CAP.toString() }, done: async () => (await tokenLimit()) === TOKEN_CAP, show: async () => `token_limit(${token}) = ${await tokenLimit()}` },
    { method: "propose_set_pending_limit", args: { token, limit: TOKEN_CAP.toString() }, done: async () => (await pendingLimit()) === TOKEN_CAP, show: async () => `pending_limit(${token}) = ${await pendingLimit()}` },
    { method: "propose_add_daily_key", args: { public_key: extra.publicKey, allowance: KEY_ALLOWANCE_YOCTO.toString() }, done: async () => (await dailyKeys()).includes(extra.publicKey), show: async () => `daily_keys() lists ${extra.publicKey}: ${(await dailyKeys()).includes(extra.publicKey)}` },
  ];
  const todo = [];
  for (const p of wanted) {
    if (await p.done()) cs.push(check(`${p.method}: already in force (resumed run), not proposed again`, true, await p.show()));
    else todo.push(p);
  }
  for (const p of todo) {
    const known = (await ctx.attest()).proposals.map((x) => String(x.id));
    const sent = await asPolicy(p.method, p.args);
    const prop = (await ctx.attest()).proposals.find((x) => !known.includes(String(x.id)));
    const notYet = !(await p.done());
    cs.push(check(`${p.method} by the policy account is queued; the effect is not in force yet`, !!prop && notYet && BigInt(prop.executable_at) > BigInt(prop.proposed_at), prop ? `proposal ${prop.id}, runs from ${prop.executable_at}; ${await p.show()}` : "no new proposal in attest()", sent.hash));
    if (!prop) return;
    p.prop = prop;
  }
  if (todo.length) {
    const reached = await waitNs(todo.reduce((m, p) => (BigInt(p.prop.executable_at) > m ? BigInt(p.prop.executable_at) : m), 0n));
    if (!reached) cs.push(check("the proposals' delay passed", false, "chain time did not reach the latest runs-from time"));
    for (const p of todo) {
      const applied = await ctx.keeper("apply", { id: String(p.prop.id) }, 100);
      const ok = !!(await until(p.done));
      cs.push(check(`apply(${p.prop.id}) by the stranger ${plan.stranger} after the delay: ${p.method} is in force`, ok, await p.show(), applied.hash));
    }
    const left = (await ctx.attest()).proposals.filter((x) => todo.some((p) => String(p.prop.id) === String(x.id)));
    cs.push(check("the applied proposals are gone from attest()", left.length === 0, left.length ? `still waiting: ${left.map((x) => x.id).join(", ")}` : "none waiting"));
  }

  // the daily key proposal's effect is on the chain, not only in the vault's own list
  const k = await until(keyOnChain);
  const fc = k?.access_key?.permission?.FunctionCall;
  const methods = [...(fc?.method_names ?? [])].sort().join(",");
  cs.push(check("the new daily key is on the chain as a function-call key of the vault limited to send_small and request_withdraw", !!fc && fc.receiver_id === vault && methods === "request_withdraw,send_small" && BigInt(fc.allowance ?? 0) > 0n, fc ? `receiver ${fc.receiver_id}, methods ${methods}, allowance ${fc.allowance}` : "key not found on the vault"));

  // leave the vault as found: one daily key
  const removed = await ctx.admin("remove_daily_key", { public_key: extra.publicKey }, 100);
  const gone = await until(async () => !(await dailyKeys()).includes(extra.publicKey) && !(await keyOnChain()));
  cs.push(check("remove_daily_key takes the added key away again (daily_keys() and the chain)", !!gone, `daily_keys() has ${(await dailyKeys()).length} key(s)`, removed.hash));
}

// ---- step 8: a NEP-141 sweep ----------------------------------------------------------------------------------------

export async function runFt(ctx, cs) {
  const { plan, io, rpc, vault, until } = ctx;
  const token = plan.actors.token.id;
  const safe = plan.safe;
  const payee = plan.payee;
  const ftBal = async (id) => BigInt(await rpc.view(token, "ft_balance_of", { account_id: id }));
  const inQueue = async (id) => (await rpc.view(vault, "queue")).some((q) => String(q.id) === String(id));

  if (!(await ensureActor(ctx, "token", cs))) return;
  for (const [what, view, set] of [["token_limit", "token_limit", "set_token_limit"], ["pending_limit", "pending_limit", "set_pending_limit"]]) {
    const have = BigInt(await rpc.view(vault, view, { token }));
    if (have === TOKEN_CAP) continue;
    const r = await ctx.admin(set, { token, limit: TOKEN_CAP.toString() });
    cs.push(check(`${what} was not set (step 7 did not run): the admin set it`, BigInt(await rpc.view(vault, view, { token })) === TOKEN_CAP, `${what}(${token}) = ${await rpc.view(vault, view, { token })}`, r.hash));
  }
  cs.push(check("the fixture has no storage registration: the safe account needs none", true, "ft-mock has no storage_deposit (information); so the unregistered-safe-account failure itself cannot be shown here"));

  const held = await ftBal(vault);
  if (held < FT_MINT_TO) {
    const minted = await ctx.keeper("ft_mint", { account_id: vault, amount: (FT_MINT_TO - held).toString() }, 30, token);
    cs.push(check(`ft_mint puts the tokens in the vault: ft_balance_of(vault) is ${FT_MINT_TO}`, (await ftBal(vault)) === FT_MINT_TO, `ft_balance_of(${vault}) was ${held}, now ${await ftBal(vault)}`, minted.hash));
  } else cs.push(check("the vault already holds the tokens (resumed run)", true, `ft_balance_of(${vault}) = ${held}`));

  const watchers = [vault, safe, payee, plan.stranger, token];
  const balances = async () => Object.fromEntries(await Promise.all(watchers.map(async (id) => [id, await ftBal(id)])));
  const sum = (b) => Object.values(b).reduce((a, c) => a + c, 0n);

  // a successful sweep
  const rq = await queueRequest(ctx, { token, amount: FT_SWEEP, to: payee, label: "NEP-141 request" });
  cs.push(rq.check);
  if (!rq.q) return;
  const id = String(rq.q.id);
  const b0 = await balances();
  const nearBefore = bal(await rpc.account(vault));
  const swept = await ctx.admin("sweep_to_safe", { id }, TGAS_FT);
  const logs = logsOf(swept.outcome);
  cs.push(check("the admin's sweep_to_safe of the token request is accepted", true, `request ${id}`, swept.hash));
  cs.at(-1).evidence = [`sweep tx ${swept.hash}`, ...logs.map((l) => `log: ${SECRET_FREE(l).slice(0, 400)}`)];
  cs.push(check("the sweep event names the token and the safe account", eventIn(logs, "sweep_to_safe") && logs.join("\n").includes(`"token":"${token}"`) && logs.join("\n").includes(`"safe":"${safe}"`), eventIn(logs, "sweep_to_safe") ? "EVENT sweep_to_safe found" : "no sweep_to_safe event"));
  cs.push(check("no sweep_failed in the logs", !eventIn(logs, "sweep_failed"), eventIn(logs, "sweep_failed") ? "the transfer FAILED" : "none"));
  const executors = executorsOf(swept.outcome);
  const stray = [...executors].filter((e) => e !== vault && e !== token);
  cs.push(check("every receipt ran on the vault or the token contract only", stray.length === 0, `executors: ${[...executors].join(", ")}`));
  await until(async () => (await ftBal(safe)) - b0[safe] >= FT_SWEEP);
  const b1 = await balances();
  cs.push(check("the safe account received exactly the amount of the token", b1[safe] - b0[safe] === FT_SWEEP && b0[vault] - b1[vault] === FT_SWEEP, `ft_balance_of(safe) ${b0[safe]} -> ${b1[safe]}, ft_balance_of(vault) ${b0[vault]} -> ${b1[vault]}`));
  cs.at(-1).evidence = [`token ${token}, safe ${safe}, vault ${vault}`];
  const others = watchers.filter((x) => x !== vault && x !== safe);
  cs.push(check("it moved ONLY to the safe account: the payee, the stranger and the token contract itself hold what they held; the total is unchanged", others.every((x) => b1[x] === b0[x]) && sum(b1) === sum(b0), others.map((x) => `${x} ${b0[x]} -> ${b1[x]}`).join("; ")));
  cs.push(check("the request left the queue", !(await inQueue(id)), `request ${id} ${(await inQueue(id)) ? "STILL queued" : "gone"}`));

  // a failed transfer: the request is larger than the vault's token balance, so the token contract refuses it
  const big = await queueRequest(ctx, { token, amount: FT_OVERSIZED, to: payee, label: "oversized NEP-141 request" });
  cs.push(big.check);
  if (!big.q) return;
  const bigId = String(big.q.id);
  const c0 = await balances();
  const n0 = bal(await rpc.account(vault));
  let outcome = null;
  let hash = null;
  let failure = null;
  try {
    const r = await ctx.admin("sweep_to_safe", { id: bigId }, TGAS_FT);
    outcome = r.outcome;
    hash = r.hash;
  } catch (e) {
    // The sender throws when any receipt failed, and here the ft_transfer receipt does by design: read the transaction back for its logs.
    const r = refusalOf(e);
    hash = r.tx;
    failure = r.raw;
    if (hash) outcome = await rpc.tx(hash, vault).catch(() => null);
  }
  const flogs = logsOf(outcome);
  cs.push(check("the sweep of the oversized request went through the contract: sweep_failed is in the logs", eventIn(flogs, "sweep_failed") && flogs.join("\n").includes(`"safe":"${safe}"`), eventIn(flogs, "sweep_failed") ? "EVENT sweep_failed found" : `no sweep_failed event (${failure ?? "no failure text"})`, hash));
  cs.at(-1).evidence = [`failed-sweep tx ${hash}`, ...flogs.map((l) => `log: ${SECRET_FREE(l).slice(0, 400)}`), ...(failure ? [`receipt failure: ${failure.slice(0, 250)}`] : [])];
  await until(async () => !(await inQueue(bigId)));
  const c1 = await balances();
  const n1 = bal(await rpc.account(vault));
  cs.push(check("nothing was lost and nothing moved: every token balance is unchanged", Object.keys(c0).every((x) => c1[x] === c0[x]), `vault ${c0[vault]} -> ${c1[vault]}, safe ${c0[safe]} -> ${c1[safe]}, payee ${c0[payee]} -> ${c1[payee]}`));
  cs.push(check("the request is gone from the queue and was not put back (documented behaviour)", !(await inQueue(bigId)), `request ${bigId} ${(await inQueue(bigId)) ? "STILL queued" : "gone"}`));
  cs.push(check("the vault's NEAR fell by gas only", n0 - n1 >= 0n && n0 - n1 <= NEAR / 20n, `fell ${formatNear(n0 - n1, 6)} NEAR`));
}
