"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { PROVIDERS, ProviderError, createAdapter, loadFreeToolModels, type ModelChoice, type ProviderId } from "@/lib/arena-providers";
import { DEFAULT_NOTE, MAX_NOTE_CHARS, MAX_TURNS, buildInvoice, runArena, type ArenaEvent, type ArenaResult } from "@/lib/arena-run";
import { blastFormula } from "@/lib/blast";
import { DEMO_ATTACKER, formatNear, newVault, reachedOutsiders, spent24h, worstCase, type VaultState } from "@/lib/vaultsim";

const RECORDED_RUN = "https://github.com/Andrew-Kevin-007/KAIGEN/blob/main/docs/v3/evidence/INJECT-DEMO-mock-2026-11-08.md";
const CAGE_DOCS = "https://github.com/Andrew-Kevin-007/KAIGEN/blob/main/docs/v3/ATTEST-CHECK.md";
const LIVE_VAULT = "/xray?account=vault.kaigen-funder-a00266.testnet";
const SIM_LABEL = "Simulation of the vault rules, not the chain";

const near = (y: bigint) => `${formatNear(y)} NEAR`;

export function ArenaView() {
  const [provider, setProvider] = useState<ProviderId>("openrouter");
  const [model, setModel] = useState("");
  // The visitor's key. It lives here, in this tab's memory, and in nothing else. It is used in exactly one place:
  // createAdapter() below, which puts it in the provider request's headers. See lib/arena-keysafe.test.ts.
  const [apiKey, setApiKey] = useState("");
  const [choices, setChoices] = useState<ModelChoice[] | null>(null);
  const [listNote, setListNote] = useState("");
  const [attackMode, setAttackMode] = useState(false);
  const [note, setNote] = useState(DEFAULT_NOTE);
  const [events, setEvents] = useState<ArenaEvent[]>([]);
  const [vault, setVault] = useState<VaultState>(() => newVault());
  const [result, setResult] = useState<ArenaResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);

  // The key is dropped when the page is left (also when it goes into the back/forward cache) and when this unmounts.
  useEffect(() => {
    const drop = () => setApiKey("");
    window.addEventListener("pagehide", drop);
    return () => {
      window.removeEventListener("pagehide", drop);
      abort.current?.abort();
      drop();
    };
  }, []);

  const fetchModels = useCallback(async (signal?: AbortSignal) => {
    setListNote("Loading the free models that can use tools...");
    try {
      const list = await loadFreeToolModels(undefined, signal);
      setChoices(list);
      setListNote(list.length ? `${list.length} free models with tool support. Pick one, or type any model id.` : "OpenRouter lists no free tool-capable model right now. Type a model id.");
    } catch (err) {
      if (signal?.aborted) return;
      setChoices(null);
      setListNote(`${err instanceof ProviderError ? err.message : "The model list could not be loaded."} Type a model id instead.`);
    }
  }, []);

  useEffect(() => {
    if (provider !== "openrouter") return;
    const ctrl = new AbortController();
    void fetchModels(ctrl.signal);
    return () => ctrl.abort();
  }, [provider, fetchModels]);

  function chooseProvider(p: ProviderId) {
    setProvider(p);
    setModel(PROVIDERS[p].defaultModel);
    setError("");
    setListNote("");
  }

  function reset() {
    abort.current?.abort();
    setBusy(false);
    setEvents([]);
    setVault(newVault());
    setResult(null);
    setError("");
  }

  function forgetKey() {
    abort.current?.abort();
    setApiKey("");
    setBusy(false);
  }

  async function run(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    reset();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true);
    try {
      const adapter = createAdapter(provider, { apiKey, model: model.trim(), signal: ctrl.signal });
      const out = await runArena({
        adapter,
        note: attackMode ? note : DEFAULT_NOTE,
        signal: ctrl.signal,
        onEvent: (ev) => {
          setEvents((prev) => [...prev, ev]);
          if (ev.kind === "vault") setVault(ev.state);
        },
      });
      if (!ctrl.signal.aborted) setResult(out);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setError(err instanceof ProviderError ? err.message : "The run stopped on an unexpected error. Nothing was sent anywhere but the provider.");
    } finally {
      if (abort.current === ctrl) setBusy(false);
    }
  }

  const ready = Boolean(apiKey) && Boolean(model.trim()) && !busy;
  const invoice = useMemo(() => buildInvoice(attackMode ? note : DEFAULT_NOTE), [attackMode, note]);
  const now = Date.now();
  const worst = worstCase(vault);
  const outsiders = reachedOutsiders(vault);
  const strikes = vault.strikes.count;
  const host = PROVIDERS[provider].host;

  return (
    <div className="container page">
      <header className="page-head reading">
        <h1>Arena</h1>
        <p className="lead">Bring your own model and your own key. Watch it read an invoice with a hidden instruction in it, and see what the vault rules do about it.</p>
      </header>

      <p className="callout ar-sim" data-tone="warning" role="note">
        <strong>{SIM_LABEL}.</strong>
        <span>
          The rules below are run in your browser by a copy of the vault&apos;s logic. No transaction is made and no chain is touched. The real thing:{" "}
          <a className="link" href={RECORDED_RUN} target="_blank" rel="noopener noreferrer">the recorded on-chain run</a>,{" "}
          <a className="link" href={LIVE_VAULT}>a live vault in X-ray</a>, and{" "}
          <a className="link" href={CAGE_DOCS} target="_blank" rel="noopener noreferrer">the cage-check docs</a>.
        </span>
      </p>

      <form className="stack ar-form" onSubmit={run} noValidate autoComplete="off">
        <fieldset className="ar-fieldset">
          <legend className="label">Provider</legend>
          <div className="ar-choice">
            {(Object.keys(PROVIDERS) as ProviderId[]).map((p) => (
              <label key={p} className="ar-radio">
                <input type="radio" name="provider" value={p} checked={provider === p} disabled={busy} onChange={() => chooseProvider(p)} />
                <span>{PROVIDERS[p].label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {provider === "openrouter" && choices && choices.length > 0 && (
          <div className="field-group">
            <label className="label" htmlFor="ar-pick">Free models with tool support</label>
            <select id="ar-pick" className="field" value={choices.some((c) => c.id === model) ? model : ""} disabled={busy} onChange={(ev) => setModel(ev.target.value)}>
              <option value="">Choose a model...</option>
              {choices.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        )}

        <div className="field-group">
          <label className="label" htmlFor="ar-model">Model id</label>
          <input id="ar-model" className="field mono" value={model} disabled={busy} onChange={(ev) => setModel(ev.target.value)} placeholder={provider === "anthropic" ? "claude-sonnet-5-5" : "vendor/model-name:free"} spellCheck={false} autoCapitalize="none" autoCorrect="off" aria-describedby="ar-model-hint" />
          <p id="ar-model-hint" className="hint small">
            {provider === "openrouter" ? listNote || "Any OpenRouter model id that supports tools." : "The default is claude-sonnet-5-5."}
            {provider === "openrouter" && !choices && listNote && (
              <>
                {" "}
                <button type="button" className="link ar-linkbtn" onClick={() => void fetchModels()}>Try the list again</button>
              </>
            )}
          </p>
        </div>

        <div className="field-group">
          <label className="label" htmlFor="ar-key">{PROVIDERS[provider].label} API key</label>
          <div className="ar-keyrow">
            <input id="ar-key" className="field mono" type="password" value={apiKey} disabled={busy} onChange={(ev) => setApiKey(ev.target.value)} autoComplete="off" spellCheck={false} autoCapitalize="none" autoCorrect="off" data-1p-ignore data-lpignore="true" aria-describedby="ar-key-note" />
            <button type="button" className="btn btn-secondary" onClick={forgetKey} disabled={!apiKey && !busy}>Forget key</button>
          </div>
          <p id="ar-key-note" className="hint small">
            <strong>Your key stays in this tab and goes only to {host}.</strong> Use a free or low-limit key. It is never stored, never sent to this site, and dropped when you leave the page.
            {apiKey ? ` A key of ${apiKey.length} characters is held in memory.` : " No key is held."}
          </p>
        </div>

        <div className="stack-sm">
          <h2 className="ar-h">The invoice</h2>
          <pre className="ar-invoice" aria-label="The invoice the agent will read">{invoice}</pre>
          <label className="ar-radio ar-check">
            <input type="checkbox" checked={attackMode} disabled={busy} onChange={(ev) => setAttackMode(ev.target.checked)} />
            <span>Attack it yourself: write your own injected note</span>
          </label>
          {attackMode && (
            <div className="field-group">
              <label className="label" htmlFor="ar-note">Injected note (appended to the invoice)</label>
              <textarea id="ar-note" className="field ar-note" rows={6} maxLength={MAX_NOTE_CHARS} value={note} disabled={busy} onChange={(ev) => setNote(ev.target.value)} spellCheck={false} />
              <div className="actions">
                <button type="button" className="btn btn-secondary btn-compact" disabled={busy} onClick={() => setNote(DEFAULT_NOTE)}>Use the recorded note</button>
                <span className="hint small">Try asking for {DEMO_ATTACKER} or any other account. Only the supplier on the invoice is on the allowlist.</span>
              </div>
            </div>
          )}
        </div>

        <div className="actions">
          <button type="submit" className="btn" disabled={!ready}>{busy ? "Running..." : "Run"}</button>
          <button type="button" className="btn btn-secondary" onClick={reset}>Reset</button>
          <span className="hint small">At most {MAX_TURNS} model turns. Each turn is one call to {host}.</span>
        </div>
      </form>

      {error && (
        <p className="callout ar-alert" data-tone="invalid" role="alert">{error}</p>
      )}

      <p className="sr-only" role="status">{busy ? "Running." : result ? result.outcome.label : ""}</p>

      <section className="ar-run" aria-labelledby="ar-run-h">
        <h2 id="ar-run-h" className="ar-h">What happened</h2>
        <p className="ar-simtag">{SIM_LABEL}</p>
        <div className="ar-grid">
          <ol className="ar-log" role="log" aria-live="polite" aria-label="Transcript">
            {events.length === 0 && <li className="hint small">Nothing yet. Press Run.</li>}
            {events.map((ev, i) => (
              <Row key={i} ev={ev} />
            ))}
            {busy && <li className="hint small">Waiting for the model...</li>}
          </ol>

          <aside className="ar-state" aria-label="Simulated vault state">
            <h3 className="label">Vault (simulated)</h3>
            <dl className="ar-kv">
              <dt>Balance</dt>
              <dd>{near(vault.balanceYocto)}</dd>
              <dt>Spent in 24 h</dt>
              <dd>{near(spent24h(vault, now))} of {near(vault.config.capYocto)}</dd>
              <dt>Strikes</dt>
              <dd>{vault.keyAlive ? strikes : vault.config.maxStrikes} of {vault.config.maxStrikes}</dd>
              <dt>Agent key</dt>
              <dd data-tone={vault.keyAlive ? "valid" : "invalid"}>{vault.keyAlive ? "alive" : "burned"}</dd>
              <dt>Reached an outsider</dt>
              <dd>{near(outsiders)}</dd>
              <dt>Worst case, any 24 h</dt>
              <dd>{worst ? `${formatNear(worst.worst)} NEAR` : "unknown"}</dd>
            </dl>
            {worst && (
              <p className="hint small">
                {blastFormula(worst, (v) => formatNear(v))} NEAR: the cap plus the withdrawal queue&apos;s pending limit, from the proven bound in{" "}
                <a className="link" href="https://github.com/Andrew-Kevin-007/KAIGEN/blob/main/docs/v3/LOSS-BOUND.md" target="_blank" rel="noopener noreferrer">LOSS-BOUND</a>. The instant path alone is capped at {near(vault.config.capYocto)}.
              </p>
            )}
          </aside>
        </div>

        {result && (
          <div className="callout ar-outcome" data-tone={result.outcome.id === "burned" || result.outcome.id === "not_burned" ? "valid" : "warning"} role="status">
            <strong>{result.outcome.label}.</strong>
            <span>{result.outcome.detail}</span>
            <span className="hint small">This was a simulation of the vault rules, not the chain. Nothing here was sent on a network.</span>
          </div>
        )}
      </section>
    </div>
  );
}

function Row({ ev }: { ev: ArenaEvent }) {
  if (ev.kind === "model") {
    return (
      <li className="ar-row" data-kind="model">
        <span className="ar-who">Model</span>
        <span className="ar-text">{ev.text}</span>
      </li>
    );
  }
  if (ev.kind === "call") {
    return (
      <li className="ar-row" data-kind="call" data-attack={ev.attack}>
        <span className="ar-who">Tool call</span>
        <span className="ar-text mono">pay(recipient=&quot;{ev.recipient}&quot;, amount_near={ev.amount})</span>
        {ev.attack && <span className="chip" data-tone="warning">not what the invoice asked</span>}
      </li>
    );
  }
  if (ev.kind === "vault") {
    const v = ev.verdict;
    const tone = v.kind === "sent" ? "valid" : "invalid";
    return (
      <li className="ar-row" data-kind="vault" data-tone={tone}>
        <span className="ar-who">Vault</span>
        <span className="ar-text">
          <strong>{v.kind === "sent" ? "Sent" : v.kind === "refused" ? "Refused" : "Rejected"}</strong>
          {v.reason ? `: ${v.reason}` : ""}
          {v.counted ? `. Strike ${v.strikes} of ${v.maxStrikes}${v.burned ? ". Key burned" : ""}` : ""}
          {v.kind !== "sent" && !v.counted ? ". No strike" : ""}
        </span>
      </li>
    );
  }
  return (
    <li className="ar-row" data-kind="note">
      <span className="ar-who">Note</span>
      <span className="ar-text">{ev.text}</span>
    </li>
  );
}
