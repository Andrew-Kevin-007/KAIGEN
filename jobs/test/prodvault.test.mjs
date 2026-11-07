// prodvault (jobs/src/prodvault.mjs, `prodvault` in bin.mjs). Nothing here touches a network: the chain is an in-memory fake
// (test/fixtures/fake-chain.mjs) and the sender applies the action descriptors to it. Every key is generated in memory by the test.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { adminSigner, newClassicalKey } from "../src/globaltx.mjs";
import { GlobalUsage, Refused } from "../src/globalcontract.mjs";
import { assertSecretsDir, NOT_COVERED, parseProdVaultArgs, planProdVault, preflight, renderRun, runProdVault, VAULT_YOCTO } from "../src/prodvault.mjs";
import { codeHashOf } from "../src/verify.mjs";
import { fakeRpc, fakeSender, makeWorld, NEAR, READ_METHODS } from "./fixtures/fake-chain.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "..", "src", "bin.mjs");
const FUNDER = "funder.testnet";
const KIZASHI = "kizashi.testnet";
const SUPPLIER = "supplier.funder.testnet";
const SUFFIX = "0a1b2c3d";
const VAULT = `pv-${SUFFIX}.${FUNDER}`;

const tmpDirs = [];
const tmp = (p = "pv-") => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  tmpDirs.push(d);
  return d;
};
process.on("exit", () => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

// ---- a small valid wasm with Mamori's entry points ----------------------------------------------------------------

const leb = (n) => {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};
const section = (id, bytes) => [id, ...leb(bytes.length), ...bytes];
function wasmWithExports(names, paddingBytes = 0) {
  const type = section(1, [1, 0x60, 0, 0]);
  const func = section(3, [names.length, ...names.map(() => 0)]);
  const exps = section(7, [names.length, ...names.flatMap((n, i) => [...leb(n.length), ...Buffer.from(n), 0x00, i])]);
  const code = section(10, [names.length, ...names.flatMap(() => [2, 0, 0x0b])]);
  const pad = paddingBytes ? section(0, [1, 0x78, ...new Array(paddingBytes - 2).fill(0)]) : [];
  return Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...type, ...func, ...exps, ...code, ...pad]);
}
const MAMORI = wasmWithExports(["init", "send_small", "request_withdraw", "execute", "config", "attest"]);
const HASH = codeHashOf(MAMORI);
const funderKey = newClassicalKey();
const funder = { accountId: FUNDER, publicKey: funderKey.publicKey, signer: funderKey.signer };

const worldOf = (over = {}) => makeWorld({ funderId: FUNDER, funderPublic: funderKey.publicKey, extraAccounts: [KIZASHI], ...over });
const planOf = (over = {}) => planProdVault({ wasm: MAMORI, wasmPath: "mamori.wasm", funderId: FUNDER, kizashi: KIZASHI, supplier: SUPPLIER, suffix: SUFFIX, ...over });

/** Hands out the keys the run asks for, and remembers them so a test can look for them in the output. */
function keyKit(dir) {
  const made = { classical: [], admins: [] };
  return {
    made,
    newKey: () => {
      const k = newClassicalKey();
      made.classical.push(k);
      return k;
    },
    makeAdmin: (a) => {
      const s = adminSigner({ seedFile: path.join(dir, "admin-seeds.json"), ...a });
      made.admins.push(s);
      return s;
    },
  };
}

// ---- the plan -----------------------------------------------------------------------------------------------------

