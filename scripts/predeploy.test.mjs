import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkInit, checkUsdcRegistration, checkWasm, codeHash, loadDrillKeys, predeploy, report, wasmExports } from "./predeploy.mjs";
import { productionOmens } from "./omens.mjs";
import { codeHashOf } from "../jobs/src/verify.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const madeDirs = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "predeploy-"));
  madeDirs.push(dir);
  return dir;
};
// Temp dirs are removed when the file's tests finish, so the run leaves nothing behind.
after(() => madeDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const failed = (rs) => rs.filter((r) => !r.ok).map((r) => r.name);

/** A valid wasm module that exports the given function names (and nothing else). */
function wasmWith(names) {
  const bytes = (s) => [...Buffer.from(s)];
  const n = names.length;
  const exportBody = [n, ...names.flatMap((name, i) => [name.length, ...bytes(name), 0, i])];
  const section = (id, body) => [id, body.length, ...body];
  return Buffer.from([
    0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...section(1, [1, 0x60, 0, 0]),
    ...section(3, [n, ...names.map(() => 0)]),
    ...section(7, exportBody),
    ...section(10, [n, ...names.flatMap(() => [2, 0, 0x0b])]),
  ]);
}
const KIZASHI = ["new", "claim", "era", "omens", "bounty", "claim_message"];

const goodInit = () => ({ omens: productionOmens(), usdc: USDC });
// Fixed, made-up PUBLIC values: the tests never create or read a secret key.
const DRILL_OMENS = [
  { id: "drill-ed25519-omen", curve: "Ed25519", level: "Kaigen", public_key: "11".repeat(32) },
  { id: "drill-secp256k1-omen", curve: "Secp256k1", level: "Kaigen", public_key: "22".repeat(64) },
];
const drillKeys = () => DRILL_OMENS.map((o) => o.public_key);

test("fixture wasm is a valid module, so the export parser is tested on real bytes", () => {
  assert.ok(WebAssembly.validate(wasmWith(KIZASHI)));
  assert.deepEqual(wasmExports(wasmWith(["a", "reset"])).map((e) => e.name), ["a", "reset"]);
});

test("init: the derived omens and a given token pass every offline check", () => {
  const rs = checkInit({ init: goodInit(), drillKeys: drillKeys(), usdc: USDC });
  assert.deepEqual(failed(rs), []);
});

test("init: an extra team-held omen fails even though every derived omen is present (P1)", () => {
  const init = goodInit();
  init.omens.push(DRILL_OMENS[0]);
  const rs = checkInit({ init, drillKeys: [], usdc: USDC });
  const r = rs.find((x) => x.name.startsWith("omens equal"));
  assert.equal(r.ok, false);
  assert.match(r.detail, /unexpected omen\(s\).*drill-ed25519-omen/);
  // The same extra under a production-looking id is still caught: only the derived set is accepted.
  const sneaky = goodInit();
  sneaky.omens.push({ id: "extra-omen", curve: "Ed25519", level: "Kaigen", public_key: "ab".repeat(32) });
  assert.match(checkInit({ init: sneaky, drillKeys: [], usdc: USDC }).find((x) => x.name.startsWith("omens equal")).detail, /extra-omen/);
});

test("init: a missing omen, a wrong key, a wrong curve and a wrong level each fail", () => {
  const name = (rs) => rs.find((x) => x.name.startsWith("omens equal"));
  const missing = goodInit();
  missing.omens.pop();
  assert.equal(name(checkInit({ init: missing, drillKeys: [], usdc: USDC })).ok, false);
  const wrongKey = goodInit();
  wrongKey.omens[0].public_key = "00".repeat(32);
  assert.match(name(checkInit({ init: wrongKey, drillKeys: [], usdc: USDC })).detail, /key mismatch/);
  const wrongCurve = goodInit();
  wrongCurve.omens[1].curve = "Ed25519";
  assert.match(name(checkInit({ init: wrongCurve, drillKeys: [], usdc: USDC })).detail, /curve/);
  const wrongLevel = goodInit();
  wrongLevel.omens[0].level = "Warning";
  assert.match(name(checkInit({ init: wrongLevel, drillKeys: [], usdc: USDC })).detail, /level/);
});

test("init: a repeated id or a repeated key fails", () => {
  const dupId = goodInit();
  dupId.omens.push({ ...dupId.omens[0] });
  assert.equal(checkInit({ init: dupId, drillKeys: [], usdc: USDC }).find((x) => x.name.startsWith("omens equal")).ok, false);
  const dupKey = goodInit();
  dupKey.omens[1] = { ...dupKey.omens[1], public_key: dupKey.omens[0].public_key };
  assert.ok(failed(checkInit({ init: dupKey, drillKeys: [], usdc: USDC })).includes("no key is listed twice"));
});

test("init: a known drill or testnet public key fails, and an unreadable drill list is a failure not a pass", () => {
  const init = goodInit();
  const asDrill = checkInit({ init, drillKeys: [init.omens[0].public_key], usdc: USDC });
  assert.ok(failed(asDrill).includes("no drill or testnet key"));
  const byId = goodInit();
  byId.omens[0].id = "drill-ed25519-omen";
  assert.ok(failed(checkInit({ init: byId, drillKeys: [], usdc: USDC })).includes("no drill or testnet key"));
  const none = checkInit({ init, usdc: USDC }).find((x) => x.name === "no drill or testnet key");
  assert.equal(none.ok, false);
  assert.match(none.detail, /could not check/);
});

test("init: the USDC id must be given, valid, and the same as the init file's", () => {
  const f = (init, usdc) => checkInit({ init, drillKeys: [], usdc }).find((x) => x.name.startsWith("USDC token id"));
  assert.equal(f(goodInit(), undefined).ok, false);
  assert.equal(f(goodInit(), "NOT AN ACCOUNT").ok, false);
  assert.equal(f({ ...goodInit(), usdc: "other.near" }, USDC).ok, false);
  assert.equal(f({ omens: productionOmens() }, USDC).ok, false);
  assert.ok(failed(checkInit({ init: { omens: productionOmens() }, drillKeys: [], usdc: USDC })).includes("init has exactly the fields omens and usdc"));
  assert.equal(f({ ...goodInit(), usdc: null }, USDC).ok, false);
  assert.equal(f(goodInit(), USDC).ok, true);
  // A field the contract would silently ignore is reported rather than dropped.
  assert.ok(failed(checkInit({ init: { ...goodInit(), owner: "me.near" }, drillKeys: [], usdc: USDC })).includes("init has exactly the fields omens and usdc"));
});

test("drill keys: public lists load, a secrets file is refused", () => {
  const dir = tmp();
  const write = (name, v) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, JSON.stringify(v));
    return p;
  };
  assert.deepEqual(loadDrillKeys(write("a.json", ["AB12", "cd"])), ["ab12", "cd"]);
  assert.deepEqual(loadDrillKeys(write("b.json", DRILL_OMENS)), drillKeys());
  // The secrets file `omens.mjs drill` writes is a map of ids to secret keys: never accepted as input.
  assert.throws(() => loadDrillKeys(write("secrets.json", { "drill-ed25519-omen": "ab".repeat(32) })), /never a secrets file/);
  assert.throws(() => loadDrillKeys(write("bad.json", ["not hex!"])), /not a hex public key/);
  assert.throws(() => loadDrillKeys(path.join(dir, "missing.json")), /cannot read/);
});

