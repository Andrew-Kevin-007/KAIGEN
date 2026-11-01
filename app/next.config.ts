import type { NextConfig } from "next";
import { COMMON_HEADERS, headerRules } from "./lib/security-headers.ts";

// The Protect page generates and handles a post-quantum admin seed in the browser, so it gets a strict policy and
// its own browsing context. Its policy carries a per-request nonce, so proxy.ts sets that one; the rest, and the
// reasoning, are in lib/security-headers.ts.
const isDev = process.env.NODE_ENV !== "production";

const config: NextConfig = {
  reactStrictMode: true,
  async headers() {
    // KAIGEN_CSP=off is for diagnosing a blocked request in development only.
    if (process.env.KAIGEN_CSP === "off") return [{ source: "/(.*)", headers: COMMON_HEADERS }];
    return headerRules(isDev);
  },
};

export default config;
