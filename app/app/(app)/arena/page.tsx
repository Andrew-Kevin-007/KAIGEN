import type { Metadata } from "next";
import { ArenaView } from "@/components/ArenaView";

export const metadata: Metadata = {
  title: "Arena | KAIGEN",
  description: "Bring your own model and key, watch it read an invoice with a prompt injection, and see the vault rules stop it. A simulation of the vault rules, not the chain.",
};

export default function ArenaPage() {
  return <ArenaView />;
}
