import test from "node:test";
import assert from "node:assert/strict";
import { ProviderError, anthropicAdapter, loadFreeToolModels, openRouterAdapter, redact, type FetchLike } from "./arena-providers.ts";

const KEY = "sk-or-v1-SECRETSECRETSECRET1234";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Seen {
  url: string;
  init?: RequestInit;
}
function stub(responses: (Response | Error)[]): { fetchImpl: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  let i = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    seen.push({ url, init });
    const r = responses[i++];
    if (!r) throw new Error("unexpected extra call");
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetchImpl, seen };
}

const payCall = { id: "call_1", type: "function", function: { name: "pay", arguments: '{"recipient":"supplier.x","amount_near":0.1}' } };

test("OpenRouter happy path: request shape, tool call parsed, tool answer sent back", async () => {
  const { fetchImpl, seen } = stub([
    json({ choices: [{ message: { content: "Paying.", tool_calls: [payCall] }, finish_reason: "tool_calls" }] }),
    json({ choices: [{ message: { content: "Done." }, finish_reason: "stop" }] }),
  ]);
  const a = openRouterAdapter({ apiKey: KEY, model: "vendor/model:free", fetchImpl });
  a.start("SYS", "USER");
  const t = await a.turn();
  assert.equal(t.text, "Paying.");
  assert.deepEqual(t.calls, [{ id: "call_1", name: "pay", args: { recipient: "supplier.x", amount_near: 0.1 } }]);
  assert.equal(seen[0].url, "https://openrouter.ai/api/v1/chat/completions");
  const h = seen[0].init?.headers as Record<string, string>;
  assert.equal(h.authorization, `Bearer ${KEY}`);
  const body = JSON.parse(String(seen[0].init?.body));
  assert.equal(body.model, "vendor/model:free");
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.tools[0].function.name, "pay");
  assert.deepEqual(body.messages.map((m: { role: string }) => m.role), ["system", "user"]);
  assert.ok(!String(seen[0].init?.body).includes(KEY), "the key is a header, never in the body");
  a.answer(t.calls, ["sent"]);
  const t2 = await a.turn();
  assert.deepEqual([t2.calls.length, t2.stop], [0, "stop"]);
  const body2 = JSON.parse(String(seen[1].init?.body));
  assert.deepEqual(body2.messages.map((m: { role: string }) => m.role), ["system", "user", "assistant", "tool"]);
  assert.equal(body2.messages[3].tool_call_id, "call_1");
  assert.equal(body2.messages[3].content, "sent");
  assert.equal(body2.messages[2].tool_calls[0].function.arguments, payCall.function.arguments);
});

test("OpenRouter: a text-only answer is a turn with no calls", async () => {
  const { fetchImpl } = stub([json({ choices: [{ message: { content: "I will not do that." }, finish_reason: "stop" }] })]);
  const a = openRouterAdapter({ apiKey: KEY, model: "m", fetchImpl });
  a.start("s", "u");
  const t = await a.turn();
  assert.deepEqual([t.text, t.calls.length], ["I will not do that.", 0]);
});

test("OpenRouter: malformed tool arguments become null args, not a crash", async () => {
  const bad = { id: "c", type: "function", function: { name: "pay", arguments: "{oops" } };
  const { fetchImpl } = stub([json({ choices: [{ message: { content: null, tool_calls: [bad] }, finish_reason: "tool_calls" } ] })]);
  const a = openRouterAdapter({ apiKey: KEY, model: "m", fetchImpl });
  a.start("s", "u");
  assert.equal((await a.turn()).calls[0].args, null);
});

for (const [status, kind, words] of [
  [401, "key", /rejected the key/],
  [403, "key", /rejected the key/],
  [429, "rate", /rate limit/],
] as const) {
  test(`OpenRouter ${status} is said in plain words and never echoes the key`, async () => {
    const { fetchImpl } = stub([json({ error: { message: `Incorrect API key provided: ${KEY}` } }, status)]);
    const a = openRouterAdapter({ apiKey: KEY, model: "m", fetchImpl });
    a.start("s", "u");
    await assert.rejects(a.turn(), (e: unknown) => {
      assert.ok(e instanceof ProviderError);
      assert.equal(e.kind, kind);
      assert.match(e.message, words);
      assert.ok(!e.message.includes(KEY) && !e.message.includes("SECRETSECRET"));
      return true;
    });
  });
}

test("OpenRouter: a model without tool support is named as such", async () => {
  const { fetchImpl } = stub([json({ error: { message: "No endpoints found that support tool use. Try disabling tools." } }, 404)]);
  const a = openRouterAdapter({ apiKey: KEY, model: "m", fetchImpl });
  a.start("s", "u");
  await assert.rejects(a.turn(), (e: unknown) => e instanceof ProviderError && e.kind === "no_tools" && /no tool support/.test(e.message));
});

test("a network or CORS failure is said in plain words and does not leak the key", async () => {
  const { fetchImpl } = stub([new TypeError(`Failed to fetch ${KEY}`)]);
  const a = openRouterAdapter({ apiKey: KEY, model: "m", fetchImpl });
  a.start("s", "u");
  await assert.rejects(a.turn(), (e: unknown) => e instanceof ProviderError && e.kind === "network" && /Could not reach OpenRouter/.test(e.message) && !e.message.includes("SECRET"));
});

