import { connection } from "next/server";
import { MigrateClient } from "./MigrateClient";

// Rendered for each request, never prebuilt: this page's script policy carries a nonce chosen per request (see
// proxy.ts), and Next can only put that nonce on its own scripts while it renders the page.
export default async function MigratePage() {
  await connection();
  return <MigrateClient />;
}
