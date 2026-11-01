import type { Metadata, Viewport } from "next";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { WalletProvider } from "@/lib/wallet";
import "./globals.css";

export const metadata: Metadata = {
  title: "KAIGEN",
  description: "When an omen key breaks, your NEAR vault locks itself into post-quantum-only mode. No oracle, no admin, nobody online.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletProvider>
          <Nav />
          <main>{children}</main>
        </WalletProvider>
        <Footer />
      </body>
    </html>
  );
}
