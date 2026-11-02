// Server-side half of the bounty top-up: turns "send X of asset A from any chain" into a 1Click quote
// whose output is USDC delivered to Kizashi on NEAR. Runs only in route handlers, because the 1Click API
// needs a JWT and that must never reach the browser.
import { OneClickService, OpenAPI, QuoteRequest, type TokenResponse } from "@defuse-protocol/one-click-sdk-typescript";
import { DEPLOYMENTS } from "./config.ts";
import { refundAddressError } from "./refund.ts";
import { TopupError, assertTopupSafe, guardConfigFromEnv } from "./topup-guard.ts";

export { TopupError };

const TOKENS_TTL_MS = 5 * 60_000;
/** Bitcoin needs about an hour for a deposit to confirm, so the refund window must be longer. */
const DEADLINE_MS = 2 * 60 * 60_000;
const SLIPPAGE_BPS = 100;
const AMOUNT = /^[1-9]\d{0,37}$/;

let cache: { at: number; tokens: TokenResponse[] } | null = null;

/** True when this deployment has a 1Click token. Without one the API still works, with a 0.2% fee. */
export const hasJwt = () => Boolean(process.env.ONECLICK_JWT);

function configure() {
  OpenAPI.BASE = process.env.ONECLICK_BASE_URL ?? "https://1click.chaindefuser.com";
  // The hackathon rules say a token is optional: without one, 1Click charges a 0.2% fee.
  OpenAPI.TOKEN = process.env.ONECLICK_JWT || undefined;
}

function recipient(): string {
  const id = DEPLOYMENTS.kizashi;
  if (!id) throw new TopupError("Kizashi is not deployed yet, so there is nowhere to send a top-up.", 503);
  return id;
}

/** The public token list, cached. Needs no JWT. */
export async function tokens(): Promise<TokenResponse[]> {
  if (cache && Date.now() - cache.at < TOKENS_TTL_MS) return cache.tokens;
  OpenAPI.BASE = process.env.ONECLICK_BASE_URL ?? "https://1click.chaindefuser.com";
  const list = await OneClickService.getTokens();
  cache = { at: Date.now(), tokens: list };
  return list;
}

/** USDC on NEAR is the bounty's output asset; found by symbol and chain, never hard-coded. */
export function usdcOnNear(list: TokenResponse[]): TokenResponse {
  const t = list.find((x) => x.symbol === "USDC" && x.blockchain === "near");
  if (!t) throw new TopupError("The 1Click token list has no USDC on NEAR right now.", 502);
  return t;
}

export interface QuoteInput {
  originAsset: string;
  /** Smallest units of the origin asset, as an integer string. */
  amount: string;
  /** Where a failed or partial swap is refunded, on the origin chain. */
  refundTo: string;
  /** `true` previews the price; `false` reserves a deposit address. */
  dry: boolean;
}

export async function quote(input: QuoteInput) {
  configure();
  const to = recipient();
  const list = await tokens();

  const origin = list.find((t) => t.assetId === input.originAsset);
  if (!origin) throw new TopupError("That asset is not supported.");
  if (!AMOUNT.test(input.amount)) throw new TopupError("The amount must be a positive whole number of the asset's smallest unit.");
  const refundTo = input.refundTo.trim();
  const refundProblem = refundAddressError(origin.blockchain, refundTo);
  if (refundProblem) throw new TopupError(refundProblem);

  // Fixed server-side: a top-up can only ever deliver USDC to Kizashi.
  const destinationAsset = usdcOnNear(list).assetId;
  // A reserved deposit address is real money in flight and cannot be recovered once Kizashi's keys are gone, so
  // it is only given after Kizashi has been checked on-chain. A preview reserves nothing.
  if (!input.dry) await assertTopupSafe(guardConfigFromEnv(), destinationAsset);

  const request: QuoteRequest = {
    dry: input.dry,
    swapType: QuoteRequest.swapType.EXACT_INPUT,
    slippageTolerance: SLIPPAGE_BPS,
    originAsset: input.originAsset,
    depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
    destinationAsset,
    amount: input.amount,
    refundTo,
    refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
    recipient: to,
    recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
    deadline: new Date(Date.now() + DEADLINE_MS).toISOString(),
  };
  return OneClickService.getQuote(request);
}

export async function status(depositAddress: string, depositMemo?: string) {
  configure();
  if (!/^[\w:.\-]{3,200}$/.test(depositAddress)) throw new TopupError("That is not a deposit address.");
  return OneClickService.getExecutionStatus(depositAddress, depositMemo);
}
