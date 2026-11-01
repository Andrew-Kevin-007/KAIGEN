"use client";

import { useWallet } from "@/lib/wallet";

/**
 * Why the last connect or disconnect failed, in the page beside its Connect wallet button. Give the button
 * `aria-describedby` with the same `id`. It is not a live region: the Nav shows the same error as an alert, so it
 * is announced once, and this copy is the one a person reads where they pressed the button.
 */
export function WalletError({ id }: { id: string }) {
  const { error } = useWallet();
  return error ? (
    <span id={id} className="hint error">
      {error}
    </span>
  ) : null;
}
