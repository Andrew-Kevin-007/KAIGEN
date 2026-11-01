import test from "node:test";
import assert from "node:assert/strict";
import { loadBountyPanel, type ViewFn } from "./bounty.ts";

const fake =
  (answers: Record<string, unknown>): ViewFn =>
  async <T>(contract: string, method: string) => {
    const a = answers[`${contract}.${method}`];
    if (a instanceof Error) throw a;
    return a as T;
  };

test("APP-B1: a bounty with no USDC token has no registration to check", async () => {
  const panel = await loadBountyPanel(fake({ "k.near.bounty": { near: "1000", usdc_token: null } }), "k.near");
  assert.deepEqual(panel, { bounty: { near: "1000", usdc_token: null }, registered: null });
});

test("APP-B1: registered is true when the token knows Kizashi and false when it does not", async () => {
  const bounty = { near: "5", usdc_token: "usdc.near" };
  assert.equal((await loadBountyPanel(fake({ "k.near.bounty": bounty, "usdc.near.storage_balance_of": { total: "1" } }), "k.near")).registered, true);
  assert.equal((await loadBountyPanel(fake({ "k.near.bounty": bounty, "usdc.near.storage_balance_of": null }), "k.near")).registered, false);
});

test("APP-B1: a failed bounty view is thrown, so the page can show an error with a retry instead of 'Loading...' for ever", async () => {
  await assert.rejects(loadBountyPanel(fake({ "k.near.bounty": new Error("RPC 503") }), "k.near"), /RPC 503/);
});

test("APP-B1: a failed storage view is thrown too, rather than leaving the USDC row loading", async () => {
  await assert.rejects(
    loadBountyPanel(fake({ "k.near.bounty": { near: "5", usdc_token: "usdc.near" }, "usdc.near.storage_balance_of": new Error("Method not found") }), "k.near"),
    /Method not found/,
  );
});

test("APP-B1: a bounty answer the page could not render is an error, not a crash in BigInt", async () => {
  for (const bad of [null, undefined, "x", {}, { near: 5 }, { near: "1.5" }, { near: "" }]) {
    await assert.rejects(loadBountyPanel(fake({ "k.near.bounty": bad }), "k.near"), /cannot read/, JSON.stringify(bad));
  }
});