test("wasm: a build that exports reset fails, a Kizashi without its methods fails, a clean build passes with its code hash", () => {
  const clean = wasmWith(KIZASHI);
  const rs = checkWasm(clean);
  assert.deepEqual(failed(rs), []);
  assert.equal(rs.find((r) => r.name === "wasm code hash").detail, codeHash(clean));
  assert.equal(codeHash(clean), codeHashOf(clean), "the hash matches the one `verify` computes and NEAR reports");

  const drill = checkWasm(wasmWith([...KIZASHI, "reset"]));
  assert.deepEqual(failed(drill), ["wasm exports no reset"]);
  assert.match(drill[0].detail, /drill build/);

  const other = checkWasm(wasmWith(["new", "era"]));
  assert.deepEqual(failed(other), ["wasm is the Kizashi contract"]);
  assert.match(other.find((r) => !r.ok).detail, /claim, omens, bounty/);
});

test("wasm: bytes that are not a module fail both checks instead of passing silently", () => {
  for (const bytes of [Buffer.from("not wasm at all"), Buffer.alloc(0), wasmWith(KIZASHI).subarray(0, 30)]) {
    assert.deepEqual(failed(checkWasm(bytes)), ["wasm exports no reset", "wasm is the Kizashi contract"]);
  }
});

