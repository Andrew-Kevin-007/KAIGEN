import test from "node:test";
import assert from "node:assert/strict";
import { LINKS, fullLoad } from "./nav.ts";

test("APP-1: /migrate is entered and left by a full page load, every other hop stays a soft navigation", () => {
  assert.equal(fullLoad("/migrate", "/"), true, "into the key page");
  assert.equal(fullLoad("/", "/migrate"), true, "out of the key page, so its policy does not follow the person");
  assert.equal(fullLoad("/vault", "/migrate"), true);
  assert.equal(fullLoad("/vault", "/"), false);
  assert.equal(fullLoad("/bounty", null), false);
});

test("the nav still lists the key page", () => {
  assert.ok(LINKS.some((l) => l.href === "/migrate"));
});
