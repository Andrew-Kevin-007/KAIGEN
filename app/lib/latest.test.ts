import test from "node:test";
import assert from "node:assert/strict";
import { latestOnly } from "./latest.ts";

test("APP-V2: of two overlapping lookups only the newer one is current, whichever answers first", () => {
  const l = latestOnly();
  const first = l.begin();
  assert.equal(first(), true, "alone, it is current");
  const second = l.begin();
  assert.equal(first(), false, "a newer lookup made it stale");
  assert.equal(second(), true);
});

test("APP-V2: invalidate makes everything in flight stale without starting anything", () => {
  const l = latestOnly();
  const a = l.begin();
  l.invalidate();
  assert.equal(a(), false);
  const b = l.begin();
  assert.equal(b(), true, "a request begun after the invalidation is current");
});

test("APP-V2: a slow first answer cannot overwrite a fast second one", async () => {
  const l = latestOnly();
  let shown = "";
  const lookup = async (name: string, ms: number) => {
    const current = l.begin();
    await new Promise((r) => setTimeout(r, ms));
    if (current()) shown = name;
  };
  await Promise.all([lookup("slow", 30), lookup("fast", 1)]);
  assert.equal(shown, "fast");
});
