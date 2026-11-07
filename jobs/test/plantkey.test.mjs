// plant-key (jobs/src/plantkey.mjs, `plant-key` in bin.mjs) and the two new action descriptors of globaltx.mjs it needs.
// Nothing here touches a network: the chain is an in-memory fake (test/fixtures/fake-chain.mjs). Every key is generated in
// memory by the test; none holds anything.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { actions } from "@fastnear/api";
import { generateSigner } from "@fastnear/ml-dsa-65";
import { serializeTransaction as librarySerialize, toBase58 } from "@fastnear/utils";
import { cageCheck, exitCodeOf } from "../src/cage.mjs";
import { adminSigner, mapAction, newClassicalKey, serializeTransaction, signTransaction } from "../src/globaltx.mjs";
import { GlobalUsage, Refused } from "../src/globalcontract.mjs";
import { DEFAULT_RECEIVER, parsePlantArgs, planPlantKey, renderPlant, runPlantKey } from "../src/plantkey.mjs";
import { planProdVault, runProdVault } from "../src/prodvault.mjs";
import { codeHashOf } from "../src/verify.mjs";
import { fakeRpc, fakeSender, makeWorld, READ_METHODS } from "./fixtures/fake-chain.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "..", "src", "bin.mjs");
const FUNDER = "funder.testnet";
const KIZASHI = "kizashi.testnet";
const SUFFIX = "0a1b2c3d";
const VAULT = `pv-${SUFFIX}.${FUNDER}`;

const tmpDirs = [];
const tmp = (p = "pk-") => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  tmpDirs.push(d);
  return d;
};
process.on("exit", () => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

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
function wasmWithExports(names) {
  const type = section(1, [1, 0x60, 0, 0]);
  const func = section(3, [names.length, ...names.map(() => 0)]);
  const exps = section(7, [names.length, ...names.flatMap((n, i) => [...leb(n.length), ...Buffer.from(n), 0x00, i])]);
  const code = section(10, [names.length, ...names.flatMap(() => [2, 0, 0x0b])]);
  return Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...type, ...func, ...exps, ...code]);
}
const MAMORI = wasmWithExports(["init", "send_small", "request_withdraw", "execute", "config", "attest"]);
const HASH = codeHashOf(MAMORI);

const funderKey = newClassicalKey();
const funder = { accountId: FUNDER, publicKey: funderKey.publicKey, signer: funderKey.signer };

/** A finished production vault in a fake world (built by the real prodvault code), with its admin seed in `dir`. */
async function vaultWorld() {
  const w = makeWorld({ funderId: FUNDER, funderPublic: funderKey.publicKey, extraAccounts: [KIZASHI] });
  const dir = tmp();
  const made = [];
  const out = await runProdVault({
    plan: planProdVault({ wasm: MAMORI, wasmPath: "mamori.wasm", funderId: FUNDER, kizashi: KIZASHI, suffix: SUFFIX }),
    rpc: fakeRpc(w),
    funder,
    sender: fakeSender(w),
    newKey: () => {
      const k = newClassicalKey();
      made.push(k);
      return k;
    },
    makeAdmin: (a) => adminSigner({ seedFile: path.join(dir, "admin-seeds.json"), ...a }),
    dir,
    yes: true,
  });
  assert.equal(out.cage.verdict, "GREEN");
  const agentPublic = made[1].publicKey;
  return { w, dir, agentPublic, adminHandle: out.rec.adminHandle };
}

const cage = (w, extra = {}) => cageCheck({ rpc: fakeRpc(w), account: VAULT, policy: { pinnedCodeHash: HASH, extraMethods: [], ...extra } });
const redIds = (r) => r.conditions.filter((c) => c.status === "RED").map((c) => c.id);

/** One plant-key run against `w`, with the keys the run makes remembered. */
function runner(w, dir) {
  const made = [];
  const events = [];
  const logs = [];
  const seedFile = path.join(dir, "admin-seeds.json");
  const admins = [];
  return {
    made,
    events,
    logs,
    run: (plan, over = {}) =>
      runPlantKey({
        plan,
        rpc: fakeRpc(w),
        sender: over.sender ?? fakeSender(w, events),
        newKey: () => {
          const k = newClassicalKey();
          made.push(k);
          return k;
        },
        makeAdmin: (a) => {
          const s = adminSigner({ seedFile, ...a });
          admins.push({ ...a, signer: s });
          return s;
        },
        dir,
        rpcUrl: "https://rpc.testnet.fastnear.com",
        wasmPath: "out/prod/mamori.wasm",
        log: (e) => logs.push(e),
        ...over,
      }),
    admins,
  };
}