test("the real build artifacts: production exports no reset, the drill build does", { skip: !fs.existsSync(path.join(here, "..", "out", "prod", "kizashi.wasm")) }, () => {
  const prod = fs.readFileSync(path.join(here, "..", "out", "prod", "kizashi.wasm"));
  assert.deepEqual(failed(checkWasm(prod)), []);
  const drillFile = path.join(here, "..", "out", "drill", "kizashi.wasm");
  if (fs.existsSync(drillFile)) assert.ok(failed(checkWasm(fs.readFileSync(drillFile))).includes("wasm exports no reset"));
});

test("usdc registration: registered passes; unregistered, an rpc error and a missing token fail", async () => {
  const rpcWith = (view) => ({ view });
  const ok = await checkUsdcRegistration({ rpc: rpcWith(async () => ({ total: "1", available: "0" })), usdc: USDC, kizashi: "k.near" });
  assert.equal(ok.ok, true);
  const calls = [];
  const asked = rpcWith(async (...a) => (calls.push(a), null));
  assert.equal((await checkUsdcRegistration({ rpc: asked, usdc: USDC, kizashi: "k.near" })).ok, false);
  assert.deepEqual(calls[0], [USDC, "storage_balance_of", { account_id: "k.near" }]);
  const down = await checkUsdcRegistration({ rpc: rpcWith(async () => { throw new Error("rpc down"); }), usdc: USDC, kizashi: "k.near" });
  assert.equal(down.ok, false);
  assert.match(down.detail, /could not check: rpc down/);
});

test("predeploy: without --rpc the registration check is reported as NOT CHECKED, with it the check runs", async () => {
  const args = { init: goodInit(), drillKeys: drillKeys(), usdc: USDC, wasm: wasmWith(KIZASHI) };
  const offline = await predeploy(args);
  const skipped = offline.find((r) => r.skipped);
  assert.match(skipped.detail, /NOT CHECKED/);
  assert.match(report(offline).text, /SKIP {2}Kizashi is registered/);
  assert.equal(report(offline).ok, true);

  const online = await predeploy({ ...args, rpc: { view: async () => null }, kizashi: "k.near" });
  assert.equal(online.some((r) => r.skipped), false);
  assert.deepEqual(failed(online), ["Kizashi is registered with the USDC token"]);
  assert.equal(report(online).ok, false);
  assert.match(report(online).text, /1 of \d+ checks FAILED/);
});

test("cli: exits 0 on a good configuration, 1 on a bad one, 2 on missing arguments, and never reads secrets", () => {
  const dir = tmp();
  const put = (name, content) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
  };
  const init = put("init.json", JSON.stringify(goodInit()));
  const wasm = put("kizashi.wasm", wasmWith(KIZASHI));
  const drill = put("drill.json", JSON.stringify(drillKeys()));
  const run = (...args) => spawnSync(process.execPath, [path.join(here, "predeploy.mjs"), ...args], { encoding: "utf8" });

  const good = run("--init", init, "--wasm", wasm, "--drill-keys", drill, "--usdc", USDC);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /All \d+ checks passed/);

  const withReset = put("reset.wasm", wasmWith([...KIZASHI, "reset"]));
  const bad = run("--init", init, "--wasm", withReset, "--drill-keys", drill, "--usdc", USDC);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /FAIL {2}wasm exports no reset/);

  assert.equal(run("--init", init).status, 2);
  const secrets = put("secrets.json", JSON.stringify({ "drill-ed25519-omen": "ab".repeat(32) }));
  const refused = run("--init", init, "--wasm", wasm, "--drill-keys", secrets, "--usdc", USDC);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /never a secrets file/);
  assert.ok(!refused.stderr.includes("ab".repeat(32)), "the secret is never echoed");
});