test("plan: a sub-account of the funder, 4.9 NEAR, init with the production delay in the SAME transaction as the deploy, then ML-DSA enrol, lock, policy", () => {
  const plan = planOf();
  assert.equal(plan.vault, VAULT);
  assert.deepEqual(plan.steps.map((s) => s.id), ["create", "deploy", "enrol", "lock", "policy"]);
  const [create, deploy, enrol, lock, policy] = plan.steps;
  assert.deepEqual(create.actions.map((a) => a.type), ["CreateAccount", "Transfer", "AddKey"]);
  assert.equal(create.actions[1].yocto, 4_900n * 10n ** 21n);
  assert.equal(VAULT_YOCTO, 4_900n * 10n ** 21n);
  assert.deepEqual(deploy.actions.map((a) => a.type), ["DeployContract", "FunctionCall"], "deploy and init ride in one transaction");
  assert.deepEqual(deploy.actions[1].args, { kizashi: KIZASHI, daily_limit: NEAR.toString(), delay_secs: 86_400 });
  assert.equal(deploy.actions[1].method, "init");
  assert.deepEqual(enrol.actions.map((a) => a.type), ["AddKey"]);
  assert.deepEqual(lock.actions.map((a) => a.type), ["DeleteKey"]);
  assert.deepEqual(policy.actions.map((a) => a.method), ["allow_recipient", "enforce_allowlist", "add_daily_key"]);
  assert.deepEqual(policy.actions[0].args, { account: SUPPLIER });
  assert.deepEqual(policy.actions[1].args, { on: true });
  assert.equal(policy.actions[2].args.allowance, null, "the rehearsal's pattern: allowance null, the vault applies its default");
  assert.equal(plan.wasm.codeHash, HASH);
});

test("plan: the real out/prod/mamori.wasm (432,906 bytes) fits in 4.9 NEAR; a wasm whose storage does not is refused before any NEAR is at stake", (t) => {
  const real = path.join(here, "..", "..", "out", "prod", "mamori.wasm");
  if (fs.existsSync(real)) {
    const plan = planProdVault({ wasm: fs.readFileSync(real), wasmPath: real, funderId: FUNDER, kizashi: KIZASHI, suffix: SUFFIX });
    assert.ok(plan.estimate.workingYocto > NEAR / 4n, `storage ${plan.estimate.storageYocto} leaves ${plan.estimate.workingYocto}`);
  } else t.diagnostic("out/prod/mamori.wasm is not built here; the real-size check was skipped");
  const big = wasmWithExports(["init", "send_small", "request_withdraw", "execute", "config"], 480_000);
  assert.throws(() => planOf({ wasm: big }), (e) => e instanceof Refused && /too large for 4\.9 NEAR/.test(e.message));
});

test("plan: refuses a wasm that is not Mamori, a mainnet-looking funder, a bad kizashi and a bad suffix", () => {
  assert.throws(() => planOf({ wasm: wasmWithExports(["init"]) }), (e) => e instanceof Refused && /not Mamori/.test(e.message));
  assert.throws(() => planOf({ funderId: "kevin.near" }), (e) => e instanceof Refused && /mainnet/.test(e.message));
  assert.throws(() => planOf({ funderId: "near" }), (e) => e instanceof Refused);
  assert.throws(() => planOf({ kizashi: "Not An Account" }), (e) => e instanceof GlobalUsage);
  assert.throws(() => planOf({ suffix: "xyz" }), (e) => e instanceof GlobalUsage);
  assert.equal(planOf({ supplier: undefined }).supplier, `supplier.${FUNDER}`, "the default supplier is a sub-account name of the funder");
});

// ---- dry run ------------------------------------------------------------------------------------------------------

