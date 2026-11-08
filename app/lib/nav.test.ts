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
