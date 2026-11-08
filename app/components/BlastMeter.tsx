"use client";

import { useEffect, useState, type FormEvent } from "react";
import { blastFormula, blastRadius, type Blast } from "@/lib/blast";
import { isAccountId } from "@/lib/account";
import { parseAttestation } from "@/lib/cage";
import { errorText } from "@/lib/errors";
import { view, yoctoToNear } from "@/lib/near";

interface TokenRead {
  token: string;
  blast: Blast | null;
  error?: string;
}

async function readToken(vault: string, token: string, delaySecs: number, signal?: AbortSignal): Promise<TokenRead> {
  try {
    const [cap, pending] = await Promise.all([view<unknown>(vault, "token_limit", { token }, signal), view<unknown>(vault, "pending_limit", { token }, signal)]);
    return { token, blast: blastRadius({ cap, pending, delaySecs }) };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { token, blast: null, error: errorText(e, "could not be read") };
  }
}

/**
 * "The worst this agent can lose in 24 hours", per token, from LOSS-BOUND.md section 1 (C plus P). Inputs come from the
 * vault's own attest() and token_limit/pending_limit views. If a token's inputs are missing it shows nothing for that
 * token, and if NEAR's are missing it shows nothing at all.
 */
export function BlastMeter({ account, attest, queueTokens }: { account: string; attest: unknown; queueTokens: string[] }) {
  const parsed = parseAttestation(attest === null || attest === undefined ? { status: "absent" } : { status: "present", raw: attest });
  const [extra, setExtra] = useState<string[]>([]);
  const [reads, setReads] = useState<TokenRead[]>([]);
  const [input, setInput] = useState("");
  const [problem, setProblem] = useState("");
  const delay = parsed.state === "ok" ? parsed.a.config.delay_secs : null;
  const tokens = [...new Set([...queueTokens, ...extra])];
  const key = tokens.join("|");

  useEffect(() => {
    if (delay === null || tokens.length === 0) {
      setReads([]);
      return;
    }
    const ctrl = new AbortController();
    Promise.all(tokens.map((t) => readToken(account, t, delay, ctrl.signal))).then(setReads, () => undefined);
    return () => ctrl.abort();
    // `key` stands for the token list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, delay, key]);

  if (parsed.state !== "ok") return null;
  const near = blastRadius({ cap: parsed.a.config.daily_limit, pending: parsed.a.config.pending_limit, delaySecs: parsed.a.config.delay_secs });
  if (!near) return null;
  const fmtNear = (v: bigint) => `${yoctoToNear(v.toString(), 2)} NEAR`;

  function addToken(e: FormEvent) {
    e.preventDefault();
    const t = input.trim().toLowerCase();
    if (!isAccountId(t)) return setProblem("That is not a valid token contract name.");
    setProblem("");
    setExtra((x) => (x.includes(t) ? x : [...x, t]));
    setInput("");
  }

  return (
    <section className="panel" aria-labelledby="blast-h">
      <h2 id="blast-h">The worst this agent can lose</h2>
      <p className="body">If an agent key is stolen, this is the most it can take in any 24 hours, token by token. It is a bound the contract enforces, not a forecast.</p>
      <div className="br-figure">
        <span className="figure num">{fmtNear(near.worst)}</span>
        <span className="small body">in any 24 hours</span>
      </div>
      {near.pendingTimes === 2 && (
        <p className="callout" data-tone="warning">
          <strong>Short delay.</strong>
          <span>This vault&apos;s withdrawal delay is under 24 hours ({near.delaySecs} s), so two pending limits can get through one window. Only drill builds allow that.</span>
        </p>
      )}
      {reads.map((r) => (
        <div key={r.token} className="stack-sm">
          {r.blast ? (
            <div className="br-figure">
              <span className="figure num">{r.blast.worst.toString()}</span>
              <span className="small body">
                units of <span className="mono">{r.token}</span> ({blastFormula(r.blast, (v) => v.toString())})
              </span>
            </div>
          ) : (
            <p className="small body">
              <span className="mono">{r.token}</span>: no bound shown, its limits could not be read{r.error ? ` (${r.error})` : ""}.
            </p>
          )}
        </div>
      ))}
      <details className="br-note">
        <summary>How this is worked out</summary>
        <div className="stack-sm" style={{ marginTop: "0.75rem" }}>
          <p className="body small">
            For each token T the most that can leave in any 24 hour window is <strong>C + P</strong> (LOSS-BOUND.md section 1): C is the 24 hour cap the vault lets agent keys send directly, P is the pending limit on withdrawals
            that wait out the delay. With a delay under 24 hours it is C + 2P.
          </p>
          <p className="body small">
            Used here, read from this vault&apos;s attest(): C = {fmtNear(near.cap)} (<span className="mono">config.daily_limit</span>), P = {fmtNear(near.pending)} (<span className="mono">config.pending_limit</span>), delay ={" "}
            {near.delaySecs} s. So {blastFormula(near, fmtNear)}.
          </p>
          <p className="body small">
            This holds only while the cage is intact (check it on the X-ray page), assumes the admin cancels a queued withdrawal inside the delay if it is not wanted, and is per 24 hours: a slow drain repeated every day is not
            limited by it. NEP-141 tokens are listed only when the vault names them, so add a token contract below to read its limits.
          </p>
        </div>
      </details>
      <form className="inline-form" onSubmit={addToken} noValidate>
        <div className="field-group">
          <label className="label" htmlFor="blast-token">
            Check another token
          </label>
          <input id="blast-token" className="field" value={input} onChange={(e) => setInput(e.target.value)} placeholder="token contract, e.g. usdc.example.testnet" spellCheck={false} autoCapitalize="none" autoCorrect="off" />
        </div>
        <button type="submit" className="btn btn-secondary" disabled={!input.trim()}>
          Add
        </button>
      </form>
      {problem && (
        <p role="alert" className="callout" data-tone="invalid">
          {problem}
        </p>
      )}
    </section>
  );
}