test("dry run: reads the chain, prints the plan and what is not covered, signs and sends nothing, makes no key and writes no file", async () => {
  const w = worldOf();
  const dir = path.join(tmp(), "never-made");
  const out = await runProdVault({
    plan: planOf(),
    rpc: fakeRpc(w),
    funder,
    sender: async () => assert.fail("a dry run must not send"),
    newKey: () => assert.fail("a dry run must not make a key"),
    makeAdmin: () => assert.fail("a dry run must not make an admin key"),
    dir,
  });
  assert.equal(out.dryRun, true);
  assert.equal(out.pre.ok, true);
  assert.ok(w.requests.length > 0 && w.requests.every((r) => READ_METHODS.has(r.name)), `only reads: ${[...new Set(w.requests.map((r) => r.name))]}`);
  assert.equal(w.sent.length, 0);
  assert.ok(!fs.existsSync(dir), "no secrets folder is created by a dry run");
  const text = renderRun(out);
  assert.match(text, new RegExp(HASH));
  assert.match(text, /PASS {2}funder balance covers 4\.9 NEAR and a margin/);
  assert.match(text, /PASS {2}vault name is free/);
  assert.match(text, /PASS {2}the Kizashi account exists/);
  assert.match(text, /NOT COVERED:/);
  for (const line of NOT_COVERED) assert.ok(text.includes(line));
  assert.match(text, /PRODUCTION omens/);
  assert.match(text, /testnet only, no audit, not run on mainnet/);
  assert.equal(w.accounts.size, 2 + 0, "the world is unchanged (funder and kizashi only)");
});

test("dry run without a funder file still plans, and says what it did not check", async () => {
  const w = worldOf();
  const out = await runProdVault({ plan: planOf({ funderId: null, supplier: undefined }), rpc: fakeRpc(w), funder: null });
  assert.equal(out.pre.ok, true);
  assert.deepEqual(out.pre.checks.filter((c) => c.skipped).map((c) => c.name), ["the supplier account (information)", "funder balance and key", "vault account"]);
  assert.match(renderRun(out), /<funder>/);
  assert.ok(w.requests.every((r) => !JSON.stringify(r.args).includes("<")), "no placeholder is ever sent to the node as an account id");
});

// ---- refusals -----------------------------------------------------------------------------------------------------

test("refuses mainnet: a node that says mainnet fails the first check, and --yes sends nothing and creates no key", async () => {
  const w = worldOf({ chain: "mainnet" });
  const dir = path.join(tmp(), "none");
  const dry = await runProdVault({ plan: planOf(), rpc: fakeRpc(w), funder });
  assert.equal(dry.pre.ok, false);
  assert.match(renderRun(dry), /FAIL {2}chain is the one asked for, and is not mainnet.*chain_id mainnet: this tool is testnet only/);
  await assert.rejects(
    runProdVault({ plan: planOf(), rpc: fakeRpc(w), funder, sender: async () => assert.fail("must not send"), newKey: () => assert.fail("no key"), makeAdmin: () => assert.fail("no key"), dir, yes: true }),
    (e) => e instanceof Refused && /preflight failed, nothing was sent/.test(e.message),
  );
  const asked = await preflight({ rpc: fakeRpc(worldOf()), plan: planOf(), funderKey: funder.publicKey, expectedChain: "mainnet" });
  assert.equal(asked.ok, false, "asking for mainnet is refused even on a testnet node");
  assert.ok(!fs.existsSync(dir));
});

test("refuses when the funder balance is too small (4.9 NEAR plus a margin): nothing is sent, no key is made", async () => {
  const w = worldOf({ funderYocto: 5n * NEAR - 1n });
  const dir = path.join(tmp(), "none");
  const dry = await runProdVault({ plan: planOf(), rpc: fakeRpc(w), funder });
  assert.equal(dry.pre.ok, false);
  assert.match(renderRun(dry), /FAIL {2}funder balance covers 4\.9 NEAR and a margin.*needs 5\.0000 NEAR/);
  await assert.rejects(runProdVault({ plan: planOf(), rpc: fakeRpc(w), funder, sender: async () => assert.fail("must not send"), newKey: () => assert.fail("no key"), makeAdmin: () => assert.fail("no key"), dir, yes: true }), (e) => e instanceof Refused);
  assert.ok(!fs.existsSync(dir));
  const exact = await runProdVault({ plan: planOf(), rpc: fakeRpc(worldOf({ funderYocto: 5n * NEAR + 182n * 10n ** 19n })), funder });
  assert.equal(exact.pre.ok, true, "exactly 5 NEAR available (after the funder's own storage) is enough");
});