test("Anthropic happy path: headers, tools format, tool_use parsed, tool_result sent back", async () => {
  const { fetchImpl, seen } = stub([
    json({ content: [{ type: "text", text: "Paying." }, { type: "tool_use", id: "tu_1", name: "pay", input: { recipient: "supplier.x", amount_near: 0.1 } }], stop_reason: "tool_use" }),
    json({ content: [{ type: "text", text: "All paid." }], stop_reason: "end_turn" }),
  ]);
  const a = anthropicAdapter({ apiKey: "sk-ant-api03-AAAAAAAAAAAA", model: "claude-sonnet-5-5", fetchImpl });
  a.start("SYS", "USER");
  const t = await a.turn();
  assert.deepEqual(t.calls, [{ id: "tu_1", name: "pay", args: { recipient: "supplier.x", amount_near: 0.1 } }]);
  assert.equal(seen[0].url, "https://api.anthropic.com/v1/messages");
  const h = seen[0].init?.headers as Record<string, string>;
  assert.equal(h["x-api-key"], "sk-ant-api03-AAAAAAAAAAAA");
  assert.equal(h["anthropic-version"], "2023-06-01");
  assert.equal(h["anthropic-dangerous-direct-browser-access"], "true");
  const body = JSON.parse(String(seen[0].init?.body));
  assert.equal(body.system, "SYS");
  assert.equal(body.tools[0].name, "pay");
  assert.equal(body.tools[0].input_schema.required[0], "recipient");
  a.answer(t.calls, ["refused: x"]);
  const t2 = await a.turn();
  assert.deepEqual([t2.text, t2.calls.length, t2.stop], ["All paid.", 0, "end_turn"]);
  const body2 = JSON.parse(String(seen[1].init?.body));
  assert.deepEqual(body2.messages[2].content[0], { type: "tool_result", tool_use_id: "tu_1", content: "refused: x" });
});

test("Anthropic 401 and 429 in plain words, no key echoed", async () => {
  for (const [status, re] of [[401, /rejected the key/], [429, /rate limit/]] as const) {
    const { fetchImpl } = stub([json({ error: { message: "invalid x-api-key sk-ant-api03-AAAAAAAAAAAA" } }, status)]);
    const a = anthropicAdapter({ apiKey: "sk-ant-api03-AAAAAAAAAAAA", model: "m", fetchImpl });
    a.start("s", "u");
    await assert.rejects(a.turn(), (e: unknown) => e instanceof ProviderError && re.test(e.message) && !e.message.includes("AAAAAAAA"));
  }
});

test("Anthropic: a text-only answer has no calls", async () => {
  const { fetchImpl } = stub([json({ content: [{ type: "text", text: "No." }], stop_reason: "end_turn" })]);
  const a = anthropicAdapter({ apiKey: "k", model: "m", fetchImpl });
  a.start("s", "u");
  assert.equal((await a.turn()).calls.length, 0);
});

test("redact removes the key and token-looking strings from provider text", () => {
  assert.equal(redact("bad key abcd1234efgh", "abcd1234efgh"), "bad key [key]");
  assert.equal(redact("sk-or-v1-abcdefghijkl was wrong", "zzzz"), "[key] was wrong");
});

test("loadFreeToolModels keeps only free models that support tools, calls the public list with no key", async () => {
  const { fetchImpl, seen } = stub([
    json({
      data: [
        { id: "a/free-tools", name: "Zed free", supported_parameters: ["tools", "temperature"], pricing: { prompt: "0", completion: "0" } },
        { id: "b/free-notools", name: "B", supported_parameters: ["temperature"], pricing: { prompt: "0", completion: "0" } },
        { id: "c/paid-tools", name: "C", supported_parameters: ["tools"], pricing: { prompt: "0.000001", completion: "0.000002" } },
        { id: "d/half-free", name: "D", supported_parameters: ["tools"], pricing: { prompt: "0", completion: "0.000002" } },
        { id: "e/nopricing", name: "E", supported_parameters: ["tools"] },
        { id: "f/free-tools", name: "Alpha free", supported_parameters: ["tools"], pricing: { prompt: "0", completion: "0" } },
      ],
    }),
  ]);
  const out = await loadFreeToolModels(fetchImpl);
  assert.deepEqual(out.map((m) => m.id), ["f/free-tools", "a/free-tools"]);
  assert.equal(seen[0].url, "https://openrouter.ai/api/v1/models");
  assert.equal(seen[0].init?.headers, undefined, "no Authorization header on the public list");
});

test("loadFreeToolModels reports a failed list as an error so the page can fall back to a manual id", async () => {
  await assert.rejects(loadFreeToolModels(stub([json({}, 500)]).fetchImpl), (e: unknown) => e instanceof ProviderError && e.kind === "http");
  await assert.rejects(loadFreeToolModels(stub([new TypeError("Failed to fetch")]).fetchImpl), (e: unknown) => e instanceof ProviderError && e.kind === "network");
  await assert.rejects(loadFreeToolModels(stub([json({ nope: 1 })]).fetchImpl), (e: unknown) => e instanceof ProviderError && e.kind === "shape");
});
