import { NextResponse, type NextRequest } from "next/server";
import { migrateCsp, newNonce } from "./lib/security-headers.ts";

// Gives /migrate a script policy with a nonce chosen for this request. Next reads the nonce back out of the
// request's Content-Security-Policy header and puts it on its own inline scripts, so 'unsafe-inline' is not needed.
// The page is rendered per request for the same reason (see app/migrate/page.tsx).
export function proxy(request: NextRequest) {
  // KAIGEN_CSP=off is for diagnosing a blocked request in development only.
  if (process.env.KAIGEN_CSP === "off") return NextResponse.next();
  const csp = migrateCsp(newNonce(), process.env.NODE_ENV !== "production");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = { matcher: "/migrate" };