// ---- the descriptors ----------------------------------------------------------------------------------------------

test("wire: DeployContract, a function-call AddKey with a null allowance and DeleteKey serialise byte for byte as @fastnear/utils does", () => {
  const admin = generateSigner();
  const base = { signerId: "a.testnet", publicKey: funderKey.publicKey, nonce: 5n, receiverId: "v.a.testnet", blockHash: toBase58(new Uint8Array(32).fill(7)) };
  const planted = newClassicalKey();
  try {
    const lib = [
      actions.deployContract({ codeBase64: MAMORI.toString("base64") }),
      { type: "AddKey", publicKey: planted.publicKey, accessKey: { nonce: 0, permission: { receiverId: "other.testnet", methodNames: ["send_small"], allowance: null } } },
      { type: "AddKey", publicKey: admin.publicKey, accessKey: { nonce: 0, permission: "FullAccess" } },
      actions.deleteKey({ publicKey: planted.publicKey }),
    ];
    const mine = [
      { type: "DeployContract", code: MAMORI },
      { type: "AddKeyFunctionCall", publicKey: planted.publicKey, allowanceYocto: null, receiverId: "other.testnet", methods: ["send_small"] },
      { type: "AddKey", publicKey: admin.publicKey },
      { type: "DeleteKey", publicKey: planted.publicKey },
    ];
    assert.ok(Buffer.from(librarySerialize({ ...base, actions: lib })).equals(Buffer.from(serializeTransaction({ ...base, actions: mine }))));
    // A limited allowance is a u128 option too.
    const limited = { type: "AddKeyFunctionCall", publicKey: planted.publicKey, allowanceYocto: "250000000000000000000000", receiverId: "other.testnet", methods: [] };
    assert.deepEqual(mapAction(limited).addKey.accessKey.permission.functionCall.allowance, 250000000000000000000000n);
    assert.equal(mapAction({ ...limited, allowanceYocto: null }).addKey.accessKey.permission.functionCall.allowance, null);
    assert.throws(() => mapAction({ type: "DeployContract", code: new Uint8Array(0) }), /needs the wasm bytes/);
  } finally {
    admin.destroy();
  }
});

test("wire: a transaction carrying the new descriptors signs with an ML-DSA key and an ed25519 key without throwing", async () => {
  const admin = generateSigner();
  try {
    const tx = { signerId: VAULT, publicKey: admin.publicKey, nonce: 9n, receiverId: VAULT, blockHash: toBase58(new Uint8Array(32).fill(3)), actions: [{ type: "AddKeyFunctionCall", publicKey: newClassicalKey().publicKey, allowanceYocto: null, receiverId: "other.testnet", methods: ["send_small"] }] };
    const signed = await signTransaction(tx, admin);
    assert.ok(signed.signedBase64.length > 100 && signed.hash.length > 30);
  } finally {
    admin.destroy();
  }
});

// ---- plan and args ------------------------------------------------------------------------------------------------

test("plan: ed25519-full is one AddKey; null-allowance is a function-call key with a null allowance and a receiver that is not the vault; remove is one DeleteKey", () => {
  const a = planPlantKey({ vault: VAULT, kind: "ed25519-full" });
  assert.deepEqual(a.actions.map((x) => x.type), ["AddKey"]);
  const n = planPlantKey({ vault: VAULT, kind: "null-allowance" });
  assert.deepEqual(n.actions.map((x) => [x.type, x.allowanceYocto, x.receiverId, x.methods]), [["AddKeyFunctionCall", null, DEFAULT_RECEIVER, ["send_small"]]]);
  assert.notEqual(n.receiver, VAULT);
  const r = planPlantKey({ vault: VAULT, remove: newClassicalKey().publicKey });
  assert.deepEqual(r.actions.map((x) => x.type), ["DeleteKey"]);
  assert.throws(() => planPlantKey({ vault: VAULT, kind: "null-allowance", receiver: VAULT }), GlobalUsage);
  assert.throws(() => planPlantKey({ vault: VAULT, kind: "weird" }), /--kind must be one of ed25519-full, null-allowance/);
  assert.throws(() => planPlantKey({ vault: VAULT, remove: "not-a-key" }), /not a public key/);
  assert.throws(() => planPlantKey({ vault: "Bad Name", kind: "ed25519-full" }), GlobalUsage);
});

