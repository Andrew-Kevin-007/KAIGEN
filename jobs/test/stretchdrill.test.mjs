// stretchdrill (jobs/src/stretchdrill.mjs, `stretchdrill` in bin.mjs). No network: the vault is a small in-memory model of the
// stretch items' gates (docs/v3/STRETCH-DESIGN.md) behind the same io the real command builds. Nothing here signs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GlobalUsage, Refused } from "../src/globalcontract.mjs";
import { fundForCalls, KEY_ALLOWANCE_YOCTO, watcherSweepTgas, WATCH_REQUEST_1_YOCTO } from "../src/stretchext.mjs";
import { parseStretchArgs, planStretchDrill, refusalOf, renderStretch, runStretchDrill, SWEEP_YOCTO, VAULT_WORKING_YOCTO } from "../src/stretchdrill.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "..", "src", "bin.mjs");
const NEAR = 10n ** 24n;
const SECRET_KEEPER = "ed25519:KEEPERSECRETKEEPERSECRETKEEPERSECRETKEEPERSECRET1234";
const SECRET_DAILY = "ed25519:DAILYSECRETDAILYSECRETDAILYSECRETDAILYSECRET5678";
const ADMIN = "ml-dsa-65-hash:79bpPTk3XvRCxe4y9rBmZRrfqbzu9DLHFNpXDgUsKPjo";
const state = {
  network: "testnet",
  kizashi: "kizashi.f.testnet",
  vault: "vault.f.testnet",
  supplier: "supplier.f.testnet",
  keeper: { id: "keeper.f.testnet", privateKey: SECRET_KEEPER },
  daily: { publicKey: "ed25519:DAILYPUB", privateKey: SECRET_DAILY },
};
const FUNDER = "funder.testnet";
const POLICY = `sd-policy.${FUNDER}`;
const WATCHER = `sd-watcher.${FUNDER}`;
const TOKEN = `sd-token.${FUNDER}`;
const RECIPIENT = "stretchdrill-0a1b2c3d.testnet";
const planOf = (over = {}) => planStretchDrill({ state, recipient: RECIPIENT, funderId: FUNDER, ...over });

