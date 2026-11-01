"use client";

import { useEffect, useMemo, useState } from "react";
import { WalletError } from "@/components/WalletError";
import { describedBy } from "@/lib/aria";
import { loadBountyPanel, type BountyPanel } from "@/lib/bounty";
import { errorText } from "@/lib/errors";
import { KIZASHI_ID, view, yoctoToNear } from "@/lib/near";
import { refundAddressError } from "@/lib/refund";
import { toUnits } from "@/lib/units";
import { useWallet } from "@/lib/wallet";

interface Token {
  assetId: string;
  symbol: string;
  blockchain: string;
  decimals: number;
  price: number;
}

interface QuoteView {
  dry: boolean;
  depositAddress: string | null;
  depositMemo: string | null;
  amountIn: string;
  amountInUsd: string;
  amountOut: string;
  amountOutUsd: string;
  minAmountOut: string;
  timeEstimate: number;
  deadline: string | null;
  feeNote: string | null;
}

const NEEDS_MESSAGE: Record<string, string> = {
  PENDING_DEPOSIT: "Waiting for your deposit.",
  KNOWN_DEPOSIT_TX: "Deposit seen, confirming.",
  INCOMPLETE_DEPOSIT: "The deposit was smaller than the quote. It will be refunded if the rest does not arrive.",
  PROCESSING: "Swapping.",
  SUCCESS: "Done. The USDC is in the bounty.",
  REFUNDED: "The swap did not complete and your deposit was refunded.",
  FAILED: "The swap failed.",
};
const TERMINAL = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

type Panel = { status: "loading" } | { status: "error"; message: string } | ({ status: "ready" } & BountyPanel);

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

