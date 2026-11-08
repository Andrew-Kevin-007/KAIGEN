import { NETWORK } from "@/lib/network";

/** Shown on every route of a testnet deployment, so no page can be mistaken for production. Nothing on mainnet. A slim bar under the navbar: always there, never in the way. */
export function NetworkBanner() {
  if (NETWORK !== "testnet") return null;
  return (
    <div className="notice-bar" role="note">
      <strong>Testnet.</strong> Everything on this site is test data and test funds. Nothing here means a production omen has broken, and no vault here protects real value.
    </div>
  );
}