/** The vault's gates as STRETCH-DESIGN.md states them, with knobs (`bug`) to break one. */
function makeWorld({ bug = {}, vaultFree = 1n * NEAR, funderHas = 50n * NEAR, drillBuild = true, chain = "testnet", safeInForce = false, preQueued = false, txNs = 2n * 10n ** 9n } = {}) {
  const w = {
    now: 1_000_000_000_000n,
    n: 0,
    calls: [],
    chain,
    queue: [],
    nextReq: 1,
    proposals: [],
    nextProp: 1,
    allowed: [],
    safe: { current: null, pending: null },
    policy: null,
    watchers: [],
    emergencyUntil: 0n,
    tokenLimit: new Map(),
    pendingLimit: new Map(),
    dailyKeys: [state.daily.publicKey],
    ft: new Map(),
    keysOf: new Map(),
    outcomes: new Map(),
    log: [],
    delayNs: 10n * 10n ** 9n,
    accounts: new Map(),
  };
  const storage = 400_000;
  const acc = (amount) => ({ amount: amount.toString(), storage_usage: storage });
  w.accounts.set(state.vault, acc(BigInt(storage) * 10n ** 19n + vaultFree));
  for (const id of [state.supplier, state.kizashi, state.keeper.id]) w.accounts.set(id, acc(5n * NEAR));
  w.accounts.set(FUNDER, { amount: (funderHas + 182n * 10n ** 19n).toString(), storage_usage: 182 });
  if (safeInForce) w.safe = { current: state.supplier, pending: null };
  if (preQueued) w.queue.push({ id: "1", amount: SWEEP_YOCTO.toString(), to: state.kizashi, token: null });
  const add = (id, d) => w.accounts.set(id, { ...w.accounts.get(id), amount: (BigInt(w.accounts.get(id).amount) + d).toString() });
  const failure = (text) => `{"ActionError":{"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: ${text}"}}}}`;
  const panic = (text) => {
    throw new Error(`transaction TX${w.n}1111111111111111111111111111111111 failed: ${failure(text)}`);
  };
  const safeNow = () => {
    const s = w.safe;
    return s.pending && w.now >= s.pending.effective_at ? s.pending.account : s.current;
  };
  const tick = () => {
    w.now += txNs;
    w.n += 1;
  };
  const who = { admin: state.vault, keeper: state.keeper.id, daily: state.vault, policy: POLICY, watcher: WATCHER };
  const ftOf = (id) => w.ft.get(id) ?? 0n;
  // caller: "admin" | "keeper" | "daily" | "policy" | "watcher"
  function exec(caller, method, args, receiver = state.vault) {
    tick();
    w.calls.push({ caller, method, args });
    const hash = `HASH${w.n}`;
    const logs = [];
    const ret = { hash, outcome: { ns: String(w.now), status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { executor_id: receiver, logs } }] } };
    const admin = caller === "admin";
    const needAdmin = () => !admin && !bug.anyoneAdmin && panic("admin only");
    if (receiver === TOKEN) {
      if (method === "ft_mint") {
        w.ft.set(args.account_id, ftOf(args.account_id) + BigInt(args.amount));
        return ret;
      }
      throw new Error(`fake token has no ${method}`);
    }
    switch (method) {
      case "set_safe_account":
        needAdmin();
        if (args.account === state.vault) panic("the safe account cannot be the vault itself");
        if (w.safe.pending && w.now >= w.safe.pending.effective_at) w.safe = { current: w.safe.pending.account, pending: null };
        w.safe.pending = { account: args.account, effective_at: w.now + w.delayNs };
        return ret;
      case "request_withdraw": {
        const id = w.nextReq++;
        w.queue.push({ id: String(id), amount: args.amount, to: args.to, token: args.token ?? null });
        return ret;
      }
      case "sweep_to_safe": {
        if (caller === "daily" && !bug.dailyCanSweep) throw new Error(bug.chainWording ? `fastnear: signer key is not permitted for ${state.vault}` : "InvalidAccessKeyError MethodNameMismatch { method_name: \"sweep_to_safe\" }");
        const isWatcher = caller === "watcher" && w.watchers.includes(WATCHER);
        if (!admin && !isWatcher && !bug.strangerCanSweep && !(caller === "daily" && bug.dailyCanSweep)) panic("admin or watcher only");
        if (isWatcher && !bug.watcherAlways && w.now >= w.emergencyUntil) panic("no emergency: watchers can sweep only in a declared window");
        const safe = safeNow();
        if (!safe) panic("no safe account is in force");
        const i = w.queue.findIndex((q) => q.id === args.id);
        if (i < 0) panic("no such request");
        const [q] = w.queue.splice(i, 1);
        if (q.token) {
          logs.push(`EVENT_JSON:{"event":"sweep_to_safe","data":[{"id":"${args.id}","by":"${who[caller]}","safe":"${safe}","token":"${q.token}","amount":"${q.amount}"}]}`);
          ret.outcome.receipts_outcome.push({ outcome: { executor_id: q.token, logs: [] } });
          if (ftOf(state.vault) < BigInt(q.amount)) {
            logs.push(`EVENT_JSON:{"event":"sweep_failed","data":[{"id":"${args.id}","token":"${q.token}","amount":"${q.amount}","safe":"${safe}"}]}`);
            const fail = { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: The account doesn't have enough balance" } } } };
            ret.outcome.receipts_outcome[1].outcome.status = { Failure: fail };
            if (bug.putBack) w.queue.push(q);
            const failHash = `TX${w.n}2222222222222222222222222222222222`;
            w.outcomes.set(failHash, ret.outcome);
            add(state.vault, -4n * 10n ** 21n);
            throw new Error(`transaction ${failHash} failed: ${JSON.stringify(fail)}`);
          }
          const dest = bug.paysPayee ? q.to : safe;
          w.ft.set(state.vault, ftOf(state.vault) - BigInt(q.amount));
          w.ft.set(dest, ftOf(dest) + BigInt(q.amount));
          add(state.vault, -4n * 10n ** 21n);
          return ret;
        }
        const dest = bug.paysPayee ? q.to : safe;
        add(state.vault, -BigInt(q.amount) - (admin ? 4n * 10n ** 21n : 0n));
        add(dest, BigInt(q.amount));
        logs.push(`EVENT_JSON:{"event":"sweep_to_safe","data":[{"id":"${args.id}","by":"${who[caller]}","safe":"${safe}"}]}`);
        ret.outcome.receipts_outcome.push({ outcome: { executor_id: dest, logs: [] } });
        // the signer's own account runs the first receipt and the gas refund
        if (caller === "watcher") ret.outcome.receipts_outcome.push({ outcome: { executor_id: WATCHER, logs: [] } });
        return ret;
      }
      case "set_policy_account":
        needAdmin();
        w.policy = args.account;
        w.proposals = [];
        return ret;
      case "add_watcher":
        needAdmin();
        if (args.account === state.vault) panic("a watcher cannot be the vault itself");
        w.watchers.push(args.account);
        return ret;
      case "remove_watcher":
        needAdmin();
        w.watchers = w.watchers.filter((x) => x !== args.account);
        return ret;
      case "set_emergency":
        if (caller === "watcher" && bug.watcherAdmin) {
          w.emergencyUntil = w.now + 10n ** 15n;
          return ret;
        }
        needAdmin();
        if (args.secs > 7 * 86_400) panic("an emergency window lasts at most 7 days");
        w.emergencyUntil = args.secs === 0 ? 0n : w.now + BigInt(args.secs) * 10n ** 9n;
        logs.push(`EVENT_JSON:{"event":"set_emergency","data":[{"secs":${args.secs},"until":"${w.emergencyUntil}"}]}`);
        return ret;
      case "cancel": {
        needAdmin();
        const i = w.queue.findIndex((q) => q.id === args.id);
        if (i < 0) panic("no such request");
        w.queue.splice(i, 1);
        return ret;
      }
      case "set_token_limit":
        needAdmin();
        w.tokenLimit.set(args.token, BigInt(args.limit));
        return ret;
      case "set_pending_limit":
        needAdmin();
        w.pendingLimit.set(args.token, BigInt(args.limit));
        return ret;
      case "remove_daily_key":
        needAdmin();
        w.dailyKeys = w.dailyKeys.filter((k) => k !== args.public_key);
        return ret;
      case "propose_allow_recipient":
      case "propose_set_token_limit":
      case "propose_set_pending_limit":
      case "propose_add_daily_key":
        if (caller !== "policy" || w.policy !== POLICY) panic("policy account only");
        w.proposals.push({ id: String(w.nextProp++), method, args, proposed_at: String(w.now), executable_at: String(w.now + w.delayNs) });
        return ret;
      case "cancel_proposal": {
        needAdmin();
        const i = w.proposals.findIndex((p) => p.id === args.id);
        if (i < 0) panic("no such proposal");
        w.proposals.splice(i, 1);
        return ret;
      }
      case "apply": {
        const p = w.proposals.find((x) => x.id === args.id);
        if (!p) panic("no such proposal");
        if (w.now < BigInt(p.executable_at) && !bug.applyEarly) panic("still locked");
        if (p.method === "propose_allow_recipient") w.allowed.push(p.args.account);
        if (p.method === "propose_set_token_limit") w.tokenLimit.set(p.args.token, BigInt(p.args.limit));
        if (p.method === "propose_set_pending_limit") w.pendingLimit.set(p.args.token, BigInt(p.args.limit));
        if (p.method === "propose_add_daily_key") w.dailyKeys.push(p.args.public_key);
        w.proposals = w.proposals.filter((x) => x !== p);
        return ret;
      }
      default:
        throw new Error(`fake vault has no ${method}`);
    }
  }
  const dailyKeyView = (pk) => ({ public_key: pk, access_key: { permission: { FunctionCall: { receiver_id: state.vault, method_names: ["send_small", "request_withdraw"], allowance: KEY_ALLOWANCE_YOCTO.toString() } } } });
  const rpc = {
    async status() {
      return { chain_id: w.chain, protocol_version: 88 };
    },
    async account(id) {
      return w.accounts.get(id) ? { ...w.accounts.get(id), code_hash: "CODEHASH" } : null;
    },
    async accessKeys(id) {
      if (id === state.vault) return [{ public_key: ADMIN, access_key: { permission: "FullAccess" } }, ...w.dailyKeys.map(dailyKeyView)];
      return w.keysOf.has(id) ? w.keysOf.get(id).map((pk) => ({ public_key: pk, access_key: { permission: "FullAccess" } })) : null;
    },
    async tx(hash) {
      return w.outcomes.get(hash);
    },
    async view(contract, method, args) {
      if (contract === TOKEN) {
        if (method === "ft_balance_of") return String(ftOf(args.account_id));
        if (method === "ft_decimals") return 24;
        throw new Error(`fake token has no view ${method}`);
      }
      switch (method) {
        case "attest":
          return {
            drill_build: drillBuild,
            config: { era: "Calm", delay_secs: 10 },
            queue_len: w.queue.length,
            policy_account: w.policy,
            safe_account: { current: safeNow(), pending: w.safe.pending && w.now < w.safe.pending.effective_at ? { account: w.safe.pending.account, effective_at: String(w.safe.pending.effective_at) } : null },
            proposals: w.proposals.map((p) => ({ id: p.id, proposed_at: p.proposed_at, executable_at: p.executable_at })),
          };
        case "daily_keys":
          return w.dailyKeys;
        case "pending_limit":
          if (args.token === null) return String(10n * NEAR);
          return String(w.pendingLimit.get(args.token) ?? 0n);
        case "token_limit":
          return String(w.tokenLimit.get(args.token) ?? 0n);
        case "watchers":
          return w.watchers;
        case "emergency_until":
          return String(w.emergencyUntil);
        case "queue":
          return w.queue;
        case "allowlist":
          return { enforced: true, accounts: w.allowed };
        default:
          throw new Error(`fake vault has no view ${method}`);
      }
    },
  };
  const funded = [];
  const keys = new Map();
  let keyN = 0;
  const io = {
    rpc,
    adminHandle: ADMIN,
    keeperPublicKey: "ed25519:KEEPERPUB",
    ftWasm: new Uint8Array(90_531),
    receiptNs: (o) => BigInt(o.ns),
    admin: async (actions) => exec("admin", actions[0].method, actions[0].args),
    keeper: async (actions, receiver) => exec("keeper", actions[0].method, actions[0].args, receiver),
    asActor: async (role, receiver, actions) => exec(role, actions[0].method, actions[0].args, receiver),
    actorKey: (role, { create = true, fresh = false } = {}) => {
      if (keys.has(role) && !fresh) return keys.get(role);
      if (!create) return null;
      const k = { publicKey: `ed25519:PUB${role}${++keyN}` };
      keys.set(role, k);
      w.log.push(`key:${role}`);
      return k;
    },
    funderSend: async (receiverId, actions) => {
      tick();
      w.log.push(`${actions.some((a) => a.type === "CreateAccount") ? "create" : "topup"}:${receiverId}`);
      const fund = BigInt(actions.find((a) => a.type === "Transfer").yocto);
      add(FUNDER, -fund);
      if (actions.some((a) => a.type === "CreateAccount")) {
        w.accounts.set(receiverId, { amount: fund.toString(), storage_usage: 100 });
        w.keysOf.set(receiverId, [actions.find((a) => a.type === "AddKey").publicKey]);
      } else add(receiverId, fund);
      return { hash: `CREATE${w.n}`, outcome: {} };
    },
    daily: async (method, args) => {
      try {
        const r = exec("daily", method, args);
        return { ok: true, hash: r.hash };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    fund: async (yocto) => {
      funded.push(yocto);
      add(state.vault, yocto);
      return { hash: "FUNDTX" };
    },
    nowNs: async () => {
      w.now += 3n * 10n ** 9n;
      return w.now;
    },
  };
  return { w, io, funded, keys };
}

const fakeCage = async () => ({
  account: state.vault,
  block: { height: 1, hash: "B" },
  mode: "production",
  verdict: "RED",
  conditions: [
    { id: "ARCH-2.8-1", name: "no classical full-access key", status: "GREEN", detail: "ok" },
    { id: "ATTEST-2", name: "production build", status: "RED", detail: "drill build" },
  ],
  info: { era: "Calm", delay_secs: 10, attest: "present", attest_cross_check: "agrees", allowlist_enforced: true, max_strikes: 3 },
  limits: [],
});
const run = (world, over = {}) => runStretchDrill({ plan: planOf(), state, io: world.io, yes: true, cage: fakeCage, sleep: async () => {}, ...over });

test("dry run reads only: it signs and sends nothing, and prints the plan and the preflight", async () => {
  const world = makeWorld();
  const boom = () => {
    throw new Error("a dry run must not sign or send");
  };
  const io = { ...world.io, admin: boom, keeper: boom, daily: boom, fund: boom };
  const out = await runStretchDrill({ plan: planOf(), state, io, yes: false, cage: fakeCage });
  assert.equal(out.dryRun, true);
  assert.equal(out.pre.ok, true);
  assert.equal(world.w.calls.length, 0);
  assert.match(renderStretch(out), /sweep_to_safe/);
});

test("the full run: eight steps, in order, each PASS with a transaction hash", async () => {
  const world = makeWorld();
  const out = await run(world);
  assert.equal(out.ok, true, renderStretch(out));
  assert.deepEqual(out.results.map((r) => [r.n, r.ok]), [[1, true], [2, true], [3, true], [4, true], [5, true], [6, true], [7, true], [8, true]]);
  const order = world.w.calls.map((c) => `${c.caller}:${c.method}`);
  const at = (s) => order.indexOf(s);
  assert.ok(at("admin:set_safe_account") === 0, order.join(" "));
  assert.ok(at("daily:request_withdraw") > at("admin:set_safe_account"));
  assert.ok(at("keeper:sweep_to_safe") > at("daily:request_withdraw"));
  assert.ok(order.lastIndexOf("admin:sweep_to_safe") > at("daily:sweep_to_safe"), "the real sweep comes after the refusals");
  assert.ok(at("admin:set_policy_account") > at("admin:sweep_to_safe"));
  assert.ok(at("admin:cancel_proposal") > at("policy:propose_set_token_limit"));
  assert.ok(order.indexOf("keeper:apply") < order.lastIndexOf("keeper:apply"), "apply is tried early (refused) then after the wait");
  const text = renderStretch(out);
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) assert.match(text, new RegExp(`PASS  step ${n} `));
  assert.match(text, /PASS  step 2 sweep .* tx HASH\d+ HASH\d+/);
  assert.match(text, /RED on ATTEST-2 by design/);
});

