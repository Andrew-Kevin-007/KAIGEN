// plant-key: add a key the cage must NOT have to a testnet vault (or take it off again), signed with the vault's own ML-DSA-65
// admin key, so `cage-check` can be shown going RED on a real chain and GREEN again (docs/v3/ATTACK-RESULTS.md section 9 shows it
// on a sandbox only).
//
//   --kind ed25519-full      a fresh classical full-access key: cage-check ARCH-2.8-1 (a classical full-access key voids the guard)
//   --kind null-allowance    a fresh function-call key with a NULL allowance (unlimited) and a receiver that is another account:
//                            ARCH-2.8-3 (allowance), ARCH-2.8-5 (receiver) and ARCH-2.8-6 (not recorded by the vault)
//   --remove <publickey>     DeleteKey of a key already on the vault; refuses the admin's own key and a key the vault records
//
// DRY RUN BY DEFAULT: without `yes` this reads the chain and prints what it would do. Nothing here signs or generates a key in a
// dry run. The planted key's PRIVATE key is written to <dir>/planted-keys.json (the gitignored folder of the admin seeds) BEFORE the
// transaction and is never printed; the output carries the public key only. Testnet only: a node that says it is mainnet is refused.
import fs from "node:fs";
import path from "node:path";
import { fullAccessKeys, chainCheck, writeSecretJson } from "./prodvault.mjs";
import { GlobalUsage, isAccountId, Refused, TESTNET_RPC } from "./globalcontract.mjs";
import { report } from "./verify.mjs";


const KINDS = ["ed25519-full", "null-allowance"];
/** The one method the planted function-call key lists: not empty (that would add ARCH-2.8-4), and one the vault really has. */
const PLANTED_METHODS = ["send_small"];
/** A receiver that is not the vault, so ARCH-2.8-5 is part of the picture. The account need not exist for a key to be added to it. */
export const DEFAULT_RECEIVER = "kaigen-planted-receiver.testnet";

const message = (e) => String(e?.message ?? e);
const result = (name, ok, detail) => ({ name, ok, detail });
const guarded = async (name, fn) => {
  try {
    return await fn();
  } catch (e) {
    return result(name, false, `could not check: ${message(e)}`);
  }
};

/** Pure: the action the run would send, with a placeholder where the fresh key goes. */
export function planPlantKey({ vault, kind, remove, receiver = DEFAULT_RECEIVER, placeholder = "<fresh key, generated when run with --yes>" }) {
  if (!isAccountId(vault)) throw new GlobalUsage(`${JSON.stringify(vault)} is not a NEAR account id`);
  if (remove !== undefined) {
    if (!/^(ed25519|secp256k1|ml-dsa-65(-hash)?):[1-9A-HJ-NP-Za-km-z]+$/.test(remove)) throw new GlobalUsage(`--remove ${JSON.stringify(remove)} is not a public key such as ed25519:...`);
    return { mode: "remove", vault, publicKey: remove, actions: [{ type: "DeleteKey", publicKey: remove }] };
  }
  if (!KINDS.includes(kind)) throw new GlobalUsage(`--kind must be one of ${KINDS.join(", ")}`);
  if (kind === "ed25519-full") return { mode: "plant", kind, vault, actions: [{ type: "AddKey", publicKey: placeholder }] };
  if (!isAccountId(receiver) || receiver === vault) throw new GlobalUsage(`--receiver ${JSON.stringify(receiver)} must be a NEAR account id other than the vault`);
  return { mode: "plant", kind, vault, receiver, actions: [{ type: "AddKeyFunctionCall", publicKey: placeholder, allowanceYocto: null, receiverId: receiver, methods: PLANTED_METHODS }] };
}

