/**
 * Line icons for the "Two curves, two omens" list, each matching its word. The NEAR, Bitcoin and Ethereum marks are
 * simplified outlines drawn for this page (not the brands' own logo files); swap in the official assets before publishing.
 * They draw in currentColor so the section colour applies.
 */
const base = {
  width: 20,
  height: 20,
  viewBox: "0 0 20 20",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export const NearIcon = () => (
  <svg {...base}>
    <circle cx="10" cy="10" r="8.5" />
    <path d="M7 14V6l6 8V6" />
  </svg>
);

export const BitcoinIcon = () => (
  <svg {...base}>
    <circle cx="10" cy="10" r="8.5" />
    <path d="M8 5.5h3a1.9 1.9 0 0 1 0 3.8H8m0 0h3.4a1.9 1.9 0 0 1 0 3.8H8M8 5v9.5M9.5 3.9v1.6M11.5 3.9v1.6M9.5 14.5v1.6M11.5 14.5v1.6" />
  </svg>
);

export const EthereumIcon = () => (
  <svg {...base}>
    <path d="M10 1.5 15.5 10 10 13.2 4.5 10z" />
    <path d="M4.5 11.6 10 14.8l5.5-3.2L10 18.5z" />
  </svg>
);

/** Seed: a sprout. */
export const SeedIcon = () => (
  <svg {...base}>
    <path d="M10 17.5V9.5M10 11.5C10 8 7.5 6 3.5 6c0 3.6 2.6 5.5 6.5 5.5M10 9.2C10 6 12 4 16.5 4c0 3.4-2.2 5.2-6.5 5.2" />
  </svg>
);

/** Hash-to-curve: a curve on its axes. */
export const CurveIcon = () => (
  <svg {...base}>
    <path d="M3 17V3M3 17h14M5.5 14c3.2 0 3.2-9 6-9s2.4 7 5 7" />
  </svg>
);

/** Claim: a seal pressed to paper. */
export const ClaimIcon = () => (
  <svg {...base}>
    <path d="M8.2 2.5h3.6v6H8.2zM5.5 8.5h9v3h-9zM4 16.5h12M6.5 14h7" />
  </svg>
);

/** Bounty: a coin. */
export const BountyIcon = () => (
  <svg {...base}>
    <circle cx="10" cy="10" r="8.5" />
    <circle cx="10" cy="10" r="5" />
    <path d="M10 7.8v4.4" />
  </svg>
);
