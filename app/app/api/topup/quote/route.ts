import { NextResponse, type NextRequest } from "next/server";
import { TRUSTED_HOPS, clientIp, quoteLimiter } from "@/lib/rate-limit";
import { TopupError, hasJwt, quote } from "@/lib/topup";

export async function POST(request: NextRequest) {
  // Each quote costs the server a 1Click call, so one address cannot make them without limit.
  const gate = quoteLimiter.check(clientIp(request.headers, TRUSTED_HOPS));
  if (!gate.ok) return NextResponse.json({ error: "Too many requests. Wait a moment and try again." }, { status: 429, headers: { "retry-after": String(gate.retryAfterSec) } });
  try {
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== "object" || body === null) throw new TopupError("Send a JSON body.");
    const { originAsset, amount, refundTo, dry } = body as Record<string, unknown>;
    if (typeof originAsset !== "string" || typeof amount !== "string" || typeof refundTo !== "string" || typeof dry !== "boolean") {
      throw new TopupError("Expected originAsset, amount and refundTo as strings and dry as a boolean.");
    }
    const q = await quote({ originAsset, amount, refundTo, dry });
    // Only what the page shows. The signature is kept so a dispute can be raised later.
    return NextResponse.json({
      dry,
      // 1Click charges 0.2% when called without a token; say so instead of letting it be a surprise.
      feeNote: hasJwt() ? null : "1Click adds a 0.2% fee for requests made without an access token.",
      depositAddress: q.quote.depositAddress ?? null,
      depositMemo: q.quote.depositMemo ?? null,
      amountIn: q.quote.amountInFormatted,
      amountInUsd: q.quote.amountInUsd,
      amountOut: q.quote.amountOutFormatted,
      amountOutUsd: q.quote.amountOutUsd,
      minAmountOut: q.quote.minAmountOut,
      timeEstimate: q.quote.timeEstimate,
      deadline: q.quote.deadline ?? null,
      correlationId: q.correlationId,
      signature: q.signature,
    });
  } catch (e) {
    if (e instanceof TopupError) return NextResponse.json({ error: e.message }, { status: e.status });
    // The upstream error text can name internals; log it server-side and return a generic message.
    console.error("topup quote failed", e);
    return NextResponse.json({ error: "1Click could not give a quote for that. Try a different amount or asset." }, { status: 502 });
  }
}