export default function BountyPage() {
  const wallet = useWallet();
  const [panel, setPanel] = useState<Panel>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [tokensError, setTokensError] = useState("");
  const [chain, setChain] = useState("");
  const [assetId, setAssetId] = useState("");
  const [amount, setAmount] = useState("");
  const [refundTo, setRefundTo] = useState("");
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [swap, setSwap] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [regState, setRegState] = useState<"idle" | "sending" | "sent">("idle");

  // What the bounty holds, and whether Kizashi can receive USDC at all yet. A failure is shown with a way to try
  // again; the rest of the page still works without this panel.
  useEffect(() => {
    if (!KIZASHI_ID) return;
    const ctrl = new AbortController();
    // A refresh after registering keeps the figures on screen; a retry after an error goes back to "Loading...".
    setPanel((p) => (p.status === "error" ? { status: "loading" } : p));
    loadBountyPanel(view, KIZASHI_ID, ctrl.signal)
      .then((loaded) => setPanel({ status: "ready", ...loaded }))
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setPanel({ status: "error", message: errorText(e, "The bounty could not be read.") });
      });
    return () => ctrl.abort();
  }, [regState, attempt]);

  useEffect(() => {
    api<{ tokens: Token[] }>("/api/topup/tokens")
      .then((r) => setTokens(r.tokens))
      .catch((e: Error) => setTokensError(e.message));
  }, []);

  const chains = useMemo(() => [...new Set(tokens.map((t) => t.blockchain))].sort(), [tokens]);
  const assets = useMemo(() => tokens.filter((t) => t.blockchain === chain).sort((a, b) => a.symbol.localeCompare(b.symbol)), [tokens, chain]);
  const token = tokens.find((t) => t.assetId === assetId);
  const units = token ? toUnits(amount, token.decimals) : null;
  const refundProblem = token ? refundAddressError(token.blockchain, refundTo) : null;
  const ready = panel.status === "ready" ? panel : null;
  const amountBad = Boolean(amount) && Boolean(token) && !units;
  const refundBad = Boolean(refundTo.trim()) && refundProblem !== null;

  async function ask(dry: boolean) {
    if (!token || !units) return;
    setBusy(true);
    setError("");
    setSwap("");
    try {
      const q = await api<QuoteView>("/api/topup/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ originAsset: token.assetId, amount: units, refundTo, dry }),
      });
      setQuote(q);
    } catch (e) {
      setError(errorText(e, "The quote could not be fetched."));
    } finally {
      setBusy(false);
    }
  }

  // Follow the swap once there is a deposit address.
  const deposit = quote && !quote.dry ? quote.depositAddress : null;
  useEffect(() => {
    if (!deposit) return;
    let live = true;
    const memo = quote?.depositMemo ? `&depositMemo=${encodeURIComponent(quote.depositMemo)}` : "";
    const poll = async () => {
      try {
        const s = await api<{ status: string }>(`/api/topup/status?depositAddress=${encodeURIComponent(deposit)}${memo}`);
        if (live) setSwap(s.status);
        return TERMINAL.has(s.status);
      } catch {
        return false;
      }
    };
    poll();
    const id = setInterval(async () => {
      if (await poll()) clearInterval(id);
    }, 10_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [deposit, quote?.depositMemo]);

  async function register() {
    setRegState("sending");
    setError("");
    try {
      // 0.02 NEAR pays the token's one-time storage deposit for Kizashi; the token refunds any excess to it.
      await wallet.call({ receiver: KIZASHI_ID, method: "register_usdc", gasTgas: 30, deposit: "20000000000000000000000" });
      setRegState("sent");
    } catch (e) {
      setRegState("idle");
      setError(errorText(e, "The wallet did not complete the request."));
    }
  }

  return (
    <div className="container page">
      <header className="page-head reading">
        <h1>Add to the bounty</h1>
        <p className="lead">
          Whoever proves an omen key broke is paid from this bounty. Send any supported asset from any chain; it is swapped into USDC and delivered to Kizashi.
        </p>
      </header>

      {!KIZASHI_ID ? (
        <div className="callout reading" data-tone="warning">
          <strong>Not deployed yet.</strong>
          <span>Kizashi is not deployed yet, so there is no bounty to add to.</span>
        </div>
      ) : (
        <section aria-labelledby="now-h" className="stack">
          <h2 id="now-h">In the bounty now</h2>
          {panel.status === "error" ? (
            <div className="callout reading" data-tone="invalid" role="alert">
              <strong>Could not read the bounty.</strong>
              <span>{panel.message}</span>
              <div className="actions" style={{ marginTop: "0.75rem" }}>
                <button type="button" className="btn btn-compact" onClick={() => setAttempt((n) => n + 1)}>
                  Try again
                </button>
              </div>
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col" className="num-col">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td data-label="Item">NEAR in the bounty</td>
                  <td data-label="Amount" className="num-col">
                    {ready ? `${yoctoToNear(ready.bounty.near, 2)} NEAR` : "Loading..."}
                  </td>
                </tr>
                {ready?.bounty.usdc_token && (
                  <tr>
                    <td data-label="Item">USDC receiving</td>
                    <td data-label="Amount" className="num-col">
                      {ready.registered ? <span className="chip" data-tone="valid">Ready</span> : <span className="chip" data-tone="warning">Not set up yet</span>}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </section>
      )}

      {ready?.bounty.usdc_token && ready.registered === false && (
        <div className="panel reading" style={{ marginTop: "2rem" }}>
          <h2>One setup step</h2>
          <p className="body">
            A token only accepts transfers to a registered account, so Kizashi has to be registered with USDC once before it can receive any. Anyone can pay the 0.02 NEAR it costs.
          </p>
          <div className="actions">
            {wallet.account ? (
              <button type="button" className="btn" onClick={register} disabled={regState === "sending"}>
                {regState === "sending" ? "Waiting for your wallet..." : "Register Kizashi for USDC"}
              </button>
            ) : (
              <button type="button" className="btn" onClick={wallet.connect} disabled={wallet.busy} aria-describedby={describedBy(wallet.error && "bounty-wallet-error")}>
                Connect wallet
              </button>
            )}
          </div>
          <WalletError id="bounty-wallet-error" />
          {regState === "sent" && (
            <p role="status" className="callout" data-tone="valid">
              Sent. This updates in a moment.
            </p>
          )}
        </div>
      )}

      <section className="section reading" aria-labelledby="send-h">
        <h2 id="send-h">Send</h2>
        {tokensError && (
          <p className="callout" data-tone="invalid">
            {tokensError}
          </p>
        )}
        <div className="stack">
          <div className="field-group">
            <label className="label" htmlFor="chain">
              Chain
            </label>
            <select
              id="chain"
              className="field"
              value={chain}
              onChange={(e) => {
                setChain(e.target.value);
                setAssetId("");
                setQuote(null);
              }}
              disabled={chains.length === 0}
            >
              <option value="">Choose a chain</option>
              {chains.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div className="field-group">
            <label className="label" htmlFor="asset">
              Asset
            </label>
            <select
              id="asset"
              className="field"
              value={assetId}
              onChange={(e) => {
                setAssetId(e.target.value);
                setQuote(null);
              }}
              disabled={!chain}
            >
              <option value="">Choose an asset</option>
              {assets.map((t) => (
                <option key={t.assetId} value={t.assetId}>
                  {t.symbol}
                </option>
              ))}
            </select>
          </div>

          <div className="field-group">
            <label className="label" htmlFor="amount">
              Amount
            </label>
            <input id="amount" className="field num" inputMode="decimal" value={amount} onChange={(e) => (setAmount(e.target.value), setQuote(null))} placeholder="0.0" disabled={!token} aria-invalid={amountBad} aria-describedby={describedBy(amountBad && "amount-error")} />
            {amountBad && token && (
              <span id="amount-error" className="hint error">
                Enter a positive number with at most {token.decimals} decimals.
              </span>
            )}
          </div>

          <div className="field-group">
            <label className="label" htmlFor="refund">
              Refund address
            </label>
            <input
              id="refund"
              className="field"
              value={refundTo}
              onChange={(e) => (setRefundTo(e.target.value), setQuote(null))}
              placeholder={`Your address on ${chain || "that chain"}`}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={!token}
              aria-invalid={refundBad}
              aria-describedby={describedBy(refundBad && "refund-error", "refund-hint")}
            />
            {refundBad && (
              <span id="refund-error" className="hint error">
                {refundProblem}
              </span>
            )}
            <span id="refund-hint" className="hint">
              If the swap cannot finish, this is where your deposit comes back. Double-check it.
            </span>
          </div>

          <div className="actions">
            <button type="button" className="btn" onClick={() => ask(true)} disabled={busy || !units || refundProblem !== null}>
              {busy ? "Asking..." : "Preview"}
            </button>
          </div>
        </div>
      </section>

      {error && (
        <div className="reading" style={{ marginTop: "1.25rem" }}>
          <p role="alert" className="callout" data-tone="invalid">
            {error}
          </p>
        </div>
      )}

      {quote && (
        <section className="panel reading" style={{ marginTop: "2rem" }} aria-live="polite" aria-labelledby="quote-h">
          <h2 id="quote-h">{quote.dry ? "Preview" : "Your deposit address"}</h2>
          <p className="body">
            You send {quote.amountIn} {token?.symbol} (about ${quote.amountInUsd}). The bounty receives about {quote.amountOut} USDC (about ${quote.amountOutUsd}), at least{" "}
            {quote.minAmountOut} in the smallest unit, in around {quote.timeEstimate} seconds.
          </p>
          {quote.feeNote && <p className="small body">{quote.feeNote}</p>}
          {quote.dry ? (
            <div className="actions">
              <button type="button" className="btn" onClick={() => ask(false)} disabled={busy}>
                {busy ? "Reserving..." : "Get a deposit address"}
              </button>
            </div>
          ) : (
            <>
              <div className="field-group">
                <span className="label">
                  Send {quote.amountIn} {token?.symbol} on {chain} to
                </span>
                <p className="mono">{quote.depositAddress}</p>
              </div>
              {quote.depositMemo && (
                <div className="field-group">
                  <span className="label">Include this memo, or the deposit will not be recognised</span>
                  <p className="mono">{quote.depositMemo}</p>
                </div>
              )}
              {quote.deadline && <p className="small body">Send before {new Date(quote.deadline).toLocaleString()}. After that, refunds begin.</p>}
              <p role="status" className="callout" data-tone={swap === "SUCCESS" ? "valid" : swap === "FAILED" || swap === "REFUNDED" ? "invalid" : undefined}>
                {swap ? (NEEDS_MESSAGE[swap] ?? swap) : "Waiting for your deposit."}
              </p>
            </>
          )}
        </section>
      )}
    </div>
  );
}
