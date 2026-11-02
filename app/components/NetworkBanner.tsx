import { NETWORK } from "@/lib/network";

/** Shown on every route of a testnet deployment, so no page can be mistaken for production. Nothing on mainnet. */
export function NetworkBanner() {
  if (NETWORK !== "testnet") return null;
  return (
    <div className="container" style={{ paddingTop: "1.25rem", width: "100%" }}>
      <div className="callout reading" data-tone="warning" role="note">
        <strong>Testnet.</strong>
        <span>Everything on this site is test data and test funds. Nothing here means a production omen has broken, and no vault here protects real value.</span>
      </div>
    </div>
  );
}
