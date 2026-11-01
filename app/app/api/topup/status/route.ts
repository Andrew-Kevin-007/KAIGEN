import { NextResponse, type NextRequest } from "next/server";
import { TRUSTED_HOPS, clientIp, statusLimiter } from "@/lib/rate-limit";
import { TopupError, status } from "@/lib/topup";

export async function GET(request: NextRequest) {
  const gate = statusLimiter.check(clientIp(request.headers, TRUSTED_HOPS));
  if (!gate.ok) return NextResponse.json({ error: "Too many requests. Wait a moment and try again." }, { status: 429, headers: { "retry-after": String(gate.retryAfterSec) } });
  try {
    const address = request.nextUrl.searchParams.get("depositAddress");
    if (!address) throw new TopupError("depositAddress is required.");
    const memo = request.nextUrl.searchParams.get("depositMemo") ?? undefined;
    const s = await status(address, memo);
    return NextResponse.json({ status: s.status, updatedAt: s.updatedAt });
  } catch (e) {
    if (e instanceof TopupError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("topup status failed", e);
    return NextResponse.json({ error: "Could not read the swap status." }, { status: 502 });
  }
}