test("args: positional vault, the two modes, defaults and every usage error", () => {
  const d = { seedFile: "seeds.json" };
  const o = parsePlantArgs([VAULT, "--kind", "ed25519-full"], d);
  assert.deepEqual([o.vault, o.kind, o.remove, o.seedFile, o.wasm, o.yes, o.chainId], [VAULT, "ed25519-full", undefined, "seeds.json", "out/prod/mamori.wasm", false, "testnet"]);
  assert.equal(parsePlantArgs([VAULT, "--remove", "ed25519:abc", "--yes"], d).yes, true);
  assert.equal(parsePlantArgs([VAULT, "--kind", "null-allowance", "--receiver", "x.testnet"], d).receiver, "x.testnet");
  const bad = (argv, re) => assert.throws(() => parsePlantArgs(argv, d), (e) => e instanceof GlobalUsage && re.test(e.message));
  bad([], /give the vault/);
  bad([VAULT], /--kind .* or --remove/);
  bad([VAULT, "other.testnet", "--kind", "ed25519-full"], /one vault at a time/);
  bad([VAULT, "--kind"], /needs a value/);
  bad([VAULT, "--kind", "ed25519-full", "--kind", "x"], /given twice/);
  bad([VAULT, "--kind", "ed25519-full", "--nope"], /unknown option/);
  bad([VAULT, "--kind", "ed25519-full", "--chain-id", "mainnet"], /testnet only/);
  bad([VAULT, "--kind", "ed25519-full", "--receiver", "x.testnet"], /belongs to --kind null-allowance/);
  bad([VAULT, "--remove", "ed25519:abc", "--receiver", "x.testnet"], /not to --remove/);
});

// ---- dry run and refusals -----------------------------------------------------------------------------------------

test("dry run: reads only, signs nothing, makes no planted key, writes no secret, and prints the exact cage-check command with the admin handle and the wasm", async () => {
  const { w, dir, adminHandle } = await vaultWorld();
  const before = w.sent.length;
  w.requests.length = 0;
  const r = runner(w, dir);
  const out = await r.run(planPlantKey({ vault: VAULT, kind: "ed25519-full" }), { sender: async () => assert.fail("a dry run must not send"), newKey: () => assert.fail("a dry run must not make a key") });
  assert.equal(out.dryRun, true);
  assert.equal(out.pre.ok, true);
  assert.ok(w.requests.every((q) => READ_METHODS.has(q.name)));
  assert.equal(w.sent.length, before);
  assert.ok(!fs.existsSync(path.join(dir, "planted-keys.json")));
  assert.deepEqual(r.admins.map((a) => a.create), [false], "the admin seed is looked up, never created");
  const text = renderPlant(out);
  assert.match(text, /AddKey\(full access, <fresh key, generated when run with --yes>\)/);
  assert.match(text, new RegExp(`node jobs/src/bin\\.mjs cage-check ${VAULT} --rpc https://rpc\\.testnet\\.fastnear\\.com --wasm out/prod/mamori\\.wasm --admin ${adminHandle}`));
  assert.match(text, /expected to go RED on ARCH-2\.8-1/);
});

