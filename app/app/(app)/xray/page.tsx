"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { XrayReport } from "@/components/XrayReport";
import { isAccountId } from "@/lib/account";
import { describedBy } from "@/lib/aria";
import { isCodeHash } from "@/lib/cage";
import { errorText } from "@/lib/errors";
import { latestOnly } from "@/lib/latest";
import { NETWORK } from "@/lib/network";
import { accountFromSearch } from "@/lib/onboarding";
import { xray, type Xray } from "@/lib/xray";

// One-click examples. All three are testnet accounts the project made; they are shown only on a testnet deployment.
const EXAMPLES = [
  { id: "vault.kaigen-funder-a00266.testnet", label: "Live testnet vault", note: "the drill-build vault the site was rehearsed on" },
  { id: "pv-45cbcb96.kaigen-funder-ee0d56.testnet", label: "Production-mode vault", note: "ML-DSA admin only, the published production code" },
  { id: "kaigen-funder-a00266.testnet", label: "Ordinary account", note: "no contract, one full-access key" },
];

export default function XrayPage() {
  const [account, setAccount] = useState("");
  const [codeHash, setCodeHash] = useState("");
  const [admin, setAdmin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<Xray | null>(null);
  const [lookups] = useState(latestOnly);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      lookups.invalidate();
      inFlight.current?.abort();
    },
    [lookups],
  );

  // A link can open this page with ?account=<id>: fill the box and read it once.
  useEffect(() => {
    const id = accountFromSearch(window.location.search);
    if (!id) return;
    setAccount(id);
    void run(id);
    // Once, on arrival: run only uses state that never changes identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(raw: string) {
    const id = raw.trim().toLowerCase();
    inFlight.current?.abort();
    const current = lookups.begin();
    setError("");
    setReport(null);
    if (!isAccountId(id)) {
      setBusy(false);
      return setError("That is not a valid NEAR account name.");
    }
    const pin = codeHash.trim();
    if (pin && !isCodeHash(pin)) {
      setBusy(false);
      return setError("The expected code hash is not a base58 sha-256 (32 bytes). Leave it empty to skip it.");
    }
    setBusy(true);
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    try {
      const out = await xray(id, { expectedCodeHash: pin || undefined, expectedAdmin: admin.trim() || undefined }, ctrl.signal);
      if (current()) setReport(out);
    } catch (err) {
      if (current()) setError(errorText(err, "That account could not be read."));
    } finally {
      if (current()) setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void run(account);
  }

  function pick(id: string) {
    setAccount(id);
    void run(id);
  }

  return (
    <div className="container page">
      <header className="page-head reading">
        <h1>X-ray an account</h1>
        <p className="lead">Paste any NEAR account. Read-only: it lists every access key and grades how safely the account is caged. It works for accounts that are not ours.</p>
      </header>

      <p className="sr-only" role="status">
        {report ? `Read ${report.facts.account}. Verdict ${report.result.verdict}.` : busy ? "Reading the account." : ""}
      </p>

      <form className="stack reading" onSubmit={submit} noValidate>
        <div className="inline-form">
          <div className="field-group">
            <label className="label" htmlFor="xray-account">
              Account
            </label>
            <input
              id="xray-account"
              className="field"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              placeholder={NETWORK === "testnet" ? "name.testnet" : "name.near"}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              inputMode="url"
              aria-invalid={Boolean(error) && !report}
              aria-describedby={describedBy(Boolean(error) && !report && "xray-error")}
            />
          </div>
          <button type="submit" className="btn" disabled={!account.trim()}>
            {busy ? "Reading..." : "X-ray"}
          </button>
        </div>

        <details className="xr-more">
          <summary>Pin what you expect (optional)</summary>
          <div className="stack-sm" style={{ marginTop: "1rem" }}>
            <div className="field-group">
              <label className="label" htmlFor="xray-hash">
                Expected code hash (base58)
              </label>
              <input id="xray-hash" className="field mono" value={codeHash} onChange={(e) => setCodeHash(e.target.value)} spellCheck={false} autoCapitalize="none" autoCorrect="off" />
              <p className="hint small">Without one, the code-hash row is green only for the published Mamori production build, and unknown for any other code.</p>
            </div>
            <div className="field-group">
              <label className="label" htmlFor="xray-admin">
                Expected admin key, as the chain lists it
              </label>
              <input id="xray-admin" className="field mono" value={admin} onChange={(e) => setAdmin(e.target.value)} placeholder="ml-dsa-65-hash:..." spellCheck={false} autoCapitalize="none" autoCorrect="off" />
            </div>
          </div>
        </details>

        {NETWORK === "testnet" && (
          <div className="stack-sm" role="group" aria-label="Examples">
            <span className="label">Try one</span>
            <ul className="xr-examples">
              {EXAMPLES.map((ex) => (
                <li key={ex.id}>
                  <button type="button" className="btn btn-secondary btn-compact" onClick={() => pick(ex.id)}>
                    {ex.label}
                  </button>
                  <span className="small body">
                    <span className="mono">{ex.id}</span>, {ex.note}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </form>

      {error && (
        <div className="reading" style={{ marginTop: "1.25rem" }}>
          <p id="xray-error" role="alert" className="callout" data-tone="invalid">
            {error}
          </p>
        </div>
      )}

      {busy && !report && (
        <p className="small body" style={{ marginTop: "1.25rem" }}>
          Reading the chain...
        </p>
      )}

      {report && <XrayReport facts={report.facts} result={report.result} />}
    </div>
  );
}
