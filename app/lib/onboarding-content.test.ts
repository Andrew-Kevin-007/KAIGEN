import test from "node:test";
import assert from "node:assert/strict";
import { CAVEATS, WALKTHROUGH } from "./onboarding-content.ts";

const allText = [...CAVEATS, ...WALKTHROUGH.flatMap((s) => [s.title, ...s.paragraphs, ...(s.commands ?? [])])].join("\n");

test("the walkthrough has 4 to 6 steps, each with text and a source line", () => {
  assert.ok(WALKTHROUGH.length >= 4 && WALKTHROUGH.length <= 6, `got ${WALKTHROUGH.length}`);
  for (const s of WALKTHROUGH) {
    assert.ok(s.paragraphs.length > 0, s.id);
    assert.match(s.source, /docs\/v3\/|jobs\/src\//, `${s.id} names its source file`);
  }
  assert.equal(new Set(WALKTHROUGH.map((s) => s.id)).size, WALKTHROUGH.length, "ids are unique");
});

test("it never claims novelty, priority, uniqueness or unbreakability, and never compares with other projects", () => {
  assert.doesNotMatch(allText, /\b(novel|first|unique|unbreakable|unhackable|secure)\b/i);
  assert.doesNotMatch(allText, /\b(better than|unlike|compared (to|with)|versus|vs\.?)\b/i);
});

test("the caveats say testnet only, no audit, not run on mainnet, drill omens", () => {
  const caveats = CAVEATS.join(" ");
  for (const needle of [/testnet only/i, /no audit/i, /not run on mainnet/i, /drill omens/i]) assert.match(caveats, needle);
});

test("it does not promise what the browser cannot do: the CLI step says so and lists only commands the sources give", () => {
  const cli = WALKTHROUGH.find((s) => s.id === "cli");
  assert.ok(cli);
  assert.match(cli.paragraphs.join(" "), /do not add a daily key, set limits, edit the allowlist/i);
  for (const c of cli.commands ?? []) assert.match(c, /^node jobs\/src\/bin\.mjs (testnet|demo|cage-check)\b/);
});

test("every number in the text is one that the measured documents give", () => {
  // 3 strikes, 10 s drill delay, 86,400 s floor, 24 hour windows, 10x pending default, 1 NEAR cap, 11 NEAR (C + P),
  // 21 blocks, 2026-11-04 rehearsal, 3 steps of the strike story. Anything else needs a source added before it is allowed here.
  const allowed = new Set(["1", "2", "3", "10", "11", "21", "24", "86400", "2026", "04"]);
  for (const raw of allText.match(/\d+(?:,\d{3})*/g) ?? []) assert.ok(allowed.has(raw.replace(/,/g, "")), `unlisted number ${raw}`);
});
