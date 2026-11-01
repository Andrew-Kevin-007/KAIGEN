import type { Bounty } from "./near.ts";

/** The shape of `view` in lib/near, so the loader can be tried without a network. */
export type ViewFn = <T>(contract: string, method: string, args?: object, signal?: AbortSignal) => Promise<T>;

export interface BountyPanel {
  bounty: Bounty;
  /** Whether Kizashi can receive USDC yet; null when the bounty has no USDC token to register with. */
  registered: boolean | null;
}

/**
 * What the Bounty page's "in the bounty now" table shows: the bounty, and whether Kizashi is registered with the
 * USDC token. Any failure is thrown, so the page can say what went wrong and offer a retry instead of leaving a
 * row that reads "Loading..." for good.
 */
export async function loadBountyPanel(view: ViewFn, kizashi: string, signal?: AbortSignal): Promise<BountyPanel> {
  const bounty = await view<Bounty>(kizashi, "bounty", {}, signal);
  // The amount is turned into a number with BigInt when it is shown, which throws on anything but whole digits.
  if (!bounty || typeof bounty !== "object" || typeof bounty.near !== "string" || !/^\d+$/.test(bounty.near)) {
    throw new Error("Kizashi returned a bounty this page cannot read.");
  }
  if (!bounty.usdc_token) return { bounty, registered: null };
  const storage = await view<{ total: string } | null>(bounty.usdc_token, "storage_balance_of", { account_id: kizashi }, signal);
  return { bounty, registered: storage !== null };
}