test("refuses mainnet, a vault that does not exist, no admin seed, and a seed that is not a key of the vault; nothing is sent in any of them", async () => {
  const { w, dir } = await vaultWorld();
  const plan = planPlantKey({ vault: VAULT, kind: "ed25519-full" });
  const never = { sender: async () => assert.fail("must not send"), newKey: () => assert.fail("no key") };
  const mainnet = makeWorld({ funderId: FUNDER, funderPublic: funderKey.publicKey, chain: "mainnet" });
  mainnet.accounts = w.accounts;
  mainnet.keys = w.keys;
  mainnet.contracts = w.contracts;
  await assert.rejects(runner(mainnet, dir).run(plan, { ...never, yes: true }), (e) => e instanceof Refused && /chain_id mainnet: this tool is testnet only/.test(e.message));
  const noVault = await runner(w, dir).run(planPlantKey({ vault: `pv-ffffffff.${FUNDER}`, kind: "ed25519-full" }), never);
  assert.equal(noVault.pre.ok, false);
  assert.match(renderPlant(noVault), /FAIL {2}the vault exists/);
  const emptyDir = tmp();
  const noSeed = await runner(w, emptyDir).run(plan, never);
  assert.match(renderPlant(noSeed), /FAIL {2}the admin seed on file belongs to a full-access key of the vault.*no admin seed for this vault/);
  await assert.rejects(runner(w, emptyDir).run(plan, { ...never, yes: true }), Refused);
  assert.ok(!fs.existsSync(path.join(emptyDir, "admin-seeds.json")), "a missing seed is not created");
  const wrongDir = tmp();
  fs.writeFileSync(path.join(wrongDir, "admin-seeds.json"), JSON.stringify({ [VAULT]: Buffer.from(generateSigner().exportSeed()).toString("hex") }));
  const wrong = await runner(w, wrongDir).run(plan, never);
  assert.match(renderPlant(wrong), /FAIL {2}the admin seed on file belongs to a full-access key of the vault.*is not a full-access key of/);
  assert.equal(w.sent.length, 5, "only the five transactions of the vault's own build were ever sent");
});

// ---- plant, check, remove -----------------------------------------------------------------------------------------

