// Response headers, kept free of Next imports so next.config.ts and proxy.ts share one definition and a test can read it.

export interface Header {
  key: string;
  value: string;
}
export interface HeaderRule {
  source: string;
  headers: Header[];
}

export const COMMON_HEADERS: Header[] = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

// The key page keeps its own browsing context group and refuses to be loaded by other origins, so no other open
// window can reach its document (window.opener, shared process) even if that window runs hostile script.
const ISOLATION_HEADERS: Header[] = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];

/** A fresh value for every request: it is what lets Next's own inline scripts run while an injected one cannot. */
export function newNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

/**
 * The /migrate policy. Scripts run only if they are served from this origin or carry this request's nonce, and the
 * page may open no connection at all: it makes no requests (the key is made, encrypted and checked locally).
 * Inline styles stay allowed because React sets style attributes, which a nonce cannot cover.
 */
export function migrateCsp(nonce: string, isDev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    // Development needs the hot-reload socket; production gets none.
    isDev ? "connect-src 'self' ws://localhost:* http://localhost:*" : "connect-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

// Wallet pickers fetch their wallet list from public CDNs and load each wallet's own code, from hosts that
// change over time, so a list of allowed hosts would always be out of date. Pages that never hold a secret
// get an HTTPS-only policy.
export function openCsp(isDev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' https:${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline' https:",
    "img-src 'self' data: blob: https:",
    `connect-src 'self' https:${isDev ? " ws://localhost:* http://localhost:*" : ""}`,
    "frame-src https:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join("; ");
}

/**
 * Rules for next.config.ts. The /migrate policy is not here: it carries a per-request nonce, so proxy.ts sets it.
 * The open rule excludes /migrate rather than relying on override order.
 */
export function headerRules(isDev: boolean): HeaderRule[] {
  return [
    { source: "/migrate", headers: [...ISOLATION_HEADERS, ...COMMON_HEADERS] },
    { source: "/((?!migrate).*)", headers: [{ key: "Content-Security-Policy", value: openCsp(isDev) }, ...COMMON_HEADERS] },
  ];
}