test("refuses: no funder with --yes, another account's funder file, a missing Kizashi, a funder key that is not on the funder, a vault name already taken", async () => {
  const w = worldOf();
  const base = { plan: planOf(), rpc: fakeRpc(w), sender: async () => assert.fail("must not send"), newKey: () => assert.fail("no key"), makeAdmin: () => assert.fail("no key"), dir: path.join(tmp(), "none"), yes: true };
  await assert.rejects(runProdVault({ ...base, funder: null }), /--yes needs --funder-file/);
  await assert.rejects(runProdVault({ ...base, funder: { ...funder, accountId: "other.testnet" } }), /funder file is for other\.testnet/);
  const missingKizashi = await runProdVault({ plan: planOf({ kizashi: "gone.testnet" }), rpc: fakeRpc(w), funder });
  assert.match(renderRun(missingKizashi), /FAIL {2}the Kizashi account exists.*gone\.testnet does not exist/);
  const stranger = newClassicalKey();
  const foreign = await runProdVault({ plan: planOf(), rpc: fakeRpc(w), funder: { ...funder, publicKey: stranger.publicKey } });
  assert.match(renderRun(foreign), /FAIL {2}funder file's key is a full-access key of the funder/);
  w.accounts.set(VAULT, { amount: "0", storage_usage: 182, code_hash: "11111111111111111111111111111111" });
  const taken = await runProdVault({ plan: planOf(), rpc: fakeRpc(w), funder });
  assert.match(renderRun(taken), /FAIL {2}vault name is free/);
});

// ---- the run ------------------------------------------------------------------------------------------------------

async function realRun(over = {}) {
  const w = over.world ?? worldOf();
  const dir = over.dir ?? tmp();
  const events = [];
  const logs = [];
  const kit = keyKit(dir);
  const seen = [];
  const sender = fakeSender(w, events, {
    before: () => {
      // What is on disk at the moment of each send: the keys must already be there before they can hold anything.
      seen.push({ accounts: fs.existsSync(path.join(dir, "accounts.json")), seeds: fs.existsSync(path.join(dir, "admin-seeds.json")), record: fs.existsSync(path.join(dir, `prodvault-${VAULT}.json`)) });
    },
  });
  const out = await runProdVault({ plan: planOf(), rpc: fakeRpc(w), funder, sender: over.sender?.(sender, w) ?? sender, newKey: kit.newKey, makeAdmin: kit.makeAdmin, dir, yes: true, log: (e) => logs.push(e) });
  return { w, dir, events, logs, kit, out, seen };
}

test("run: five transactions in the order create, deploy+init, enrol, lock, policy; the signers are the funder, the classical key twice, then the ML-DSA key twice", async () => {
  const { events, kit, out, w } = await realRun();
  const sends = events.filter((e) => e.kind === "send");
  assert.deepEqual(sends.map((s) => [s.signerId, s.receiverId, s.actions.map((a) => a.type).join("+")]), [
    [FUNDER, VAULT, "CreateAccount+Transfer+AddKey"],
    [VAULT, VAULT, "DeployContract+FunctionCall"],
    [VAULT, VAULT, "AddKey"],
    [VAULT, VAULT, "DeleteKey"],
    [VAULT, VAULT, "FunctionCall+FunctionCall+FunctionCall"],
  ]);
  const [boot, agent] = kit.made.classical;
  const [admin] = kit.made.admins;
  assert.equal(kit.made.classical.length, 2, "one bootstrap key and one agent key, nothing else");
  assert.equal(sends[0].signer, funder.signer);
  assert.equal(sends[1].signer, boot.signer, "deploy+init is signed by the vault's own (classical) key: init is private");
  assert.equal(sends[2].signer, boot.signer);
  assert.equal(sends[3].signer, admin, "the classical key is deleted BY the ML-DSA key");
  assert.equal(sends[4].signer, admin);
  assert.equal(sends[0].actions[2].publicKey, boot.publicKey);
  assert.equal(sends[0].actions[1].yocto, 4_900n * 10n ** 21n);
  assert.ok(Buffer.from(sends[1].actions[0].code).equals(MAMORI), "the bytes deployed are the bytes hashed");
  assert.deepEqual(sends[1].actions[1].args, { kizashi: KIZASHI, daily_limit: NEAR.toString(), delay_secs: 86_400 });
  assert.equal(sends[2].actions[0].publicKey, admin.publicKey);
  assert.equal(sends[3].actions[0].publicKey, boot.publicKey, "it deletes exactly the key step 1 added");
  assert.deepEqual(sends[4].actions.map((a) => [a.method, a.args]), [
    ["allow_recipient", { account: SUPPLIER }],
    ["enforce_allowlist", { on: true }],
    ["add_daily_key", { public_key: agent.publicKey, allowance: null }],
  ]);
  assert.deepEqual(out.rec.txs, { create: "TX1", deploy: "TX2", enrol: "TX3", lock: "TX4", policy: "TX5" });
  // The chain at the end: the ML-DSA key is the only FULL-access key, the classical one is gone, one agent function-call key.
  const listed = w.keys.get(VAULT);
  assert.deepEqual(listed.filter((k) => k.permission === "FullAccess").map((k) => k.listed), [admin.publicKeyHandle]);
  assert.ok(!listed.some((k) => k.full === boot.publicKey));
  assert.equal(listed.filter((k) => k.permission !== "FullAccess").length, 1);
  assert.equal(w.accounts.get(VAULT).code_hash, HASH);
});

test("run: every key is on disk before the first transaction, and the cage-check ends GREEN on every row, with the admin compared by the library's own handle (no stand-in admin)", async () => {
  const { seen, out, dir } = await realRun();
  assert.deepEqual(seen[0], { accounts: true, seeds: true, record: true });
  assert.equal(out.rec.ok, true, JSON.stringify(out.checks.filter((c) => !c.ok)));
  assert.equal(out.cage.verdict, "GREEN");
  assert.equal(out.cage.mode, "production", "the stand-in admin is not used");
  assert.equal(out.cage.conditions.length, 15);
  assert.ok(out.cage.conditions.every((c) => c.status === "GREEN"), out.cage.conditions.map((c) => `${c.id} ${c.status}`).join(", "));
  const text = renderRun(out);
  assert.match(text, /GREEN {1,3}ARCH-2\.8-2 .*ml-dsa-65-hash:/);
  assert.match(text, /GREEN: all 15 conditions hold\./);
  assert.match(text, /PASS {2}the vault's only full-access key is the ML-DSA-65 admin/);
  assert.match(text, /NOT COVERED:/);
  assert.deepEqual(out.rec.cage.rows.map((r) => r.status), new Array(15).fill("GREEN"));
  const accounts = JSON.parse(fs.readFileSync(path.join(dir, "accounts.json"), "utf8"));
  assert.ok(accounts[VAULT].privateKey, "the classical key is saved the way the rehearsal saves it");
});

test("run: no secret is ever printed, logged or returned: not the classical keys, not the agent key, not the admin seed", async () => {
  const { out, logs, kit, dir } = await realRun();
  const seedHex = JSON.parse(fs.readFileSync(path.join(dir, "admin-seeds.json"), "utf8"))[VAULT];
  assert.match(seedHex, /^[0-9a-f]{64}$/);
  const secrets = [...kit.made.classical.map((k) => k.privateKey), seedHex];
  assert.equal(secrets.length, 3);
  const everything = [renderRun(out), JSON.stringify(logs), JSON.stringify(out.rec, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), JSON.stringify(out.checks)].join("\n");
  for (const s of secrets) assert.ok(!everything.includes(s), "a secret appeared in the output");
  assert.ok(!/privateKey|private_key|seed/i.test(JSON.stringify(out.rec)), "the returned record has no secret field");
  // The public halves ARE printed: they are how the chain is checked.
  assert.ok(everything.includes(kit.made.classical[1].publicKey));
  // The only place the agent key's secret lives is the record in the gitignored folder.
  const record = JSON.parse(fs.readFileSync(path.join(dir, `prodvault-${VAULT}.json`), "utf8"));
  assert.equal(record.daily.privateKey, kit.made.classical[1].privateKey);
  assert.deepEqual(record.completed, ["create", "deploy", "enrol", "lock", "policy"]);
});

test("run: if the ML-DSA key does not show on the chain after it was added, the classical key is NOT deleted and the run stops saying nothing is locked", async () => {
  const world = worldOf();
  const dir = tmp();
  const kit = keyKit(dir);
  const real = fakeSender(world, []);
  const sender = async (tx) => (tx.actions.length === 1 && tx.actions[0].type === "AddKey" && tx.actions[0].publicKey.startsWith("ml-dsa-65:") ? { hash: "LOST", outcome: {} } : real(tx));
  await assert.rejects(runProdVault({ plan: planOf(), rpc: fakeRpc(world), funder, sender, newKey: kit.newKey, makeAdmin: kit.makeAdmin, dir, yes: true }), (e) => e instanceof Refused && /NOT deleted, nothing is locked/.test(e.message) && /stopped after: create, deploy, enrol/.test(e.message));
  assert.ok(world.keys.get(VAULT).some((k) => k.permission === "FullAccess" && k.full === kit.made.classical[0].publicKey), "the classical key is still there");
});

test("run: a failure part-way (init refused) stops, keeps the keys and the record, says where, and does not retry", async () => {
  const world = worldOf();
  const dir = tmp();
  const kit = keyKit(dir);
  let calls = 0;
  const real = fakeSender(world, []);
  const sender = async (tx) => {
    calls += 1;
    if (tx.actions[0].type === "DeployContract") throw new Error("transaction TXBAD failed: init panicked");
    return real(tx);
  };
  await assert.rejects(runProdVault({ plan: planOf(), rpc: fakeRpc(world), funder, sender, newKey: kit.newKey, makeAdmin: kit.makeAdmin, dir, yes: true }), (e) => /init panicked/.test(e.message) && /stopped after: create;/.test(e.message) && e.message.includes(dir));
  assert.equal(calls, 2, "no retry");
  const record = JSON.parse(fs.readFileSync(path.join(dir, `prodvault-${VAULT}.json`), "utf8"));
  assert.deepEqual(record.completed, ["create"]);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, "accounts.json"), "utf8"))[VAULT].privateKey);
});

