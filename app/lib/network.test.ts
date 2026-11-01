import test from "node:test";
import assert from "node:assert/strict";
import { networkOfChainId, networkProblem } from "./network.ts";

test("APP-8: chain ids map to a network, anything else is unknown", () => {
  assert.equal(networkOfChainId("mainnet"), "mainnet");
  assert.equal(networkOfChainId("testnet"), "testnet");
  assert.equal(networkOfChainId("localnet"), null);
  assert.equal(networkOfChainId(undefined), null);
});

test("APP-8: a testnet RPC is refused for a mainnet page, with a message that says so", () => {
  const msg = networkProblem("mainnet", "testnet");
  assert.match(msg!, /testnet/);
  assert.match(msg!, /never shown/i);
});

test("APP-8: a matching RPC is accepted, a mismatch or an unreadable answer is not", () => {
  assert.equal(networkProblem("mainnet", "mainnet"), null);
  assert.equal(networkProblem("testnet", "testnet"), null);
  assert.ok(networkProblem("testnet", "mainnet"));
  assert.ok(networkProblem("mainnet", undefined), "no chain id is not a pass");
});