test("the sweep moved value only to the safe account: the payee got nothing, the safe account got exactly the amount", async () => {
  const world = makeWorld();
  await run(world);
  const b = (id) => BigInt(world.w.accounts.get(id).amount);
  assert.equal(b(state.supplier), 5n * NEAR + SWEEP_YOCTO + WATCH_REQUEST_1_YOCTO);
  assert.equal(b(state.kizashi), 5n * NEAR);
  assert.equal(world.w.queue.length, 0);
});

test("each refusal is expected: stranger, daily key, safe account = the vault", async () => {
  const world = makeWorld();
  const out = await run(world);
  const refuse = out.results.find((r) => r.id === "refuse");
  const names = refuse.checks.map((c) => c.name).join("\n");
  assert.match(names, /stranger .* sweep_to_safe is refused/);
  assert.match(names, /daily key calling sweep_to_safe is refused/);
  assert.match(names, /set_safe_account\(the vault itself\) is refused/);
  assert.ok(refuse.checks.every((c) => c.ok));
  assert.match(refuse.checks[0].detail, /admin or watcher only/);
  assert.match(refuse.checks[2].detail, /cannot be the vault itself/);
});

test("a stranger who CAN sweep fails step 3, skips step 4, and the cage step still runs", async () => {
  const world = makeWorld({ bug: { strangerCanSweep: true } });
  const out = await run(world);
  assert.equal(out.ok, false);
  const by = Object.fromEntries(out.results.map((r) => [r.id, r]));
  assert.equal(by.refuse.ok, false);
  assert.match(by.refuse.checks[0].detail, /NOT refused/);
  assert.equal(by.policy.skipped, true);
  assert.equal(by.cage.ok, true);
  assert.match(renderStretch(out), /FAIL  step 3/);
  assert.match(renderStretch(out), /SKIP  step 4/);
});