test("plant ed25519-full: signed by the ML-DSA admin, the secret is on disk BEFORE the transaction, cage-check goes RED on ARCH-2.8-1 naming the key, remove brings it back to GREEN", async () => {
  const { w, dir, agentPublic } = await vaultWorld();
  assert.equal(exitCodeOf(await cage(w)), 0);
  const r = runner(w, dir);
  let onDiskAtSend;
  const sender = fakeSender(w, r.events, {
    before: () => {
      onDiskAtSend = fs.existsSync(path.join(dir, "planted-keys.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "planted-keys.json"), "utf8")) : null;
    },
  });
  const out = await r.run(planPlantKey({ vault: VAULT, kind: "ed25519-full" }), { sender, yes: true });
  const [planted] = r.made;
  assert.equal(r.made.length, 1);
  const send = r.events.at(-1);
  assert.deepEqual([send.signerId, send.receiverId, send.actions.map((a) => a.type)], [VAULT, VAULT, ["AddKey"]]);
  assert.equal(send.signer, r.admins[0].signer, "signed with the vault's ML-DSA admin key");
  assert.equal(send.actions[0].publicKey, planted.publicKey);
  assert.equal(onDiskAtSend[VAULT][planted.publicKey].privateKey, planted.privateKey, "the secret was on disk before the send");
  assert.equal(out.confirmed, true);
  assert.equal(out.publicKey, planted.publicKey);

  const text = renderPlant(out);
  assert.ok(text.includes(planted.publicKey));
  assert.ok(!text.includes(planted.privateKey) && !JSON.stringify(r.logs).includes(planted.privateKey), "the private key is never printed");
  assert.ok(text.includes(path.join(dir, "planted-keys.json")));
  assert.match(text, /plant-key pv-0a1b2c3d\.funder\.testnet --remove ed25519:\S+ --yes/);

  const red = await cage(w);
  assert.equal(exitCodeOf(red), 1);
  assert.deepEqual(redIds(red), ["ARCH-2.8-1"]);
  assert.ok(red.conditions.find((c) => c.id === "ARCH-2.8-1").detail.includes(planted.publicKey));

  const removal = runner(w, dir);
  const gone = await removal.run(planPlantKey({ vault: VAULT, remove: planted.publicKey }), { yes: true });
  assert.equal(gone.confirmed, true);
  assert.deepEqual(removal.events.at(-1).actions.map((a) => [a.type, a.publicKey]), [["DeleteKey", planted.publicKey]]);
  assert.equal(exitCodeOf(await cage(w)), 0, "GREEN again");
  assert.ok(w.keys.get(VAULT).some((k) => k.full === agentPublic), "the agent's key was not touched");
  const store = JSON.parse(fs.readFileSync(path.join(dir, "planted-keys.json"), "utf8"));
  assert.equal(store[VAULT][planted.publicKey].removedTx, gone.tx, "the record says it was removed");
});

test("plant null-allowance: a function-call key with a null allowance and another receiver goes RED on ARCH-2.8-3, -5 and -6, and is gone again after --remove", async () => {
  const { w, dir } = await vaultWorld();
  const r = runner(w, dir);
  const out = await r.run(planPlantKey({ vault: VAULT, kind: "null-allowance" }), { yes: true });
  const [planted] = r.made;
  const action = r.events.at(-1).actions[0];
  assert.deepEqual([action.type, action.allowanceYocto, action.receiverId, action.methods], ["AddKeyFunctionCall", null, DEFAULT_RECEIVER, ["send_small"]]);
  assert.equal(out.confirmed, true);
  const red = await cage(w);
  assert.equal(exitCodeOf(red), 1);
  for (const id of ["ARCH-2.8-3", "ARCH-2.8-5", "ARCH-2.8-6"]) assert.ok(redIds(red).includes(id), `${id} in ${redIds(red)}`);
  assert.ok(!redIds(red).includes("ARCH-2.8-1"));
  const store = JSON.parse(fs.readFileSync(path.join(dir, "planted-keys.json"), "utf8"));
  assert.equal(store[VAULT][planted.publicKey].kind, "null-allowance");
  assert.equal(store[VAULT][planted.publicKey].receiver, DEFAULT_RECEIVER);
  await runner(w, dir).run(planPlantKey({ vault: VAULT, remove: planted.publicKey }), { yes: true });
  assert.equal(exitCodeOf(await cage(w)), 0);
});

test("a failed send keeps the secret already on disk and throws; nothing was planted", async () => {
  const { w, dir } = await vaultWorld();
  const r = runner(w, dir);
  await assert.rejects(r.run(planPlantKey({ vault: VAULT, kind: "ed25519-full" }), { sender: async () => { throw new Error("transaction TXBAD failed"); }, yes: true }), /TXBAD/);
  assert.ok(fs.existsSync(path.join(dir, "planted-keys.json")));
  assert.equal(exitCodeOf(await cage(w)), 0, "the chain is unchanged");
});

test("remove refuses: a key that is not on the vault, the admin's own key, and a key the vault records as a daily key", async () => {
  const { w, dir, agentPublic, adminHandle } = await vaultWorld();
  const never = { sender: async () => assert.fail("must not send"), newKey: () => assert.fail("no key"), yes: true };
  const sentBefore = w.sent.length;
  const stranger = newClassicalKey().publicKey;
  await assert.rejects(runner(w, dir).run(planPlantKey({ vault: VAULT, remove: stranger }), never), (e) => e instanceof Refused && /FAIL {2}the key to remove is on the vault/.test(e.message));
  await assert.rejects(runner(w, dir).run(planPlantKey({ vault: VAULT, remove: adminHandle }), never), (e) => e instanceof Refused && /FAIL {2}the key to remove is not the admin's own key.*lock the vault for good/.test(e.message));
  await assert.rejects(runner(w, dir).run(planPlantKey({ vault: VAULT, remove: agentPublic }), never), (e) => e instanceof Refused && /FAIL {2}the key to remove is not one the vault records as a daily key/.test(e.message));
  assert.equal(w.sent.length, sentBefore);
  assert.equal(exitCodeOf(await cage(w)), 0);
});

// ---- the command line ---------------------------------------------------------------------------------------------

const cli = (args, env = {}) => spawnSync(process.execPath, [BIN, "plant-key", ...args], { encoding: "utf8", env: { ...process.env, KAIGEN_RPC: "", ...env }, timeout: 60_000 });

test("cli: usage errors exit 2 and print the usage, mainnet is refused, a secrets folder inside the repo is refused before any network use", () => {
  const none = cli([]);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /usage: kaigen-jobs plant-key/);
  assert.equal(cli([VAULT]).status, 2);
  assert.equal(cli([VAULT, "--kind", "ed25519-full", "--chain-id", "mainnet"]).status, 2);
  assert.equal(cli([VAULT, "--kind", "nonsense"]).status, 2);
  const inRepo = cli([VAULT, "--kind", "ed25519-full", "--rpc", "http://127.0.0.1:9"], { KAIGEN_TESTNET_DIR: path.join(here, "..", "..", "jobs-keys") });
  assert.equal(inRepo.status, 1);
  assert.match(inRepo.stderr, /not under \.kaigen-testnet/);
});
