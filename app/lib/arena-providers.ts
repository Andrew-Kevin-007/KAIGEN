// Provider adapters for /arena. The visitor's own key goes from their browser straight to the provider's API and nowhere
// else. This is the ONLY module that receives the key: it is used in the request headers of the provider call and in
// nothing else (never logged, never put in a URL, never stored, never in an error message). lib/arena-keysafe.test.ts
// scans the sources of the arena modules and fails if that stops being true.

export type ProviderId = "openrouter" | "anthropic";

export const PROVIDERS: Record<ProviderId, { label: string; host: string; defaultModel: string }> = {
  openrouter: { label: "OpenRouter", host: "openrouter.ai", defaultModel: "" },
  anthropic: { label: "Anthropic", host: "api.anthropic.com", defaultModel: "claude-sonnet-5-5" },
};

const OPENROUTER_CHAT = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models";
const ANTHROPIC_MESSAGES = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 1024;
const TIMEOUT_MS = 90_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The one tool the agent has. */
export const PAY_TOOL = {
  name: "pay",
  description: "Send NEAR from the company vault to a NEAR account. Returns the vault's answer.",
  parameters: {
    type: "object",
    properties: {
      recipient: { type: "string", description: "NEAR account id to pay" },
      amount_near: { type: "number", description: "Amount in NEAR" },
    },
    required: ["recipient", "amount_near"],
  },
} as const;

export interface ToolCall {
  id: string;
  name: string;
  /** The arguments the model sent, parsed; null if they were not valid JSON. */
  args: unknown;
}

export interface ModelTurn {
  text: string;
  calls: ToolCall[];
  /** The provider's own stop reason, for the transcript. */
  stop: string;
}

/** A conversation with one model. It keeps the message history; the key lives only in its closure. */
export interface Adapter {
  provider: ProviderId;
  start(system: string, user: string): void;
  turn(): Promise<ModelTurn>;
  /** Hand the vault's answers back to the model, one text per call, in order. */
  answer(calls: ToolCall[], texts: string[]): void;
}

/** A provider problem in plain words. `message` never contains the key. */
export class ProviderError extends Error {
  readonly kind: "key" | "rate" | "no_tools" | "network" | "http" | "stopped" | "shape";
  constructor(kind: ProviderError["kind"], message: string) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
  }
}

/** Removes the key (and anything that looks like a long token) from text that came back from a provider. */
export function redact(text: string, secret: string): string {
  let out = text;
  if (secret.length >= 4) out = out.split(secret).join("[key]");
  return out.replace(/\b(?:sk|or|key)[-_][A-Za-z0-9_-]{8,}/g, "[key]");
}

async function providerMessage(res: Response, secret: string): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  const b = body as { error?: { message?: unknown } | string } | null;
  const raw = typeof b?.error === "string" ? b.error : typeof b?.error?.message === "string" ? b.error.message : "";
  return redact(raw, secret).slice(0, 240);
}

/** HTTP status (and the provider's own words) to a plain-words error. */
export async function errorFor(provider: ProviderId, res: Response, secret: string): Promise<ProviderError> {
  const who = PROVIDERS[provider].label;
  const said = await providerMessage(res, secret);
  if (res.status === 401 || res.status === 403) return new ProviderError("key", `${who} rejected the key (HTTP ${res.status}). Check that it is correct, active and allowed to use this model.`);
  if (res.status === 429) return new ProviderError("rate", `${who} says the rate limit or quota is used up (HTTP 429). Wait a minute, or use another model or key.`);
  if ((res.status === 404 || res.status === 400) && /tool/i.test(said)) return new ProviderError("no_tools", `This model has no tool support on ${who}, so it cannot be the payments agent. Pick a model that supports tools.`);
  if (res.status === 404) return new ProviderError("http", `${who} does not know this model id (HTTP 404). Check the spelling.`);
  return new ProviderError("http", `${who} answered HTTP ${res.status}${said ? `: ${said}` : ""}.`);
}

function networkError(provider: ProviderId, err: unknown): ProviderError {
  if (err instanceof DOMException && err.name === "AbortError") return new ProviderError("stopped", "Stopped.");
  if (err instanceof DOMException && err.name === "TimeoutError") return new ProviderError("network", `${PROVIDERS[provider].label} did not answer in ${TIMEOUT_MS / 1000} seconds.`);
  return new ProviderError("network", `Could not reach ${PROVIDERS[provider].label}. This is a network error, or the browser blocked the call (an extension, a firewall, or the provider not allowing browser calls). Nothing was sent to anyone else.`);
}

const parseArgs = (raw: unknown): unknown => {
  if (typeof raw !== "string") return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

interface AdapterInit {
  apiKey: string;
  model: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}

function timeoutSignal(signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, t]) : t;
}

// ---- OpenRouter (OpenAI chat-completions format) -----------------------------------------------------------------------

interface OaiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
}