test("a sweep that pays the request's payee instead of the safe account fails step 2", async () => {
  const world = makeWorld({ bug: { paysPayee: true } });
  const out = await run(world);
  const sweep = out.results.find((r) => r.id === "sweep");
  assert.equal(sweep.ok, false);
  assert.ok(sweep.checks.some((c) => !c.ok && /every receipt ran on the vault or the safe/.test(c.name)));
  assert.ok(sweep.checks.some((c) => !c.ok && /safe account received exactly/.test(c.name)));
});

test("a daily key that CAN sweep fails step 3", async () => {
  const out = await run(makeWorld({ bug: { dailyCanSweep: true } }));
  assert.equal(out.results.find((r) => r.id === "refuse").ok, false);
});

test("apply that runs before the delay fails step 4", async () => {
  const out = await run(makeWorld({ bug: { applyEarly: true } }));
  const policy = out.results.find((r) => r.id === "policy");
  assert.equal(policy.ok, false);
  assert.ok(policy.checks.some((c) => /apply before the delay is refused/.test(c.name) && !c.ok));
});

test("a vault short of NEAR is topped up by the funder; without a funder the step says so", async () => {
  const w1 = makeWorld({ vaultFree: 0n });
  const out = await run(w1);
  assert.equal(out.ok, true, renderStretch(out));
  assert.equal(w1.funded.length, 1);
  assert.equal(w1.funded[0], SWEEP_YOCTO + VAULT_WORKING_YOCTO);
  const w2 = makeWorld({ vaultFree: 0n });
  const out2 = await run(w2, { io: { ...w2.io, fund: null } });
  assert.equal(out2.results.find((r) => r.id === "sweep").ok, false);
  assert.match(renderStretch(out2), /give --funder-file/);
});

