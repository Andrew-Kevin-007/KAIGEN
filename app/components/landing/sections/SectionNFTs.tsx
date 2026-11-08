"use client";



import { BitcoinIcon, BountyIcon, ClaimIcon, CurveIcon, EthereumIcon, NearIcon, SeedIcon } from "@/components/landing/CryptoIcons";

import InkArt from "@/components/landing/InkArt";

export default function SectionNFTs() {
  return (
    <div className="InnerContainer__Container-sc-oy047e-0 hKlZHw">
      <section className="SectionNFTs__Section-sc-igm0kh-0 iSKXBS">
        <div style={{display: "flex", flexDirection: "column", gap: "16px"}}>
          <p className="Typography__Paragraph-sc-p3xo6h-7 hmrSHZ" style={{color: "var(--gold)"}}>
            {"Omens"}
          </p>
          <div style={{display: "flex", flexDirection: "column", gap: "26px"}}>
            <h1 className="Typography__Heading1-sc-p3xo6h-1 fuTHBv">
              {"Two curves, two omens."}
            </h1>
            <p className="Typography__Paragraph-sc-p3xo6h-7 jABlnH">
              {"ed25519-omen covers NEAR account keys. secp256k1-omen covers Bitcoin and Ethereum. Each is a public key derived from a published seed, so nobody holds it."}
            </p>
          </div>
          <ul style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem 1.25rem", color: "var(--gold)", margin: "0px", padding: "0.75rem 0px 0.375rem"}}>
            <li style={{display: "flex", alignItems: "center", gap: "0.75rem"}}>
              <div style={{display: "flex", alignItems: "center", justifyContent: "center", gap: "4px", minWidth: "20px", height: "20px"}}><NearIcon /></div>
              <span className="SectionNFTs__Text-sc-igm0kh-2 iWutAh">
                {"ed25519"}
              </span>
            </li>
            <li style={{display: "flex", alignItems: "center", gap: "0.75rem"}}>
              <div style={{display: "flex", alignItems: "center", justifyContent: "center", gap: "4px", minWidth: "20px", height: "20px"}}><BitcoinIcon /><EthereumIcon /></div>
              <span className="SectionNFTs__Text-sc-igm0kh-2 iWutAh">
                {"secp256k1"}
              </span>
            </li>
            <li style={{display: "flex", alignItems: "center", gap: "0.75rem"}}>
              <div style={{display: "flex", alignItems: "center", justifyContent: "center", gap: "4px", minWidth: "20px", height: "20px"}}><SeedIcon /></div>
              <span className="SectionNFTs__Text-sc-igm0kh-2 iWutAh">
                {"Seed"}
              </span>
            </li>
            <li style={{display: "flex", alignItems: "center", gap: "0.75rem"}}>
              <div style={{display: "flex", alignItems: "center", justifyContent: "center", gap: "4px", minWidth: "20px", height: "20px"}}><CurveIcon /></div>
              <span className="SectionNFTs__Text-sc-igm0kh-2 iWutAh">
                {"Hash-to-curve"}
              </span>
            </li>
            <li style={{display: "flex", alignItems: "center", gap: "0.75rem"}}>
              <div style={{display: "flex", alignItems: "center", justifyContent: "center", gap: "4px", minWidth: "20px", height: "20px"}}><ClaimIcon /></div>
              <span className="SectionNFTs__Text-sc-igm0kh-2 iWutAh">
                {"Claim"}
              </span>
            </li>
            <li style={{display: "flex", alignItems: "center", gap: "0.75rem"}}>
              <div style={{display: "flex", alignItems: "center", justifyContent: "center", gap: "4px", minWidth: "20px", height: "20px"}}><BountyIcon /></div>
              <span className="SectionNFTs__Text-sc-igm0kh-2 iWutAh">
                {"Bounty"}
              </span>
            </li>
          </ul>
        </div>
        <div style={{gridRow: "1"}}>
          <InkArt name="torii" alt="Ink drawing of a torii gate on a shore with a red sun above it and a faint circle around the gate." width={432} height={518} maxWidth={520} />
        </div>
      </section>
    </div>
  );
}
