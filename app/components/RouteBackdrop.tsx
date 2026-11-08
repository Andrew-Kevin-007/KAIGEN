"use client";

import { usePathname } from "next/navigation";

// One ink drawing per page, from the landing's own set (public/media/ink), standing in the empty space beside the page header.
// Each is sized to end above the first table or form. The key page (/migrate) gets none on purpose: it is the page that
// handles a secret, so it stays plain.
const ART: Record<string, { name: string; ratio: number; height: number }> = {
  "/start": { name: "samurai", ratio: 469 / 647, height: 400 },
  "/omens": { name: "torii", ratio: 432 / 518, height: 360 },
  "/vault": { name: "kabuto", ratio: 640 / 902, height: 400 },
  "/vault/create": { name: "bamboo", ratio: 513 / 1000, height: 380 },
  "/bounty": { name: "dragon", ratio: 217 / 777, height: 300 },
};

export function RouteBackdrop() {
  const path = usePathname();
  const art = ART[path];
  if (!art) return null;
  return (
    <div className="route-backdrop" aria-hidden="true" style={{ height: `min(${art.height}px, 36vw)` }}>
      <img src={`/media/ink/${art.name}.png`} alt="" width={Math.round(art.height * art.ratio)} height={art.height} />
    </div>
  );
}