test("it refuses mainnet: state, accounts, the node, and the flag", async () => {
  assert.throws(() => planStretchDrill({ state: { ...state, network: "mainnet" } }), Refused);
  assert.throws(() => planStretchDrill({ state: { ...state, vault: "vault.f.near" } }), Refused);
  assert.throws(() => parseStretchArgs(["--chain-id", "mainnet"]), GlobalUsage);
  const world = makeWorld({ chain: "mainnet" });
  await assert.rejects(runStretchDrill({ plan: planOf(), state, io: world.io, yes: true, cage: fakeCage }), Refused);
  assert.equal(world.w.calls.length, 0);
  const dry = await runStretchDrill({ plan: planOf(), state, io: world.io, yes: false });
  assert.equal(dry.pre.ok, false);
});

test("the safe account is never the vault or the keeper", () => {
  assert.throws(() => planOf({ safe: state.vault }), Refused);
  assert.throws(() => planOf({ safe: state.keeper.id }), Refused);
  assert.equal(planOf({ safe: state.kizashi }).payee, state.supplier);
  assert.equal(planOf().payee, state.kizashi);
});

test("a vault from before the stretch items fails the preflight and nothing is sent", async () => {
  const world = makeWorld();
  const rpc = { ...world.io.rpc, view: async (c, m, a) => (m === "attest" ? { drill_build: true, config: { era: "Calm", delay_secs: 10 } } : world.io.rpc.view(c, m, a)) };
  await assert.rejects(runStretchDrill({ plan: planOf(), state, io: { ...world.io, rpc }, yes: true, cage: fakeCage }), /before the stretch items/);
  assert.equal(world.w.calls.length, 0);
});

test("no secret is printed: not the keeper's, not the daily key's, and key strings in errors are shortened", async () => {
  const world = makeWorld();
  const logged = [];
  const out = await run(world, { log: (e) => logged.push(JSON.stringify(e)) });
  const text = `${renderStretch(out)}\n${logged.join("\n")}`;
  assert.ok(!text.includes(SECRET_KEEPER) && !text.includes(SECRET_DAILY));
  const r = refusalOf(new Error(`transaction ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkm failed: panicked: ${SECRET_KEEPER}`));
  assert.ok(!r.raw.includes(SECRET_KEEPER));
});

test("refusalOf reads the hash and the panic text", () => {
  const r = refusalOf(new Error('transaction 5bnTqZ3mVxQw9Yc7Jd2Kf8LpHs4NtRu6Ae1GbWx3Cz7M failed: {"ExecutionError":"Smart contract panicked: admin or watcher only"}'));
  assert.equal(r.tx, "5bnTqZ3mVxQw9Yc7Jd2Kf8LpHs4NtRu6Ae1GbWx3Cz7M");
  assert.equal(r.text, "admin or watcher only");
});

test("argument parsing", () => {
  const o = parseStretchArgs(["--safe", "a.testnet", "--yes"], { funderFile: "f.json" });
  assert.deepEqual([o.safe, o.yes, o.funderFile, o.chainId], ["a.testnet", true, "f.json", "testnet"]);
  assert.throws(() => parseStretchArgs(["--safe"]), GlobalUsage);
  assert.throws(() => parseStretchArgs(["--bogus"]), GlobalUsage);
  assert.throws(() => parseStretchArgs(["--safe", "a", "--safe", "b"]), GlobalUsage);
});

