export const LINKS = [
  { href: "/", label: "Era" },
  { href: "/migrate", label: "Migrate" },
  { href: "/vault", label: "Vault" },
  { href: "/bounty", label: "Bounty" },
];

const KEY_PAGE = "/migrate";

/**
 * The key page must never share a document with another page. A soft navigation keeps the open document, and with it
 * that page's scripts and policy, so the key page is entered and left by a full page load (a plain anchor).
 */
export const fullLoad = (href: string, current: string | null): boolean => href === KEY_PAGE || current === KEY_PAGE;