/** Read-only. `adminHandle` is the handle of the seed on file, or null when there is none. */
export async function preflight({ rpc, plan, adminHandle, expectedChain = "testnet" }) {
  const checks = [];
  let keys = null;
  checks.push(
    await guarded("chain is the one asked for, and is not mainnet", async () => chainCheck(await rpc.status(), expectedChain)),
  );
  checks.push(
    await guarded("the vault exists", async () => {
      keys = await rpc.accessKeys(plan.vault);
      return result("the vault exists", keys !== null, keys ? `${plan.vault} has ${keys.length} key(s)` : `${plan.vault} does not exist`);
    }),
  );
  checks.push(
    await guarded("the admin seed on file belongs to a full-access key of the vault", async () => {
      if (!adminHandle) return result("the admin seed on file belongs to a full-access key of the vault", false, "no admin seed for this vault in the seed file");
      const ok = fullAccessKeys(keys).includes(adminHandle);
      return result("the admin seed on file belongs to a full-access key of the vault", ok, ok ? `${adminHandle} is a full-access key of ${plan.vault}` : `${adminHandle} is not a full-access key of ${plan.vault}: the chain would refuse the transaction`);
    }),
  );
  if (plan.mode === "remove") {
    checks.push(
      await guarded("the key to remove is on the vault", async () => result("the key to remove is on the vault", (keys ?? []).some((k) => k.public_key === plan.publicKey), `${plan.publicKey}`)),
    );
    checks.push(
      await guarded("the key to remove is not the admin's own key", async () => result("the key to remove is not the admin's own key", plan.publicKey !== adminHandle, plan.publicKey === adminHandle ? "deleting the admin key would lock the vault for good" : "it is another key")),
    );
    checks.push(
      await guarded("the key to remove is not one the vault records as a daily key", async () => {
        let daily = [];
        try {
          daily = await rpc.view(plan.vault, "daily_keys");
        } catch {
          return result("the key to remove is not one the vault records as a daily key", true, "daily_keys() could not be read (not a Mamori vault?), so this was not checked");
        }
        const recorded = Array.isArray(daily) && daily.includes(plan.publicKey);
        return result("the key to remove is not one the vault records as a daily key", !recorded, recorded ? "it is a recorded agent key: removing it behind the vault's back would leave its books wrong" : "it is not in daily_keys()");
      }),
    );
  }
  return { checks, ok: checks.every((c) => c.ok), keys };
}

const nextCommands = ({ vault, rpcUrl, wasmPath, adminHandle, publicKey }) => ({
  check: `node jobs/src/bin.mjs cage-check ${vault} --rpc ${rpcUrl} --wasm ${wasmPath}${adminHandle ? ` --admin ${adminHandle}` : ""}`,
  remove: `node jobs/src/bin.mjs plant-key ${vault} --remove ${publicKey ?? "<the public key above>"} --yes`,
});

/**
 * Dry run unless `yes`. `sender` is `send({ signerId, signer, receiverId, actions })` (globaltx.mjs), `newKey()` returns
 * `{ privateKey, publicKey }`, `makeAdmin({ vault, create: false })` returns the vault's ML-DSA signer or null. Returns no secret.
 */