test("the CLI: a bad option exits 2 with the usage; no state.json is an error and signs nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sd-"));
  try {
    const bad = spawnSync(process.execPath, [BIN, "stretchdrill", "--bogus"], { encoding: "utf8", env: { ...process.env, KAIGEN_TESTNET_DIR: dir } });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /usage: kaigen-jobs stretchdrill/);
    const none = spawnSync(process.execPath, [BIN, "stretchdrill"], { encoding: "utf8", env: { ...process.env, KAIGEN_TESTNET_DIR: dir } });
    assert.equal(none.status, 1);
    assert.match(none.stderr, /state\.json is missing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a daily key refused by the chain's access-key layer passes, and the output says which layer refused", async () => {
  const out = await run(makeWorld({ bug: { chainWording: true } }));
  assert.equal(out.ok, true, renderStretch(out));
  const c = out.results.find((r) => r.id === "refuse").checks[1];
  assert.equal(c.ok, true);
  assert.match(c.name, /by the access key's permission, before the contract ran/);
});

test("a daily key refused by the contract passes too, and is labelled as the contract", async () => {
  const world = makeWorld();
  const io = { ...world.io, daily: async (m, a) => (m === "sweep_to_safe" ? { ok: false, error: "transaction X failed: Smart contract panicked: admin or watcher only" } : world.io.daily(m, a)) };
  const out = await run(world, { io });
  assert.match(out.results.find((r) => r.id === "refuse").checks[1].name, /by the contract/);
  assert.equal(out.results.find((r) => r.id === "refuse").ok, true);
});

test("resumable: a safe account already in force is not set again, and the queued request is reused", async () => {
  const world = makeWorld({ safeInForce: true, preQueued: true });
  const out = await run(world);
  assert.equal(out.ok, true, renderStretch(out));
  const calls = world.w.calls.map((c) => `${c.caller}:${c.method}`);
  assert.equal(world.w.calls.filter((c) => c.method === "request_withdraw" && BigInt(c.args.amount) === SWEEP_YOCTO).length, 0, "no new request of the step 2 size");
  assert.equal(calls.filter((c) => c === "admin:set_safe_account").length, 1, "only the refused set_safe_account(vault)");
  assert.equal(calls.filter((c) => c === "admin:sweep_to_safe").length, 3, "the NEAR sweep once, then the two NEP-141 sweeps of step 8");
  assert.match(renderStretch(out), /already in force \(resumed run\)/);
  assert.match(renderStretch(out), /already queued \(resumed run\)/);
});

test("resumable: with no safe account in force and an empty queue it does the whole setup", async () => {
  const world = makeWorld();
  await run(world);
  const calls = world.w.calls.map((c) => `${c.caller}:${c.method}`);
  assert.equal(world.w.calls.filter((c) => c.method === "request_withdraw" && BigInt(c.args.amount) === SWEEP_YOCTO).length, 1);
  assert.equal(calls.filter((c) => c === "admin:set_safe_account").length, 2);
});

test("step 2 prints the evidence: sweep tx, log text, vault and safe balances before and after", async () => {
  const text = renderStretch(await run(makeWorld({ safeInForce: true, preQueued: true })));
  assert.match(text, /sweep tx HASH\d+/);
  assert.match(text, /log: EVENT_JSON:\{"event":"sweep_to_safe"/);
  assert.match(text, /vault balance before \d+ yocto, after \d+ yocto/);
  assert.match(text, /safe account supplier\.f\.testnet before \d+ yocto, after \d+ yocto/);
});

test("policy step order: the early apply is tried right after the first proposal, before the second one", async () => {
  const world = makeWorld();
  await run(world);
  const calls = world.w.calls.map((c) => `${c.caller}:${c.method}`);
  const first = calls.indexOf("keeper:apply");
  assert.ok(first > calls.indexOf("policy:propose_allow_recipient"));
  assert.ok(first < calls.indexOf("policy:propose_set_token_limit"), calls.join(" "));
  assert.ok(calls.lastIndexOf("keeper:apply") > calls.indexOf("admin:cancel_proposal"));
});

test("policy step on a chain slower than the delay: an early apply that goes through is legitimate, not a failure, and is not applied twice", async () => {
  const world = makeWorld({ txNs: 11n * 10n ** 9n });
  const out = await run(world);
  const policy = out.results.find((r) => r.id === "policy");
  assert.equal(policy.ok, true, renderStretch(out));
  assert.match(policy.checks.map((c) => c.name).join(" | "), /could not be tested: the delay was already over/);
  assert.equal(world.w.calls.filter((c) => c.method === "apply" && c.args.id === "1").length, 1);
  assert.deepEqual(world.w.allowed, [RECIPIENT]);
});

test("policy step: an apply that succeeds while chain time says it is still locked fails the step and cascades nothing", async () => {
  const out = await run(makeWorld({ bug: { applyEarly: true } }));
  const policy = out.results.find((r) => r.id === "policy");
  assert.equal(policy.ok, false);
  assert.ok(policy.checks.some((c) => !c.ok && /apply before the delay is refused/.test(c.name)));
  assert.ok(!policy.checks.some((c) => /step ran to the end/.test(c.name)));
});

const stepOf = (out, id) => out.results.find((r) => r.id === id);
const failedChecks = (r) => r.checks.filter((c) => !c.ok).map((c) => c.name);

test("step 6: the watcher is refused with no window, sweeps inside one to the safe account only, is refused for anything else, and the window ends and is closed", async () => {
  const world = makeWorld();
  const out = await run(world);
  const r = stepOf(out, "watcher");
  assert.equal(r.ok, true, failedChecks(r).join("; "));
  const text = renderStretch(out);
  assert.match(text, /watcher .* calling sweep_to_safe with NO window open is refused/);
  assert.match(text, /set_emergency\(604801 s, over 7 days\) is refused/);
  assert.match(text, /the watcher calling set_safe_account \(window open\) is refused/);
  assert.match(text, /the watcher calling set_emergency \(window open\) is refused/);
  assert.match(text, /the watcher calling cancel \(window open\) is refused/);
  assert.match(text, /"by":"sd-watcher\.funder\.testnet"/);
  assert.match(text, /the window ended by itself/);
  assert.match(text, /set_emergency\(0\) closes it/);
  assert.deepEqual(world.w.watchers, [], "the watcher is removed again");
  assert.equal(world.w.emergencyUntil, 0n);
  assert.equal(world.w.queue.length, 0);
});

test("step 6 fails if a watcher can sweep outside the window, or can call an admin method", async () => {
  assert.equal(stepOf(await run(makeWorld({ bug: { watcherAlways: true } })), "watcher").ok, false);
  const r = stepOf(await run(makeWorld({ bug: { watcherAdmin: true } })), "watcher");
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((c) => !c.ok && /set_emergency \(window open\) is refused/.test(c.name)));
});

