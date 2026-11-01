"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { describedBy } from "@/lib/aria";
import { LINKS, fullLoad } from "@/lib/nav";
import { NETWORK } from "@/lib/network";
import { useWallet } from "@/lib/wallet";

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "/";
const short = (id: string) => (id.length > 18 ? `${id.slice(0, 4)}...${id.slice(-4)}` : id);

interface NavLinkProps {
  href: string;
  current: string | null;
  "aria-current"?: "page";
  children: ReactNode;
}

// A plain anchor when the hop must be a full page load (see lib/nav): the key page never shares a document.
function NavLink({ href, current, children, ...props }: NavLinkProps) {
  return fullLoad(href, current) ? (
    <a href={href} {...props}>
      {children}
    </a>
  ) : (
    <Link href={href} {...props}>
      {children}
    </Link>
  );
}

export function Nav() {
  const path = usePathname();
  const { account, busy, error, connect, disconnect, clearError } = useWallet();
  const [menu, setMenu] = useState(false);
  const [wallet, setWallet] = useState(false);
  const [copied, setCopied] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const walletTrigger = useRef<HTMLButtonElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);

  // Close menus on navigation, on Escape, on a click elsewhere and when focus leaves the header. A wallet error is
  // about the page the person was on, so it goes too.
  useEffect(() => {
    setMenu(false);
    setWallet(false);
    clearError();
  }, [path, clearError]);
  useEffect(() => {
    if (!menu && !wallet) return;
    const close = () => {
      setMenu(false);
      setWallet(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Focus goes back to the button that opened what is closing. On a phone the links vanish with the menu, which
      // would otherwise drop focus onto the page.
      (wallet ? walletTrigger : menuTrigger).current?.focus();
      close();
    };
    const outside = (e: Event) => {
      if (root.current && !root.current.contains(e.target as Node)) close();
    };
    window.addEventListener("keydown", key);
    window.addEventListener("mousedown", outside);
    window.addEventListener("focusin", outside);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("focusin", outside);
    };
  }, [menu, wallet]);

  async function copy() {
    if (!account) return;
    try {
      await navigator.clipboard.writeText(account);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked; the full name is also on screen in the dropdown.
    }
  }

  return (
    <div className="site-header">
      <div className="container" ref={root}>
        <header className="nav-row">
          <a href={SITE} className="wordmark" aria-label="KAIGEN, home">
            KAIGEN
          </a>
          <nav className="nav-links" id="main-nav" aria-label="Main" data-open={menu}>
            {LINKS.map((l) => (
              <NavLink key={l.href} href={l.href} current={path} aria-current={path === l.href ? "page" : undefined}>
                {l.label}
              </NavLink>
            ))}
          </nav>
          <div className="nav-right">
            <span className="chip-net">{NETWORK}</span>
            {/* The key page has a strict security policy that a wallet picker could not run under, and it never needs one. */}
            {path !== "/migrate" &&
              (account ? (
                <>
                  {/* A disclosure, not an ARIA menu: Tab moves through the items, Escape closes and returns here. */}
                  <button
                    ref={walletTrigger}
                    type="button"
                    className="btn btn-secondary btn-compact"
                    aria-expanded={wallet}
                    aria-controls="wallet-panel"
                    aria-label={`Wallet ${account}`}
                    onClick={() => setWallet((v) => !v)}
                  >
                    {short(account)}
                  </button>
                  {wallet && (
                    <div className="dropdown" id="wallet-panel">
                      <p className="meta mono" style={{ padding: "9px 12px", color: "var(--body)" }}>
                        {account}
                      </p>
                      <button type="button" onClick={copy}>
                        {copied ? "Copied" : "Copy address"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setWallet(false);
                          void disconnect();
                        }}
                      >
                        Disconnect
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <button type="button" className="btn btn-compact" onClick={connect} disabled={busy} aria-describedby={describedBy(error && "nav-wallet-error")}>
                  {busy ? "Connecting..." : "Connect wallet"}
                </button>
              ))}
            {path !== "/migrate" && error && (
              <div id="nav-wallet-error" className="nav-error" role="alert">
                <span>{error}</span>
                <button type="button" onClick={clearError}>
                  Dismiss
                </button>
              </div>
            )}
            <button ref={menuTrigger} type="button" className="menu-btn" aria-label="Menu" aria-expanded={menu} aria-controls="main-nav" onClick={() => setMenu((v) => !v)}>
              <span />
            </button>
          </div>
        </header>
      </div>
      <div className="header-rule" />
    </div>
  );
}