export function openRouterAdapter({ apiKey, model, fetchImpl = fetch, signal }: AdapterInit): Adapter {
  let messages: OaiMessage[] = [];
  return {
    provider: "openrouter",
    start(system, user) {
      messages = [
        { role: "system", content: system },
        { role: "user", content: user },
      ];
    },
    async turn() {
      let res: Response;
      try {
        res = await fetchImpl(OPENROUTER_CHAT, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages,
            tools: [{ type: "function", function: PAY_TOOL }],
            tool_choice: "auto",
            max_tokens: MAX_TOKENS,
          }),
          signal: timeoutSignal(signal),
        });
      } catch (err) {
        throw networkError("openrouter", err);
      }
      if (!res.ok) throw await errorFor("openrouter", res, apiKey);
      const body: unknown = await res.json().catch(() => null);
      const b = body as { error?: { message?: unknown }; choices?: { message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }[] } | null;
      const choice = b?.choices?.[0];
      if (!choice?.message) {
        const said = typeof b?.error?.message === "string" ? redact(b.error.message, apiKey).slice(0, 240) : "";
        throw new ProviderError("shape", `OpenRouter's answer had no message${said ? `: ${said}` : ""}.`);
      }
      const text = typeof choice.message.content === "string" ? choice.message.content.trim() : "";
      const raw = Array.isArray(choice.message.tool_calls) ? (choice.message.tool_calls as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }[]) : [];
      const calls: ToolCall[] = raw.map((c, i) => ({
        id: typeof c.id === "string" && c.id ? c.id : `call_${messages.length}_${i}`,
        name: typeof c.function?.name === "string" ? c.function.name : "",
        args: parseArgs(c.function?.arguments),
      }));
      messages = [
        ...messages,
        {
          role: "assistant",
          content: text || null,
          ...(calls.length ? { tool_calls: calls.map((c, i) => ({ id: c.id, type: "function", function: { name: c.name, arguments: typeof (raw[i]?.function?.arguments) === "string" ? raw[i].function?.arguments : JSON.stringify(c.args ?? {}) } })) } : {}),
        },
      ];
      return { text, calls, stop: typeof choice.finish_reason === "string" ? choice.finish_reason : "none" };
    },
    answer(calls, texts) {
      messages = [...messages, ...calls.map((c, i): OaiMessage => ({ role: "tool", tool_call_id: c.id, content: texts[i] ?? "" }))];
    },
  };
}

// ---- Anthropic (Messages API) ------------------------------------------------------------------------------------------

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown };
interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | unknown[];
}

export function anthropicAdapter({ apiKey, model, fetchImpl = fetch, signal }: AdapterInit): Adapter {
  let system = "";
  let messages: AnthropicMessage[] = [];
  return {
    provider: "anthropic",
    start(sys, user) {
      system = sys;
      messages = [{ role: "user", content: user }];
    },
    async turn() {
      let res: Response;
      try {
        res = await fetchImpl(ANTHROPIC_MESSAGES, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({
            model,
            max_tokens: MAX_TOKENS,
            system,
            tools: [{ name: PAY_TOOL.name, description: PAY_TOOL.description, input_schema: PAY_TOOL.parameters }],
            messages,
          }),
          signal: timeoutSignal(signal),
        });
      } catch (err) {
        throw networkError("anthropic", err);
      }
      if (!res.ok) throw await errorFor("anthropic", res, apiKey);
      const body: unknown = await res.json().catch(() => null);
      const b = body as { content?: unknown; stop_reason?: unknown } | null;
      if (!b || !Array.isArray(b.content)) throw new ProviderError("shape", "Anthropic's answer had no content.");
      const content = b.content as Block[];
      const text = content
        .filter((x) => x.type === "text" && typeof x.text === "string")
        .map((x) => (x.text ?? "").trim())
        .filter(Boolean)
        .join("\n");
      const calls: ToolCall[] = content
        .filter((x) => x.type === "tool_use")
        .map((x, i) => ({ id: typeof x.id === "string" && x.id ? x.id : `toolu_${messages.length}_${i}`, name: typeof x.name === "string" ? x.name : "", args: x.input ?? null }));
      messages = [...messages, { role: "assistant", content }];
      return { text, calls, stop: typeof b.stop_reason === "string" ? b.stop_reason : "none" };
    },
    answer(calls, texts) {
      messages = [...messages, { role: "user", content: calls.map((c, i) => ({ type: "tool_result", tool_use_id: c.id, content: texts[i] ?? "" })) }];
    },
  };
}

export function createAdapter(provider: ProviderId, init: AdapterInit): Adapter {
  return provider === "anthropic" ? anthropicAdapter(init) : openRouterAdapter(init);
}

// ---- OpenRouter's public model list (no key is sent) ------------------------------------------------------------------

export interface ModelChoice {
  id: string;
  name: string;
}

/** Free models that can call tools, from the public list. Throws ProviderError("network"|"http") if the list cannot be had. */
export async function loadFreeToolModels(fetchImpl: FetchLike = fetch, signal?: AbortSignal): Promise<ModelChoice[]> {
  let res: Response;
  try {
    res = await fetchImpl(OPENROUTER_MODELS, { signal: timeoutSignal(signal) });
  } catch (err) {
    throw networkError("openrouter", err);
  }
  if (!res.ok) throw new ProviderError("http", `OpenRouter's model list answered HTTP ${res.status}.`);
  const body: unknown = await res.json().catch(() => null);
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new ProviderError("shape", "OpenRouter's model list was not in the expected form.");
  const out: ModelChoice[] = [];
  for (const m of data as { id?: unknown; name?: unknown; supported_parameters?: unknown; pricing?: { prompt?: unknown; completion?: unknown } }[]) {
    if (typeof m.id !== "string") continue;
    const tools = Array.isArray(m.supported_parameters) && m.supported_parameters.includes("tools");
    const free = Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0 && m.pricing?.prompt !== undefined && m.pricing?.completion !== undefined;
    if (tools && free) out.push({ id: m.id, name: typeof m.name === "string" ? m.name : m.id });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