test("step 7: the three propose_* methods are applied after the wait by a stranger, effects are read back, and the added key is removed again", async () => {
  const world = makeWorld();
  const out = await run(world);
  const r = stepOf(out, "proposals");
  assert.equal(r.ok, true, failedChecks(r).join("; "));
  assert.equal(world.w.tokenLimit.get(TOKEN), 100_000n);
  assert.equal(world.w.pendingLimit.get(TOKEN), 100_000n);
  assert.deepEqual(world.w.dailyKeys, [state.daily.publicKey]);
  const applies = world.w.calls.filter((c) => c.method === "apply" && c.caller === "keeper");
  assert.ok(applies.length >= 4);
  assert.match(renderStretch(out), /receiver vault\.f\.testnet, methods request_withdraw,send_small/);
});

test("step 8: the token went only to the safe account; the oversized request fails as sweep_failed and loses nothing", async () => {
  const world = makeWorld();
  const out = await run(world);
  const r = stepOf(out, "ft");
  assert.equal(r.ok, true, failedChecks(r).join("; "));
  const ft = (id) => world.w.ft.get(id) ?? 0n;
  assert.equal(ft(state.supplier), 100n);
  assert.equal(ft(state.vault), 900n);
  assert.equal(ft(state.kizashi), 0n);
  const text = renderStretch(out);
  assert.match(text, /EVENT sweep_failed found/);
  assert.match(text, /failed-sweep tx TX/);
  assert.match(text, /request \d+ gone/);
  assert.equal(world.w.queue.length, 0);
});

test("step 8 fails if the token sweep pays the payee, or a failed sweep puts the request back", async () => {
  const a = stepOf(await run(makeWorld({ bug: { paysPayee: true } })), "ft");
  assert.equal(a.ok, false);
  const b = stepOf(await run(makeWorld({ bug: { putBack: true } })), "ft");
  assert.ok(b.checks.some((c) => !c.ok && /not put back|gone from the queue/.test(c.name)));
});