export async function runPlantKey({ plan, rpc, sender, newKey, makeAdmin, dir, yes = false, expectedChain = "testnet", rpcUrl = TESTNET_RPC, wasmPath = "out/prod/mamori.wasm", log = () => {} }) {
  const admin = makeAdmin({ vault: plan.vault, create: false });
  try {
    const adminHandle = admin?.publicKeyHandle ?? null;
    const pre = await preflight({ rpc, plan, adminHandle, expectedChain });
    const next = nextCommands({ vault: plan.vault, rpcUrl, wasmPath, adminHandle, publicKey: plan.mode === "remove" ? plan.publicKey : undefined });
    if (!yes) return { dryRun: true, plan, pre, next };
    if (!pre.ok) throw new Refused(`preflight failed, nothing was sent:\n${report(pre.checks).text}`);

    const secretsFile = path.join(dir, "planted-keys.json");
    const readStore = () => (fs.existsSync(secretsFile) ? JSON.parse(fs.readFileSync(secretsFile, "utf8")) : {});
    if (plan.mode === "remove") {
      const sent = await sender({ signerId: plan.vault, signer: admin, receiverId: plan.vault, actions: plan.actions });
      log({ step: "planted key removed", vault: plan.vault, publicKey: plan.publicKey, tx: sent.hash });
      const left = (await rpc.accessKeys(plan.vault)) ?? [];
      const gone = !left.some((k) => k.public_key === plan.publicKey);
      const store = readStore();
      if (store[plan.vault]?.[plan.publicKey]) {
        store[plan.vault][plan.publicKey].removedTx = sent.hash;
        writeSecretJson(secretsFile, store);
      }
      return { dryRun: false, plan, pre, next, publicKey: plan.publicKey, tx: sent.hash, confirmed: gone };
    }

    // The private key is on disk before the transaction can put the public key on the account.
    const key = newKey();
    const store = readStore();
    store[plan.vault] = { ...store[plan.vault], [key.publicKey]: { privateKey: key.privateKey, kind: plan.kind, ...(plan.receiver ? { receiver: plan.receiver } : {}), plantedAt: new Date().toISOString() } };
    writeSecretJson(secretsFile, store);
    const actions = plan.actions.map((a) => ({ ...a, publicKey: key.publicKey }));
    const sent = await sender({ signerId: plan.vault, signer: admin, receiverId: plan.vault, actions });
    log({ step: "key planted", vault: plan.vault, kind: plan.kind, publicKey: key.publicKey, tx: sent.hash });
    const listed = ((await rpc.accessKeys(plan.vault)) ?? []).find((k) => k.public_key === key.publicKey);
    const permission = listed?.access_key.permission;
    const confirmed = plan.kind === "ed25519-full" ? permission === "FullAccess" : permission?.FunctionCall !== undefined && (permission.FunctionCall.allowance ?? null) === null;
    return { dryRun: false, plan, pre, next: nextCommands({ vault: plan.vault, rpcUrl, wasmPath, adminHandle, publicKey: key.publicKey }), publicKey: key.publicKey, tx: sent.hash, confirmed, secretsFile };
  } finally {
    admin?.destroy?.();
  }
}

const EXPECTED_RED = {
  "ed25519-full": "ARCH-2.8-1 (a classical full-access key), naming this key",
  "null-allowance": "ARCH-2.8-3 (null allowance), ARCH-2.8-5 (the receiver is not the vault) and ARCH-2.8-6 (not recorded by the vault), naming this key",
};

export function renderPlant(out) {
  const { plan } = out;
  const lines = [`plant-key ${plan.mode === "remove" ? "REMOVE" : plan.kind} on ${plan.vault}`, "", "action:", ...plan.actions.map((a) => `  ${describe(a)}`), "", "preflight (read-only):", report(out.pre.checks).text, ""];
  if (out.dryRun) {
    if (plan.mode === "plant") lines.push(`secret: the new key's private half would be written to planted-keys.json next to the admin seeds (gitignored) before the transaction, and is never printed.`, `then: cage-check is expected to go RED on ${EXPECTED_RED[plan.kind]}.`, "", "next, after a real run:", `  ${out.next.check}`, `  ${out.next.remove}`);
    else lines.push("next, after a real run:", `  ${out.next.check}   (expected GREEN if nothing else is off)`);
    return lines.join("\n");
  }
  if (plan.mode === "plant") {
    lines.push(`planted ${out.publicKey} on ${plan.vault} (tx ${out.tx}); the chain ${out.confirmed ? "lists it with the expected permission" : "DOES NOT list it as expected: read the key list before the take"}.`, `its private key is in ${out.secretsFile} (not printed).`, "", `cage-check is expected to go RED on ${EXPECTED_RED[plan.kind]}. Run:`, `  ${out.next.check}`, "", "to take it off again:", `  ${out.next.remove}`);
  } else {
    lines.push(`removed ${out.publicKey} from ${plan.vault} (tx ${out.tx}); the chain ${out.confirmed ? "no longer lists it" : "STILL LISTS it: read the key list"}.`, "", "then run (expected GREEN if nothing else is off):", `  ${out.next.check}`);
  }
  return lines.join("\n");
}

