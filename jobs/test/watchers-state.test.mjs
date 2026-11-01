import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, loadState, saveState, writeFileAtomic } from "../src/watchers.mjs";

const made = [];
const tmpDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kaigen-watch-"));
  made.push(dir);
  return dir;
};
after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const leftovers = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));

test("watcher state: a missing file is a first run, not an error", () => {
  const dir = tmpDir();
  assert.deepEqual(loadState(path.join(dir, "state.json")), {});
});

test("watcher state: what saveState wrote is what loadState reads back", () => {
  const dir = tmpDir();
  const file = path.join(dir, "watchers", "state.json");
  const state = { "near:abc": { balance: "123456789012345678901234567890" }, "bitcoin:bc1": { spent: 2 } };
  saveState(file, state, [{ id: "bitcoin:bc1", kind: "outflow", detail: "x" }, { id: "solana:s", kind: "unreadable", detail: "y" }]);
  assert.deepEqual(loadState(file), state);
  const alerts = JSON.parse(fs.readFileSync(path.join(path.dirname(file), "alerts.json"), "utf8"));
  assert.equal(alerts.outflows.length, 1);
  assert.equal(alerts.unreadable.length, 1);
  assert.deepEqual(leftovers(path.dirname(file)), [], "no temp file is left behind");
});

test("watcher state: a truncated or garbled file is an error that names the file, and the file is left alone", () => {
  const dir = tmpDir();
  const file = path.join(dir, "state.json");
  for (const text of ['{"near:x":{"balance":"5"', "", "not json at all"]) {
    fs.writeFileSync(file, text);
    assert.throws(() => loadState(file), (e) => e.message.includes(file) && /not valid JSON/.test(e.message), JSON.stringify(text));
    assert.equal(fs.readFileSync(file, "utf8"), text, "the broken file is kept for inspection, not reset");
  }
});

test("watcher state: parseable but wrong-shaped state is refused, because a reset baseline would hide an outflow", () => {
  const dir = tmpDir();
  const file = path.join(dir, "state.json");
  for (const bad of ["null", "[]", "5", '{"near:x":null}', '{"near:x":{"balance":12}}', '{"near:x":{"balance":"-1"}}', '{"near:x":{"balance":"abc"}}', '{"b":{"spent":-1}}', '{"b":{"spent":1.5}}', '{"b":{}}']) {
    fs.writeFileSync(file, bad);
    assert.throws(() => loadState(file), /malformed/, bad);
  }
});

test("watcher state: a corrupt file stops the run instead of re-baselining a drained balance", async () => {
  // This is the failure the guard exists for: with the state reset to {}, a bounty already drained to 0 would be
  // taken as the normal balance and never alert. check() proves that is what a reset does.
  const drained = [{ id: "near:x", read: async () => ({ balance: 0n }) }];
  assert.deepEqual((await check(drained, {})).alerts, [], "a reset state hides the outflow");
  const dir = tmpDir();
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, '{"near:x":{"balance":"1000"');
  assert.throws(() => loadState(file), /not valid JSON/);
  fs.writeFileSync(file, '{"near:x":{"balance":"1000"}}');
  assert.equal((await check(drained, loadState(file))).alerts[0].kind, "outflow", "an intact state still alerts");
});

test("watcher state: a failed rename leaves the previous file intact and no temp file behind", () => {
  const dir = tmpDir();
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, '{"old":{"spent":0}}');
  const io = { ...fs, renameSync: () => { throw new Error("disk full"); } };
  assert.throws(() => writeFileAtomic(file, '{"new":{"spent":1}}', io), /disk full/);
  assert.equal(fs.readFileSync(file, "utf8"), '{"old":{"spent":0}}');
  assert.deepEqual(leftovers(dir), []);
});

test("watcher state: a failure while writing the temp file leaves the previous file intact and no temp file behind", () => {
  const dir = tmpDir();
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, '{"old":{"spent":0}}');
  const io = { ...fs, writeSync: () => { throw new Error("no space left"); } };
  assert.throws(() => writeFileAtomic(file, '{"new":{"spent":1}}', io), /no space left/);
  assert.equal(fs.readFileSync(file, "utf8"), '{"old":{"spent":0}}');
  assert.deepEqual(leftovers(dir), []);
});

test("watcher state: the target only ever appears whole (written to a sibling temp file first)", () => {
  const dir = tmpDir();
  const file = path.join(dir, "state.json");
  const seen = [];
  const io = {
    ...fs,
    renameSync: (from, to) => {
      seen.push({ from, to, dirSame: path.dirname(from) === path.dirname(to), whole: fs.readFileSync(from, "utf8") });
      return fs.renameSync(from, to);
    },
  };
  writeFileAtomic(file, '{"a":{"spent":3}}', io);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].to, file);
  assert.ok(seen[0].from.endsWith(".tmp") && seen[0].dirSame, "same directory, so the rename cannot cross a filesystem");
  assert.equal(seen[0].whole, '{"a":{"spent":3}}', "complete before it replaced the target");
  assert.equal(fs.readFileSync(file, "utf8"), '{"a":{"spent":3}}');
  assert.deepEqual(leftovers(dir), []);
});
