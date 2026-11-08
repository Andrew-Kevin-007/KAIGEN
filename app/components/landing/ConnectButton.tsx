"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useWallet } from "@/lib/wallet";

interface Props {
  className: string;
  label?: string;
  connectedLabel?: string;
  /** Wraps the label for buttons whose markup has more inside than text (the closing call to action). */
  render?: (label: string) => ReactNode;
}

/**
 * The landing's one way into the app. Not connected: opens the wallet picker, and once an account comes back goes to
 * /start. Already connected (a restored session): a plain link to /start. /start is in another root layout, so the
 * hop is a full page load, which is also what keeps the landing's stylesheet out of the app.
 */
export function ConnectButton({ className, label = "Connect wallet", connectedLabel = "Continue", render }: Props) {
  const { account, busy, error, connect } = useWallet();
  const asked = useRef(false);

  useEffect(() => {
    if (asked.current && account) window.location.assign("/start");
  }, [account]);

  if (account) {
    return (
      <a className={className} href="/start">
        {render ? render(connectedLabel) : connectedLabel}
      </a>
    );
  }
  const text = busy ? "Connecting..." : label;
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={busy}
        aria-describedby={error ? "landing-wallet-error" : undefined}
        onClick={() => {
          asked.current = true;
          void connect();
        }}
      >
        {render ? render(text) : text}
      </button>
      {error && (
        <p id="landing-wallet-error" role="alert" style={{ color: "#C42B2B", fontSize: 14, lineHeight: "20px", marginTop: 8, maxWidth: 320 }}>
          {error}
        </p>
      )}
    </>
  );
}
