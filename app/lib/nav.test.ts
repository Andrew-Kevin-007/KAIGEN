import test from "node:test";
import assert from "node:assert/strict";
import { LINKS, fullLoad } from "./nav.ts";

test("APP-1: /migrate is entered and left by a full page load, every other hop stays a soft navigation", () => {
  assert.equal(fullLoad("/migrate", "/omens"), true, "into the key page");
  assert.equal(fullLoad("/omens", "/migrate"), true, "out of the key page, so its policy does not follow the person");
  assert.equal(fullLoad("/vault", "/migrate"), true);
  assert.equal(fullLoad("/vault", "/omens"), false);
  assert.equal(fullLoad("/bounty", null), false);
});

test("the nav still lists the key page", () => {
  assert.ok(LINKS.some((l) => l.href === "/migrate"));
});

test("the era page moved from / to /omens: / is the landing page and is no longer an app link", () => {
  assert.ok(LINKS.some((l) => l.href === "/omens" && l.label === "Era"));
  assert.ok(!LINKS.some((l) => l.href === "/"));
  assert.ok(LINKS.some((l) => l.href === "/start"));
});

test("X-ray is in the nav, sits before the key page, and is an ordinary soft navigation", () => {
  const i = LINKS.findIndex((l) => l.href === "/xray");
  assert.ok(i >= 0 && LINKS[i].label === "X-ray");
  assert.ok(i < LINKS.findIndex((l) => l.href === "/migrate"));
  assert.equal(fullLoad("/xray", "/vault"), false);
});

test("Arena is in the nav right after X-ray and is an ordinary soft navigation", () => {
  const i = LINKS.findIndex((l) => l.href === "/arena");
  assert.ok(i >= 0 && LINKS[i].label === "Arena");
  assert.equal(LINKS[i - 1].href, "/xray");
  assert.ok(i < LINKS.findIndex((l) => l.href === "/migrate"));
  assert.equal(fullLoad("/arena", "/xray"), false);
});
