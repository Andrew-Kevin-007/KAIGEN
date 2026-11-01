import test from "node:test";
import assert from "node:assert/strict";
import { COMMON_HEADERS, headerRules, migrateCsp, newNonce, openCsp } from "./security-headers.ts";

const directive = (csp: string, name: string) =>
  csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));

const header = (rule: { headers: { key: string; value: string }[] }, key: string) => rule.headers.find((h) => h.key === key)?.value;

test("APP-1: the /migrate policy covers scripts with a nonce instead of unsafe-inline and allows no network", () => {
  const csp = migrateCsp("n0nce==", false);
  assert.equal(directive(csp, "script-src"), "script-src 'self' 'nonce-n0nce=='");
  assert.equal(directive(csp, "connect-src"), "connect-src 'none'");
  assert.equal(directive(csp, "frame-ancestors"), "frame-ancestors 'none'");
  assert.equal(directive(csp, "object-src"), "object-src 'none'");
  assert.equal(directive(csp, "base-uri"), "base-uri 'self'");
  assert.equal(directive(csp, "form-action"), "form-action 'self'");
  assert.ok(!/unsafe-eval/.test(csp), "no eval in production");
  assert.ok(!/'unsafe-inline'/.test(directive(csp, "script-src")!), "no inline scripts without the nonce");
});

test("APP-1: development adds only what hot reload needs", () => {
  const csp = migrateCsp("abc", true);
  assert.match(directive(csp, "script-src")!, /'unsafe-eval'/);
  assert.match(directive(csp, "connect-src")!, /ws:\/\/localhost:\*/);
});

test("APP-1: /migrate is isolated from other windows and other origins, and gets no open-page policy", () => {
  const rules = headerRules(false);
  const migrate = rules.find((r) => r.source === "/migrate");
  assert.ok(migrate, "a rule for /migrate exists");
  assert.equal(header(migrate, "Cross-Origin-Opener-Policy"), "same-origin");
  assert.equal(header(migrate, "Cross-Origin-Resource-Policy"), "same-origin");
  for (const h of COMMON_HEADERS) assert.equal(header(migrate, h.key), h.value);
  // The policy itself carries a per-request nonce, so proxy.ts sets it; a static one here would block Next's own scripts.
  assert.equal(header(migrate, "Content-Security-Policy"), undefined);

  const open = rules.find((r) => r.source !== "/migrate");
  assert.ok(open);
  const source = new RegExp(`^${open.source}$`);
  assert.equal(source.test("/migrate"), false, "the open policy never applies to /migrate");
  assert.equal(source.test("/vault"), true);
  assert.equal(source.test("/"), true);
  assert.equal(header(open, "Content-Security-Policy"), openCsp(false));
  assert.equal(header(open, "Cross-Origin-Opener-Policy"), undefined, "wallet popups need window.opener on open pages");
});

test("APP-1: nonces are unique and long enough", () => {
  const a = newNonce();
  const b = newNonce();
  assert.notEqual(a, b);
  assert.ok(Buffer.from(a, "base64").length >= 16);
});
