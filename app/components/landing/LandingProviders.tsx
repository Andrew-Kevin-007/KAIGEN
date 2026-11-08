"use client";

import { MotionConfig } from "framer-motion";
import type { ReactNode } from "react";
import { WalletProvider } from "@/lib/wallet";

// The landing has the same wallet session as the app (the wallet library restores it from the browser on every load),
// and honours prefers-reduced-motion for every framer-motion animation on the page.
export function LandingProviders({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <WalletProvider>{children}</WalletProvider>
    </MotionConfig>
  );
}
