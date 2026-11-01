/** What a control must look like for the question "can focus go back to it?". A subset of HTMLElement. */
export interface Opener {
  isConnected: boolean;
  disabled?: boolean;
}

/**
 * Where focus goes when a dialog closes.
 *  - "focus": back to the control that opened it.
 *  - "wait": the control is disabled right now (confirming often starts the work that disables it), and focus() on a
 *    disabled control does nothing, so park focus somewhere safe and hand it back once the control is enabled again.
 *  - "fallback": there is no control to go back to (none had focus, or it has left the page).
 */
export type FocusPlan = "focus" | "wait" | "fallback";

export function focusPlan(opener: Opener | null | undefined): FocusPlan {
  if (!opener || !opener.isConnected) return "fallback";
  return opener.disabled ? "wait" : "focus";
}