function describe(a) {
  if (a.type === "AddKey") return `AddKey(full access, ${a.publicKey})`;
  if (a.type === "DeleteKey") return `DeleteKey(${a.publicKey})`;
  return `AddKey(function call, allowance null (unlimited), receiver ${a.receiverId}, methods ${a.methods.join(", ")}; key ${a.publicKey})`;
}

// ---- command line -------------------------------------------------------------------------------------------------

export const PLANT_USAGE =
  "usage: kaigen-jobs plant-key <vault> --kind ed25519-full|null-allowance [--receiver <account>] [--admin-seed-file <file>] [--wasm <file>] [--rpc <url>] [--yes]\n" +
  "       kaigen-jobs plant-key <vault> --remove <publickey> [--admin-seed-file <file>] [--wasm <file>] [--rpc <url>] [--yes]\n" +
  "  Testnet only. Dry run unless --yes. Signs with the vault's ML-DSA-65 admin seed from the seed file (default <KAIGEN_TESTNET_DIR or .kaigen-testnet>/admin-seeds.json).\n" +
  "  --kind        ed25519-full: a fresh classical full-access key (cage-check ARCH-2.8-1 red). null-allowance: a function-call key with a null allowance and another receiver (ARCH-2.8-3, -5, -6 red)\n" +
  "  --receiver    the other account for null-allowance (default kaigen-planted-receiver.testnet)\n" +
  "  --remove      delete a key from the vault; refuses the admin's own key and a recorded agent key. With --remove, --kind is not used\n" +
  "  --wasm        only used to print the exact cage-check command (default out/prod/mamori.wasm)\n" +
  "  The planted key's private half goes to planted-keys.json beside the seed file and is never printed.";

/** `argv` is what follows `plant-key`. `defaults`: { seedFile }. */
export function parsePlantArgs(argv, defaults) {
  const valued = new Set(["--kind", "--remove", "--receiver", "--admin-seed-file", "--wasm", "--rpc", "--chain-id"]);
  const seen = {};
  const positional = [];
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes") yes = true;
    else if (valued.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new GlobalUsage(`${a} needs a value`);
      if (a in seen) throw new GlobalUsage(`${a} given twice`);
      seen[a] = v;
    } else if (a.startsWith("--")) throw new GlobalUsage(`unknown option ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 1) throw new GlobalUsage(positional.length === 0 ? "give the vault account" : `one vault at a time, got ${positional.length}`);
  const chainId = seen["--chain-id"] ?? "testnet";
  if (chainId === "mainnet") throw new GlobalUsage("--chain-id mainnet: this tool is testnet only");
  if (seen["--remove"] === undefined && seen["--kind"] === undefined) throw new GlobalUsage(`give --kind ${KINDS.join("|")} to plant a key, or --remove <publickey>`);
  if (seen["--remove"] !== undefined && seen["--receiver"] !== undefined) throw new GlobalUsage("--receiver belongs to --kind null-allowance, not to --remove");
  if (seen["--receiver"] !== undefined && seen["--kind"] !== "null-allowance") throw new GlobalUsage("--receiver belongs to --kind null-allowance");
  return {
    vault: positional[0],
    kind: seen["--kind"],
    remove: seen["--remove"],
    receiver: seen["--receiver"],
    seedFile: seen["--admin-seed-file"] ?? defaults.seedFile,
    wasm: seen["--wasm"] ?? "out/prod/mamori.wasm",
    rpc: seen["--rpc"] ?? TESTNET_RPC,
    chainId,
    yes,
  };
}