test("run: the production floor is real in the fake world too: a delay under 86,400 is refused by init (the plan never sends one)", async () => {
  const { events } = await realRun();
  const init = events.filter((e) => e.kind === "send")[1].actions[1];
  assert.equal(init.args.delay_secs, 86_400);
});

// ---- arguments, the secrets folder, the command line ----------------------------------------------------------------

test("args: defaults and every usage error", () => {
  const d = { wasm: "w.wasm", funderFile: "env-funder.json" };
  const o = parseProdVaultArgs(["--kizashi", KIZASHI], d);
  assert.deepEqual([o.kizashi, o.funderFile, o.wasm, o.yes, o.chainId, o.rpc], [KIZASHI, "env-funder.json", "w.wasm", false, "testnet", "https://rpc.testnet.fastnear.com"]);
  assert.equal(parseProdVaultArgs(["--kizashi", KIZASHI, "--funder-file", "f.json", "--supplier", SUPPLIER, "--yes"], d).yes, true);
  const bad = (argv, re) => assert.throws(() => parseProdVaultArgs(argv, d), (e) => e instanceof GlobalUsage && re.test(e.message));
  bad([], /--kizashi/);
  bad(["--kizashi"], /needs a value/);
  bad(["--kizashi", KIZASHI, "--kizashi", "b.testnet"], /given twice/);
  bad(["--kizashi", KIZASHI, "--frobnicate"], /unknown option/);
  bad(["--kizashi", KIZASHI, "stray"], /unexpected argument/);
  bad(["--kizashi", KIZASHI, "--chain-id", "mainnet"], /testnet only/);
});

