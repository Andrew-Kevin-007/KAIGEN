import type { NextConfig } from "next";
import { loadDeployments } from "./lib/deployments-file.ts";
import { COMMON_HEADERS, headerRules } from "./lib/security-headers.ts";

// The Protect page generates and handles a post-quantum admin seed in the browser, so it gets a strict policy and
// its own browsing context. Its policy carries a per-request nonce, so proxy.ts sets that one; the rest, and the
// reasoning, are in lib/security-headers.ts.
const isDev = process.env.NODE_ENV !== "production";

// Which contracts this build talks to: the public part of deployments.json, plus the latest published fire-test
// record (lib/deployments-file.ts). A production build with a setting that is wrong stops here, so a typo cannot
// ship as a site that quietly says "not deployed yet".
const deployments = loadDeployments();
if (deployments.problems.length > 0) {
  const message = `KAIGEN deployment settings (${deployments.source}):\n  - ${deployments.problems.join("\n  - ")}`;
  if (!isDev) throw new Error(message);
  console.warn(message);
}

const config: NextConfig = {
  reactStrictMode: true,
  env: deployments.text ? { NEXT_PUBLIC_DEPLOYMENTS: deployments.text } : {},
  async headers() {
    // KAIGEN_CSP=off is for diagnosing a blocked request in development only.
    if (process.env.KAIGEN_CSP === "off") return [{ source: "/(.*)", headers: COMMON_HEADERS }];
    return headerRules(isDev);
  },
};

export default config;
