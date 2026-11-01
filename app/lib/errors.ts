/**
 * The words to show for something that was thrown. Wallets reject with an Error, a plain string, or an object with
 * a `message`, so all three are read; anything else gets `fallback` instead of "[object Object]".
 */
export function errorText(e: unknown, fallback: string): string {
  if (e instanceof Error) return e.message || fallback;
  if (typeof e === "string") return e || fallback;
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message: unknown }).message;
    if (typeof m === "string" && m) return m;
  }
  return fallback;
}

/**
 * Runs a disconnect and says how it went: "" when it worked, otherwise what to show. It never throws, so a caller
 * that fires it and moves on cannot leave an unhandled rejection with nothing on screen.
 */
export async function disconnectOutcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "";
  } catch (e) {
    return `Could not disconnect: ${errorText(e, "the wallet did not say why.")}`;
  }
}
