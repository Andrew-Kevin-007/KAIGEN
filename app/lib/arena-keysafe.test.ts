import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The visitor's API key must reach nothing but the provider call. This reads the sources of every arena module and
// checks, line by line, that the key variable `apiKey` appears only in the few places that are allowed, that nothing
// in them can store, log or send it elsewhere, and that no route of ours exists to receive it.

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const MODULES = ["lib/arena-providers.ts", "lib/arena-run.ts", "lib/vaultsim.ts", "components/ArenaView.tsx", "app/(app)/arena/page.tsx"];

const lines = (src: string) =>
  src
    .split("\n")
    .map((text, i) => ({ n: i + 1, text }))
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l.text));
const uses = (src: string, name: string) => lines(src).filter((l) => new RegExp(`\\b${name}\\b`).test(l.text));

test("lib/arena-providers.ts: apiKey is a parameter, a Bearer header, an x-api-key header and a redaction argument, nothing else", () => {
  const allowed = [
    /^\s*apiKey: string;$/, // AdapterInit
    /openRouterAdapter\(\{ apiKey, model/, // destructured parameter
    /anthropicAdapter\(\{ apiKey, model/,
    /authorization: `Bearer \$\{apiKey\}` \}/,
    /"x-api-key": apiKey,/,
    /throw await errorFor\("(openrouter|anthropic)", res, apiKey\);/,
    /redact\(b\.error\.message, apiKey\)\.slice\(0, 240\)/,
  ];
  const all = uses(read("lib/arena-providers.ts"), "apiKey");
  assert.deepEqual(all.filter((l) => !allowed.some((re) => re.test(l.text))), [], "apiKey used somewhere not allowed");
  assert.equal(all.filter((l) => /authorization|x-api-key/.test(l.text)).length, 2, "exactly the two provider headers");
});

test("components/ArenaView.tsx: the key is state, an input value, a length and the argument of createAdapter, nothing else", () => {
  const allowed = [
    /const \[apiKey, setApiKey\] = useState\(""\);/,
    /const drop = \(\) => setApiKey\(""\);/,
    /^\s*setApiKey\(""\);$/,
    /createAdapter\(provider, \{ apiKey, model: model\.trim\(\), signal: ctrl\.signal \}\)/,
    /const ready = Boolean\(apiKey\)/,
    /type="password" value=\{apiKey\}.* onChange=\{\(ev\) => setApiKey\(ev\.target\.value\)\}/,
    /disabled=\{!apiKey && !busy\}/,
    /\{apiKey \? ` A key of \$\{apiKey\.length\} characters is held in memory\.` : " No key is held\."\}/,
  ];
  const src = read("components/ArenaView.tsx");
  assert.deepEqual(uses(src, "apiKey").filter((l) => !allowed.some((re) => re.test(l.text))), [], "apiKey used somewhere not allowed");
  assert.match(src, /<input id="ar-key"[\s\S]*?type="password"[\s\S]*?autoComplete="off"/);
  assert.match(src, /addEventListener\("pagehide", drop\)/, "dropped when the page is left");
});

test("the key is never handed to run logic or the vault, and no arena module can store, log or send it elsewhere", () => {
  for (const f of MODULES) {
    const src = lines(read(f)).map((l) => l.text).join("\n");
    for (const re of [/localStorage/, /sessionStorage/, /indexedDB/, /document\.cookie/, /console\./, /sendBeacon/, /XMLHttpRequest/, /WebSocket/, /router\.(push|replace)/, /history\.(push|replace)State/, /location\.(href|search|hash)\s*=/]) {
      assert.ok(!re.test(src), `${f} must not use ${re}`);
    }
  }
  for (const f of ["lib/arena-run.ts", "lib/vaultsim.ts"]) {
    assert.ok(!/apiKey|api_key|secret/i.test(lines(read(f)).map((l) => l.text).join("\n")), `${f} never sees the key`);
  }
  // Every network call goes to one of the two providers' fixed https URLs; the page makes none of its own.
  const prov = read("lib/arena-providers.ts");
  const calls = [...prov.matchAll(/fetchImpl\(([^,)]+)/g)].map((m) => m[1].trim());
  assert.deepEqual(calls.sort(), ["ANTHROPIC_MESSAGES", "OPENROUTER_CHAT", "OPENROUTER_MODELS"]);
  assert.match(prov, /const OPENROUTER_CHAT = "https:\/\/openrouter\.ai\//);
  assert.match(prov, /const OPENROUTER_MODELS = "https:\/\/openrouter\.ai\//);
  assert.match(prov, /const ANTHROPIC_MESSAGES = "https:\/\/api\.anthropic\.com\//);
  assert.ok(!/\bfetch\(/.test(read("components/ArenaView.tsx")));
});

test("the arena has no route or server action of ours: the key has nowhere on this origin to go", () => {
  assert.ok(!readdirSync(join(root, "app/api")).some((d) => /arena/i.test(d)));
  assert.ok(!readdirSync(join(root, "app/(app)/arena")).some((f) => /route\.|action/.test(f)));
  assert.ok(!MODULES.map(read).join("\n").includes('"use server"'));
});

test("the app routes' CSP already lets /arena reach the providers (connect-src https:) and nothing was loosened for it", async () => {
  const { openCsp, headerRules } = await import("./security-headers.ts");
  const csp = openCsp(false);
  assert.match(csp, /connect-src 'self' https:(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
  const rule = headerRules(false).find((r) => r.source.includes("?!migrate"));
  assert.ok(rule?.headers.some((h) => h.key === "Content-Security-Policy" && h.value === csp), "/arena falls under the open rule");
});