test("the secrets folder: inside the repository only .kaigen-testnet* is accepted; anywhere outside is the caller's business", () => {
  const root = path.resolve(here, "..", "..");
  assert.equal(assertSecretsDir(path.join(root, ".kaigen-testnet"), root), path.join(root, ".kaigen-testnet"));
  assert.ok(assertSecretsDir(path.join(root, ".kaigen-testnet-v3"), root));
  assert.ok(assertSecretsDir(path.join(os.tmpdir(), "anything"), root));
  assert.throws(() => assertSecretsDir(path.join(root, "jobs", "keys-here"), root), (e) => e instanceof Refused && /not under \.kaigen-testnet/.test(e.message));
  assert.throws(() => assertSecretsDir(root, root), Refused);
  assert.throws(() => assertSecretsDir(path.join(root, "data"), root), Refused);
});

const cli = (args, env = {}) => {
  const clean = { ...process.env, KAIGEN_RPC: "", ...env };
  delete clean.KAIGEN_FUNDER_FILE;
  return spawnSync(process.execPath, [BIN, "prodvault", ...args], { encoding: "utf8", env: { ...clean, ...env }, timeout: 60_000 });
};

test("cli: usage errors exit 2 and print the usage; --yes without a funder file refuses offline; mainnet and a secrets folder inside the repo are refused", () => {
  const none = cli([]);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /--kizashi[\s\S]*usage: kaigen-jobs prodvault/);
  assert.equal(cli(["--kizashi", KIZASHI, "--chain-id", "mainnet"]).status, 2);
  const wasm = path.join(tmp(), "mamori.wasm");
  fs.writeFileSync(wasm, MAMORI);
  const dir = path.join(tmp(), "secrets");
  const started = Date.now();
  // The RPC is unreachable on purpose: the funder-less refusal must not need the network.
  const noFunder = cli(["--kizashi", KIZASHI, "--wasm", wasm, "--rpc", "http://127.0.0.1:9", "--yes"], { KAIGEN_TESTNET_DIR: dir });
  assert.equal(noFunder.status, 1);
  assert.match(noFunder.stderr, /--yes needs --funder-file/);
  assert.ok(Date.now() - started < 20_000);
  assert.ok(!fs.existsSync(dir), "nothing was created");
  const inRepo = cli(["--kizashi", KIZASHI, "--wasm", wasm, "--rpc", "http://127.0.0.1:9"], { KAIGEN_TESTNET_DIR: path.join(here, "..", "..", "jobs-keys") });
  assert.equal(inRepo.status, 1);
  assert.match(inRepo.stderr, /not under \.kaigen-testnet/);
  const notMamori = path.join(tmp(), "x.wasm");
  fs.writeFileSync(notMamori, wasmWithExports(["init"]));
  const wrong = cli(["--kizashi", KIZASHI, "--wasm", notMamori, "--rpc", "http://127.0.0.1:9"], { KAIGEN_TESTNET_DIR: dir });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /not Mamori/);
  assert.match(cli(["--kizashi", KIZASHI, "--wasm", path.join(tmp(), "missing.wasm")], { KAIGEN_TESTNET_DIR: dir }).stderr, /cannot read the wasm/);
});

test("the planner module signs nothing: prodvault.mjs and plantkey.mjs import no signing library and no sender, and make no network call", () => {
  for (const f of ["prodvault.mjs", "plantkey.mjs"]) {
    const src = fs.readFileSync(path.join(here, "..", "src", f), "utf8");
    const imports = src.match(/^import .*$/gm) ?? [];
    assert.ok(imports.length > 0);
    assert.deepEqual(imports.filter((l) => /@fastnear|globaltx\.mjs|chain\.mjs|node:(http|https|net|child_process)/.test(l)), [], f);
    assert.ok(!/\bsendTx\b/.test(src));
    assert.ok(!/\bfetch\s*\(/.test(src), "reads go through the injected rpc");
  }
});

