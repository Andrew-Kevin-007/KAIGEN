import test from "node:test";
import assert from "node:assert/strict";
import { clientIp, createLimiter } from "./rate-limit.ts";

test("APP-7: a key may make `limit` requests per window, then is told how long to wait", () => {
  let now = 1_000;
  const l = createLimiter({ limit: 3, windowMs: 60_000, now: () => now });
  for (let i = 0; i < 3; i++) assert.equal(l.check("1.1.1.1").ok, true);
  const blocked = l.check("1.1.1.1");
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterSec >= 1 && blocked.retryAfterSec <= 60);
  assert.equal(l.check("2.2.2.2").ok, true, "another address has its own budget");
  now += 60_001;
  assert.equal(l.check("1.1.1.1").ok, true, "the window resets");
});

test("APP-7: the table stays bounded when many addresses show up", () => {
  let now = 0;
  const l = createLimiter({ limit: 1, windowMs: 60_000, maxKeys: 5, now: () => now });
  for (let i = 0; i < 50; i++) l.check(`10.0.0.${i}`);
  assert.ok(l.size() <= 5);
  now += 120_000;
  l.check("fresh");
  assert.ok(l.size() <= 5);
});

test("APP-7: the client address is taken from the proxy's side of the forwarded list, so a client cannot choose its own", () => {
  const h = (v: Record<string, string>) => ({ get: (k: string) => v[k.toLowerCase()] ?? null });
  assert.equal(clientIp(h({ "x-forwarded-for": "9.9.9.9, 203.0.113.7" })), "203.0.113.7");
  assert.equal(clientIp(h({ "x-forwarded-for": "9.9.9.9, 203.0.113.7, 10.0.0.1" }), 2), "203.0.113.7");
  assert.equal(clientIp(h({ "x-real-ip": "198.51.100.4" })), "198.51.100.4");
  assert.equal(clientIp(h({})), "unknown");
});
