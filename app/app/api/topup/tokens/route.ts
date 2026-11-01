import { NextResponse } from "next/server";
import { TopupError, tokens, usdcOnNear } from "@/lib/topup";

/** The assets a bounty can be funded from, plus what it turns into. Public data, no token needed. */
export async function GET() {
  try {
    const list = await tokens();
    return NextResponse.json({
      destination: usdcOnNear(list).symbol,
      tokens: list.map((t) => ({ assetId: t.assetId, symbol: t.symbol, blockchain: t.blockchain, decimals: t.decimals, price: t.price })),
    });
  } catch (e) {
    const status = e instanceof TopupError ? e.status : 502;
    return NextResponse.json({ error: e instanceof TopupError ? e.message : "The 1Click token list is unavailable." }, { status });
  }
}
