import type { Metadata, Viewport } from "next";
import { LandingProviders } from "@/components/landing/LandingProviders";
import { Figtree } from "next/font/google";
import "./landing.css";

// Figtree from Google Fonts, served from our own host at build time: it replaces the template's own typeface.
const figtree = Figtree({ subsets: ["latin"], display: "swap", variable: "--font-figtree" });

// A root layout of its own: the landing uses the Family template's global stylesheet (resets on *, html and body), and
// the app uses its own. Two root layouts are two separate documents, so neither stylesheet can reach the other's pages.
const description = "When an omen key breaks, your NEAR vault locks itself into post-quantum-only mode. No oracle, no admin, nobody online.";

export const metadata: Metadata = {
  title: "KAIGEN",
  description,
  openGraph: { title: "KAIGEN", description, siteName: "KAIGEN", type: "website" },
  twitter: { card: "summary", title: "KAIGEN", description },
};

// No maximumScale: pinch zoom stays available.
export const viewport: Viewport = { themeColor: "#FFFFFF", width: "device-width", initialScale: 1 };

export default function LandingLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={figtree.variable}>
      <body>
        <LandingProviders>{children}</LandingProviders>
      </body>
    </html>
  );
}
