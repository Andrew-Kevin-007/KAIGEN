import { DEPLOYMENTS } from "./config.ts";

export type Network = "mainnet" | "testnet";

/** What this deployment is set up for (the `network` of the deployments file). Anything but an explicit "testnet" means mainnet. */
export const NETWORK: Network = DEPLOYMENTS.network;

export function networkOfChainId(chainId: unknown): Network | null {
  return chainId === "mainnet" || chainId === "testnet" ? chainId : null;
}

/** Null when the RPC's chain id is the network the page is set up for; otherwise a message that is safe to show. */
export function networkProblem(expected: Network, chainId: unknown): string | null {
  const actual = networkOfChainId(chainId);
  if (actual === expected) return null;
  if (expected === "mainnet" && actual === "testnet") {
    return "This page reads mainnet, but its RPC is a testnet node. Production data is never shown from a testnet RPC.";
  }
  return `This page reads ${expected}, but its RPC reports ${actual ?? "an unknown network"}. Nothing is shown until they match.`;
}
