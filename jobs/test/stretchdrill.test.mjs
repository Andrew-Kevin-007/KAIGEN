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
const RECIPIENT = "stretchdrill-0a1b2c3d.testnet";
const planOf = (over = {}) => planStretchDrill({ state, recipient: RECIPIENT, ...over });

/** The vault's gates as STRETCH-DESIGN.md states them, with knobs (`bug`) to break one. */
function makeWorld({ bug = {}, vaultFree = 1n * NEAR, drillBuild = true, chain = "testnet", safeInForce = false, preQueued = false, txNs = 2n * 10n ** 9n } = {}) {
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
    delayNs: 10n * 10n ** 9n,
    accounts: new Map(),
  };
  const storage = 400_000;
  const acc = (amount) => ({ amount: amount.toString(), storage_usage: storage });
  w.accounts.set(state.vault, acc(BigInt(storage) * 10n ** 19n + vaultFree));
  for (const id of [state.supplier, state.kizashi, state.keeper.id]) w.accounts.set(id, acc(5n * NEAR));
  w.accounts.set("funder.testnet", acc(50n * NEAR));
  if (safeInForce) w.safe = { current: state.supplier, pending: null };
  if (preQueued) w.queue.push({ id: "1", amount: SWEEP_YOCTO.toString(), to: state.kizashi, token: null });
  const add = (id, d) => w.accounts.set(id, { ...w.accounts.get(id), amount: (BigInt(w.accounts.get(id).amount) + d).toString() });
  const panic = (text) => {
    throw new Error(`transaction TX${w.n}1111111111111111111111111111111111 failed: {"ActionError":{"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: ${text}"}}}}`);
  };
  const safeNow = () => {
    const s = w.safe;
    return s.pending && w.now >= s.pending.effective_at ? s.pending.account : s.current;
  };
  const tick = () => {
    w.now += txNs;
    w.n += 1;
  };
  // caller: "admin" | "keeper" | "daily"
  function exec(caller, method, args) {
    tick();
    w.calls.push({ caller, method });
    const hash = `HASH${w.n}`;
    const logs = [];
    const ret = { hash, outcome: { ns: String(w.now), status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { executor_id: state.vault, logs } }] } };
    const admin = caller === "admin";
    const needAdmin = () => !admin && panic("admin only");
    switch (method) {
      case "set_safe_account":
        needAdmin();
        if (args.account === state.vault) panic("the safe account cannot be the vault itself");
        if (w.safe.pending && w.now >= w.safe.pending.effective_at) w.safe = { current: w.safe.pending.account, pending: null };
        w.safe.pending = { account: args.account, effective_at: w.now + w.delayNs };
        return ret;
      case "request_withdraw": {
        const id = w.nextReq++;
        w.queue.push({ id: String(id), amount: args.amount, to: args.to });
        return ret;
      }
      case "sweep_to_safe": {
        if (caller === "daily" && !bug.dailyCanSweep) throw new Error(bug.chainWording ? `fastnear: signer key is not permitted for ${state.vault}` : "InvalidAccessKeyError MethodNameMismatch { method_name: \"sweep_to_safe\" }");
        if (!admin && !bug.strangerCanSweep && !(caller === "daily" && bug.dailyCanSweep)) panic("admin or watcher only");
        const safe = safeNow();
        if (!safe) panic("no safe account is in force");
        const i = w.queue.findIndex((q) => q.id === args.id);
        if (i < 0) panic("no such request");
        const [q] = w.queue.splice(i, 1);
        const dest = bug.paysPayee ? q.to : safe;
        add(state.vault, -BigInt(q.amount) - 4n * 10n ** 21n);
        add(dest, BigInt(q.amount));
        logs.push(`EVENT_JSON:{"event":"sweep_to_safe","data":[{"id":"${args.id}","by":"${state.vault}","safe":"${safe}"}]}`);
        ret.outcome.receipts_outcome.push({ outcome: { executor_id: dest, logs: [] } });
        return ret;
      }
      case "set_policy_account":
        needAdmin();
        w.policy = args.account;
        w.proposals = [];
        return ret;
      case "propose_allow_recipient":
      case "propose_set_token_limit":
        if (caller !== "keeper" || w.policy !== state.keeper.id) panic("policy account only");
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
        w.proposals = w.proposals.filter((x) => x !== p);
        return ret;
      }
      default:
        throw new Error(`fake vault has no ${method}`);
    }
  }
  const rpc = {
    async status() {
      return { chain_id: w.chain, protocol_version: 88 };
    },
    async account(id) {
      return w.accounts.get(id) ? { ...w.accounts.get(id), code_hash: "CODEHASH" } : null;
    },
    async accessKeys() {
      return [{ public_key: ADMIN, access_key: { permission: "FullAccess" } }];
    },
    async view(_c, method, args) {
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
          return [state.daily.publicKey];
        case "pending_limit":
          assert.deepEqual(args, { token: null });
          return String(10n * NEAR);
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
  const io = {
    rpc,
    adminHandle: ADMIN,
    receiptNs: (o) => BigInt(o.ns),
    admin: async (actions) => exec("admin", actions[0].method, actions[0].args),
    keeper: async (actions) => exec("keeper", actions[0].method, actions[0].args),
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
  return { w, io, funded };
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

test("the full run: five steps, in order, each PASS with a transaction hash", async () => {
  const world = makeWorld();
  const out = await run(world);
  assert.equal(out.ok, true, renderStretch(out));
  assert.deepEqual(out.results.map((r) => [r.n, r.ok]), [[1, true], [2, true], [3, true], [4, true], [5, true]]);
  const order = world.w.calls.map((c) => `${c.caller}:${c.method}`);
  const at = (s) => order.indexOf(s);
  assert.ok(at("admin:set_safe_account") === 0, order.join(" "));
  assert.ok(at("daily:request_withdraw") > at("admin:set_safe_account"));
  assert.ok(at("keeper:sweep_to_safe") > at("daily:request_withdraw"));
  assert.ok(order.lastIndexOf("admin:sweep_to_safe") > at("daily:sweep_to_safe"), "the real sweep comes after the refusals");
  assert.ok(at("admin:set_policy_account") > order.lastIndexOf("admin:sweep_to_safe"));
  assert.ok(at("admin:cancel_proposal") > at("keeper:propose_set_token_limit"));
  assert.ok(order.indexOf("keeper:apply") < order.lastIndexOf("keeper:apply"), "apply is tried early (refused) then after the wait");
  const text = renderStretch(out);
  for (const n of [1, 2, 3, 4, 5]) assert.match(text, new RegExp(`PASS  step ${n} `));
  assert.match(text, /PASS  step 2 sweep .* tx HASH\d+ HASH\d+/);
  assert.match(text, /RED on ATTEST-2 by design/);
});

test("the sweep moved value only to the safe account: the payee got nothing, the safe account got exactly the amount", async () => {
  const world = makeWorld();
  await run(world);
  const b = (id) => BigInt(world.w.accounts.get(id).amount);
  assert.equal(b(state.supplier), 5n * NEAR + SWEEP_YOCTO);
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
  assert.equal(calls.filter((c) => c === "daily:request_withdraw").length, 0, "no new request");
  assert.equal(calls.filter((c) => c === "admin:set_safe_account").length, 1, "only the refused set_safe_account(vault)");
  assert.equal(calls.filter((c) => c === "admin:sweep_to_safe").length, 1);
  assert.match(renderStretch(out), /already in force \(resumed run\)/);
  assert.match(renderStretch(out), /already queued \(resumed run\)/);
});

test("resumable: with no safe account in force and an empty queue it does the whole setup", async () => {
  const world = makeWorld();
  await run(world);
  const calls = world.w.calls.map((c) => `${c.caller}:${c.method}`);
  assert.equal(calls.filter((c) => c === "daily:request_withdraw").length, 1);
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
  assert.ok(first > calls.indexOf("keeper:propose_allow_recipient"));
  assert.ok(first < calls.indexOf("keeper:propose_set_token_limit"), calls.join(" "));
  assert.ok(calls.lastIndexOf("keeper:apply") > calls.indexOf("admin:cancel_proposal"));
});

test("policy step on a chain slower than the delay: an early apply that goes through is legitimate, not a failure, and is not applied twice", async () => {
  const world = makeWorld({ txNs: 11n * 10n ** 9n });
  const out = await run(world);
  const policy = out.results.find((r) => r.id === "policy");
  assert.equal(policy.ok, true, renderStretch(out));
  assert.match(policy.checks.map((c) => c.name).join(" | "), /could not be tested: the delay was already over/);
  assert.equal(world.w.calls.filter((c) => c.method === "apply").length, 1);
  assert.deepEqual(world.w.allowed, [RECIPIENT]);
});

test("policy step: an apply that succeeds while chain time says it is still locked fails the step and cascades nothing", async () => {
  const out = await run(makeWorld({ bug: { applyEarly: true } }));
  const policy = out.results.find((r) => r.id === "policy");
  assert.equal(policy.ok, false);
  assert.ok(policy.checks.some((c) => !c.ok && /apply before the delay is refused/.test(c.name)));
  assert.ok(!policy.checks.some((c) => /step ran to the end/.test(c.name)));
});
