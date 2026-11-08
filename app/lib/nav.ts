// The landing page is "/", in its own root layout. The era (omens) page lives at /omens.
export const LINKS = [
  { href: "/start", label: "Start" },
  { href: "/omens", label: "Era" },
  { href: "/vault", label: "Vault" },
  { href: "/bounty", label: "Bounty" },
  { href: "/migrate", label: "Migrate" },
];

const KEY_PAGE = "/migrate";

/**
 * The key page must never share a document with another page. A soft navigation keeps the open document, and with it
 * that page's scripts and policy, so the key page is entered and left by a full page load (a plain anchor).
 */
export const fullLoad = (href: string, current: string | null): boolean => href === KEY_PAGE || current === KEY_PAGE;
