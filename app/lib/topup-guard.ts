// The checks a top-up must pass before the server hands out a deposit address. Funds sent to Kizashi can never
// be recovered once its keys are gone, and a top-up that Kizashi does not count is simply lost, so every check
// fails closed: a refusal, never a guess. Nothing here talks to 1Click.
import { chainId, isEra, view, viewAccount, type Bounty } from "./near.ts";
import { networkProblem, type Network } from "./network.ts";

export class TopupError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface GuardConfig {
  network: Network;
  /** An explicit override for a testnet rehearsal. Without it, top-ups run on mainnet only. */
  allowTestnet: boolean;
  /** Kizashi's account id. */
  recipient: string;
  /** The code hash the owner expects the deployed Kizashi to run. */
  expectedCodeHash: string;
}

export function guardConfigFromEnv(env: Record<string, string | undefined> = process.env): GuardConfig {
  return {
    network: env.NEXT_PUBLIC_NETWORK === "testnet" ? "testnet" : "mainnet",
    allowTestnet: env.TOPUP_ALLOW_TESTNET === "1",
    recipient: env.NEXT_PUBLIC_KIZASHI_ID ?? "",
    expectedCodeHash: env.KIZASHI_CODE_HASH ?? "",
  };
}

const RPC_TIMEOUT_MS = 8_000;
const NO_ACCOUNT = /does not exist while viewing|UNKNOWN_ACCOUNT/;

/** A read that cannot be completed is a refusal, never a pass. */
async function read<T>(what: string, get: (signal: AbortSignal) => Promise<T>): Promise<T> {
  try {
    return await get(AbortSignal.timeout(RPC_TIMEOUT_MS));
  } catch {
    throw new TopupError(`Could not check ${what} on-chain, so no deposit address is given. Try again in a moment.`, 502);
  }
}

/**
 * Throws a TopupError unless: the deployment is on mainnet (or testnet is explicitly allowed) and the RPC really
 * serves that network; the recipient exists and runs the expected code; the asset 1Click would deliver is exactly
 * the USDC Kizashi counts; and the era is not yet Kaigen.
 */
export async function assertTopupSafe(cfg: GuardConfig, destinationAssetId: string): Promise<void> {
  if (cfg.network !== "mainnet" && !cfg.allowTestnet) throw new TopupError("Top-ups are switched off: this deployment is not on mainnet.", 503);
  if (!cfg.recipient) throw new TopupError("Kizashi is not deployed yet, so there is nowhere to send a top-up.", 503);
  if (!cfg.expectedCodeHash) throw new TopupError("Top-ups are switched off until KIZASHI_CODE_HASH is set to the code hash of the deployed Kizashi.", 503);

  const mismatch = networkProblem(cfg.network, await read("the network", (s) => chainId(s)));
  if (mismatch) throw new TopupError(mismatch, 503);

  let account;
  try {
    account = await viewAccount(cfg.recipient, AbortSignal.timeout(RPC_TIMEOUT_MS));
  } catch (e) {
    if (NO_ACCOUNT.test((e as Error).message)) throw new TopupError("The Kizashi account does not exist on this network, so there is nowhere to send a top-up.", 503);
    throw new TopupError("Could not check the Kizashi account on-chain, so no deposit address is given. Try again in a moment.", 502);
  }
  if (account.code_hash !== cfg.expectedCodeHash && account.global_contract_hash !== cfg.expectedCodeHash) {
    throw new TopupError("The account that would receive the top-up is not the Kizashi build this deployment expects.", 503);
  }

  const bounty = await read("Kizashi's USDC token", (s) => view<Bounty>(cfg.recipient, "bounty", {}, s));
  if (!bounty.usdc_token) throw new TopupError("Kizashi has no USDC token configured, so a USDC top-up could not be counted.", 503);
  if (destinationAssetId !== `nep141:${bounty.usdc_token}`) {
    throw new TopupError("The USDC that 1Click would deliver is not the USDC Kizashi counts, so the top-up would be lost.", 503);
  }

  const era = await read("Kizashi's era", (s) => view<unknown>(cfg.recipient, "era", {}, s));
  if (!isEra(era)) throw new TopupError("Kizashi returned an era this page does not recognise, so no deposit address is given.", 502);
  if (era === "Kaigen") throw new TopupError("The era is Kaigen, so Kizashi is no longer taking top-ups.", 409);
}
