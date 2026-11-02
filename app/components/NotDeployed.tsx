import type { ReactNode } from "react";

/** The one wording for "this contract is not deployed yet", so a page without an address says so instead of showing made-up data. */
export function NotDeployed({ children }: { children: ReactNode }) {
  return (
    <div className="callout reading" data-tone="warning">
      <strong>Not deployed yet.</strong>
      <span>{children}</span>
    </div>
  );
}
