"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { WalletError } from "@/components/WalletError";
import { Walkthrough } from "@/components/Walkthrough";
import { isAccountId } from "@/lib/account";
import { CAVEATS } from "@/lib/onboarding-content";
import { demoVaultFor, nextStep, vaultCandidates, vaultLink, type ProbeResult } from "@/lib/onboarding";
import { NETWORK } from "@/lib/network";
import { probeVault } from "@/lib/vault-probe";
import { useWallet } from "@/lib/wallet";

export default function StartPage() {
  const router = useRouter();
  const wallet = useWallet();
  const [results, setResults] = useState<Record<string, ProbeResult>>({});
  const [typed, setTyped] = useState("");
  const [looking, setLooking] = useState(false);
  const [typedError, setTypedError] = useState("");

  const candidates = useMemo(() => vaultCandidates(wallet.account), [wallet.account]);
  const step = nextStep({ account: wallet.account, network: NETWORK, candidates, results });
  const demo = demoVaultFor(NETWORK);

  // Read each candidate once, in order, for the connected account. A new account starts from nothing.
  useEffect(() => {
    setResults({});
    if (candidates.length === 0) return;
    const ctrl = new AbortController();
    (async () => {
      for (const id of candidates) {
        const r = await probeVault(id, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setResults((prev) => ({ ...prev, [id]: r }));
        if (r.ok) return;
      }
    })();
    return () => ctrl.abort();
  }, [candidates]);

  // A vault found for the connected account goes straight to its view.
  useEffect(() => {
    if (step.kind === "open-vault") router.replace(vaultLink(step.account));
  }, [step, router]);

  async function lookUp(e: FormEvent) {
    e.preventDefault();
    const id = typed.trim().toLowerCase();
    setTypedError("");
    if (!isAccountId(id)) return setTypedError("That is not a valid NEAR account name.");
    setLooking(true);
    const r = await probeVault(id);
    setLooking(false);
    if (r.ok) return router.push(vaultLink(id));
    // A definite "not a vault" and a failed read are different sentences: a failed read says nothing about the account.
    setTypedError(r.kind === "none" ? `${id} is not a KAIGEN vault: ${r.message}` : `Could not check ${id}: ${r.message}`);
  }

  return (
    <div className="container page">
      <header className="page-head reading">
        <p className="caption">Start · NEAR {NETWORK}</p>
        <h1>Find your vault</h1>
        <p className="lead">Connect a wallet and KAIGEN looks for a vault on your account. Or type a vault name. Everything here is read only.</p>
      </header>

      <p className="callout reading" data-tone="warning" role="note">
        <strong>{CAVEATS[0]}</strong>
        <span>{CAVEATS.slice(1).join(" ")}</span>
      </p>

      <section className="section" aria-labelledby="connect-h">
        <div className="panel reading">
          <span className="caption">Step 1 of 2</span>
          <h2 id="connect-h">Connect your wallet</h2>
          {wallet.account ? (
            <p className="body" role="status">
              Connected as <span className="mono">{wallet.account}</span>.
            </p>
          ) : (
            <>
              <p className="body">The wallet stays in your control: this site never sees a key. You can also skip this and look a vault up by name below.</p>
              <div className="actions">
                <button type="button" className="btn" onClick={wallet.connect} disabled={wallet.busy}>
                  {wallet.busy ? "Connecting..." : "Connect wallet"}
                </button>
              </div>
              <WalletError id="start-wallet-error" />
            </>
          )}
        </div>
      </section>

      <section className="section" aria-labelledby="find-h">
        <div className="panel reading">
          <span className="caption">Step 2 of 2</span>
          <h2 id="find-h">Open a vault</h2>

          {step.kind === "connect" && <p className="body">Connect a wallet and KAIGEN will look for a vault on that account, or type a vault name below.</p>}
          {step.kind === "checking" && (
            <p className="body" role="status">
              Looking for a vault at <span className="mono">{step.account}</span>...
            </p>
          )}
          {step.kind === "open-vault" && (
            <p className="body" role="status">
              Found <span className="mono">{step.account}</span>. Opening it...
            </p>
          )}
          {step.kind === "choose" && (
            <div className="stack" role="status">
              <p className="body">
                No vault was found on{" "}
                {candidates.map((c, i) => (
                  <span key={c}>
                    {i > 0 && " or "}
                    <span className="mono">{c}</span>
                  </span>
                ))}
                . There is no index of accounts, so a vault with another name has to be typed below.
              </p>
              {step.unreadable.map((u) => (
                <p key={u.account} className="callout" data-tone="warning">
                  <strong>Could not check {u.account}.</strong>
                  <span>{u.message} This does not mean it is not a vault.</span>
                </p>
              ))}
              {step.create.enabled ? (
                <div className="actions">
                  <a className="btn" href="/vault/create">
                    Create a vault
                  </a>
                </div>
              ) : (
                <p className="callout" data-tone="warning">
                  {step.create.reason}
                </p>
              )}
            </div>
          )}

          <form className="stack" onSubmit={lookUp} noValidate>
            <div className="field-group">
              <label className="label" htmlFor="start-vault">
                Look up a vault by name
              </label>
              <input
                id="start-vault"
                className="field"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={NETWORK === "testnet" ? "name.testnet" : "name.near"}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={Boolean(typedError)}
                aria-describedby={typedError ? "start-error" : undefined}
              />
            </div>
            {typedError && (
              <p id="start-error" role="alert" className="callout" data-tone="invalid">
                {typedError}
              </p>
            )}
            <div className="actions">
              <button type="submit" className="btn btn-secondary" disabled={!typed.trim() || looking}>
                {looking ? "Looking..." : "Look up"}
              </button>
              {demo && (
                <a className="btn-text" href={vaultLink(demo)}>
                  Try the demo vault (testnet)
                </a>
              )}
            </div>
          </form>
        </div>
      </section>

      <Walkthrough />
    </div>
  );
}