test("the policy account has its own key: made before it is funded, different from the keeper's, and the keeper cannot propose", async () => {
  const world = makeWorld();
  const out = await run(world);
  const policy = stepOf(out, "policy");
  assert.ok(policy.checks.some((c) => /key is not the keeper's/.test(c.name) && c.ok));
  assert.ok(policy.checks.some((c) => /the keeper .* proposing is refused/.test(c.name) && c.ok));
  assert.ok(world.w.log.indexOf("key:policy") < world.w.log.indexOf(`create:${POLICY}`), world.w.log.join(" "));
  assert.ok(world.w.log.indexOf("key:token") < world.w.log.indexOf(`create:${TOKEN}`));
});

test("a second run reuses every account and key: nothing is created twice and it still passes", async () => {
  const world = makeWorld();
  await run(world);
  const creates = world.w.log.filter((l) => l.startsWith("create:")).length;
  assert.equal(creates, 3);
  const again = await run(world, { plan: planOf({ recipient: "stretchdrill-ffffffff.testnet" }) });
  assert.equal(again.ok, true, renderStretch(again));
  assert.equal(world.w.log.filter((l) => l.startsWith("create:")).length, 3);
  assert.match(renderStretch(again), /exists \(resumed run\) and the key on file is its key/);
});

test("preflight prints the NEAR needed against what the funder holds, and a short funder stops the run before anything is sent", async () => {
  const world = makeWorld({ funderHas: 1n * NEAR });
  const dry = await runStretchDrill({ plan: planOf(), state, io: world.io, yes: false, cage: fakeCage });
  assert.equal(dry.pre.ok, false);
  assert.match(renderStretch(dry), /needed 1.086 NEAR \(policy 0\.055, watcher 0\.061, token 0\.950, gas margin 0\.020\) vs available 1\.000 NEAR.*SHORT by/);
  await assert.rejects(run(world), /preflight failed/);
  assert.equal(world.w.calls.length, 0);
  const rich = await runStretchDrill({ plan: planOf(), state, io: makeWorld().io, yes: false, cage: fakeCage });
  assert.equal(rich.pre.ok, true);
  assert.match(renderStretch(rich), /needed 1.086 NEAR \(policy 0\.055, watcher 0\.061, token 0\.950, gas margin 0\.020\) vs available 50\.000 NEAR/);
});

test("the NOT COVERED list names what is still not covered", () => {
  const text = renderStretch({ plan: planOf(), dryRun: true, pre: { checks: [] } });
  assert.match(text, /UNREGISTERED safe account/);
  assert.doesNotMatch(text, /watcher path .* not run here/);
});

test("resumable: accounts a failed run left (watcher short of NEAR, window open, a request queued) are reused and topped up, not recreated, and the run passes", async () => {
  const world = makeWorld();
  await run(world); // creates the three accounts, then the world is left as a half-done earlier run would
  const creates = () => world.w.log.filter((l) => l.startsWith("create:")).length;
  // the watcher is drained below what a sweep needs, a window is still open, the watcher is still registered
  world.w.accounts.set(WATCHER, { amount: (NEAR / 100n).toString(), storage_usage: 100 });
  world.w.watchers.push(WATCHER);
  world.w.emergencyUntil = world.w.now + 600n * 10n ** 9n;
  const again = await run(world, { plan: planOf({ recipient: "stretchdrill-eeeeeeee.testnet" }) });
  assert.equal(again.ok, true, renderStretch(again));
  assert.equal(creates(), 3, "no account is created twice");
  assert.ok(BigInt(world.w.accounts.get(WATCHER).amount) >= fundForCalls(30, 9) - NEAR / 100n);
  assert.match(renderStretch(again), /the funder topped sd-watcher\.funder\.testnet up by/);
  assert.match(renderStretch(again), /already in force \(resumed run\)|already registered|window from an earlier run was still open/);
});

test("accounts named in the actors file are reused whichever funder is given, and a different funder pays the top-up", () => {
  const plan = planOf({ funderId: "other-funder.testnet", existingActors: { policy: POLICY, watcher: WATCHER } });
  assert.equal(plan.actors.policy.id, POLICY);
  assert.equal(plan.actors.watcher.id, WATCHER);
  assert.equal(plan.actors.token.id, "sd-token.other-funder.testnet");
});

test("the watcher's sweep attaches gas measured from the admin's sweep, with a margin, between 30 and 60 Tgas; funding follows the attached gas", () => {
  assert.equal(watcherSweepTgas(null), 30);
  assert.equal(watcherSweepTgas(7n * 10n ** 12n), 30);
  assert.equal(watcherSweepTgas(20n * 10n ** 12n), 50);
  assert.equal(watcherSweepTgas(200n * 10n ** 12n), 60);
  // the first real run: 60 Tgas attached cost 0.0609 NEAR, so a watcher must hold more than that for 60 and funding must cover 30 Tgas at the same rate
  assert.ok(fundForCalls(60, 1) > (NEAR * 609n) / 10000n);
  assert.ok(fundForCalls(30, 9) > (NEAR * 3045n) / 100000n);
});

test("a failing step 6 does not skip steps 7 and 8: each runs and is reported on its own", async () => {
  const out = await run(makeWorld({ bug: { watcherAlways: true } }));
  const by = Object.fromEntries(out.results.map((r) => [r.id, r]));
  assert.equal(by.watcher.ok, false);
  assert.equal(by.proposals.ok, true, failedChecks(by.proposals).join("; "));
  assert.equal(by.ft.ok, true, failedChecks(by.ft).join("; "));
  assert.ok(!by.proposals.skipped && !by.ft.skipped);
  assert.match(renderStretch(out), /FAIL  step 6 /);
  assert.match(renderStretch(out), /PASS  step 7 /);
  assert.match(renderStretch(out), /PASS  step 8 /);
});

test("the watcher's sweep: the signing watcher may appear among the executors, but value must not reach anyone else", async () => {
  const ok = stepOf(await run(makeWorld()), "watcher");
  assert.ok(ok.checks.some((c) => /signing watcher only/.test(c.name) && c.ok && /sd-watcher/.test(c.detail)));
  assert.ok(ok.checks.some((c) => /signing watcher was not credited/.test(c.name) && c.ok));
  const bad = stepOf(await run(makeWorld({ bug: { paysPayee: true } })), "watcher");
  assert.ok(bad.checks.some((c) => !c.ok && /payee received nothing|safe account received exactly/.test(c.name)));
});

test("a step that needs another (policy) is skipped when that step did not pass", async () => {
  const out = await run(makeWorld({ bug: { strangerCanSweep: true } }));
  const by = Object.fromEntries(out.results.map((r) => [r.id, r]));
  assert.equal(by.policy.skipped, true);
  assert.equal(by.proposals.skipped, true);
});
