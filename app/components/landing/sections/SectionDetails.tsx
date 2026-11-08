"use client";


import InkArt from "@/components/landing/InkArt";

export default function SectionDetails() {
  return (
    <div className="InnerContainer__Container-sc-oy047e-0 hKlZHw">
      <section id="mechanism" className="SectionDetails__Section-sc-1rpovvh-0 jUQhDC">
        <div className="SectionDetails__Content-sc-1rpovvh-1 dgMEPB">
          <h1 className="Typography__Heading1-sc-p3xo6h-1 fuTHBv">
            {"The mechanism."}
          </h1>
          <p className="Typography__Paragraph-sc-p3xo6h-7 jABlnH">
            {"Four parts, each with one job."}
          </p>
        </div>
        <div className="SectionDetails__Details-sc-1rpovvh-2 wzCjA">
          <InkArt name="dragon" alt="Ink drawing of a dragon winding upward." width={217} height={777} maxWidth={220} />
          <div className="SectionDetails__DetailContainer-sc-1rpovvh-4 hoKycM">
            <div style={{display: "flex", flexDirection: "column", gap: "0.4375rem"}}>
              <p className="Typography__Paragraph-sc-p3xo6h-7 cfflXR" style={{color: "var(--blue)"}}>
                {"Kizashi: the omen registry"}
              </p>
              <p className="Typography__Paragraph-sc-p3xo6h-7 jABlnH">
                {"Omens are public keys nobody holds, each derived from a published seed by hashing to a curve point. A valid signature from one proves that curve's keys can be broken. Kizashi checks it on-chain, marks the omen dead forever and raises the era."}
              </p>
            </div>
          </div>
          <div className="SectionDetails__DetailContainer-sc-1rpovvh-4 hoKycM">
            <div className="SectionDetails__Panel-sc-1rpovvh-3 eOryyB">
              <span className="state-pill">
                <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
                  <circle cx="13" cy="13" r="12" fill="currentColor" />
                  <path d="M7.5 13.4 11.4 17 18.5 9.5" stroke="white" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>{"Claim"}</span>
                <svg width="20" height="14" viewBox="0 0 20 14" fill="none" aria-hidden="true">
                  <path d="M1 7h17M12 1.5 18 7l-6 5.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>{"Kaigen"}</span>
              </span>
            </div>
            <div style={{display: "flex", flexDirection: "column", gap: "0.4375rem"}}>
              <p className="Typography__Paragraph-sc-p3xo6h-7 cfflXR" style={{color: "var(--blue)"}}>
                {"Mamori: the guard on every vault"}
              </p>
              <p className="Typography__Paragraph-sc-p3xo6h-7 jABlnH">
                {"A classical daily key can only send within a 24 hour limit or queue a withdrawal the admin can cancel. When the era reaches kaigen, anyone can call trip and the guard deletes the classical keys."}
              </p>
            </div>
          </div>
          <div className="SectionDetails__DetailContainer-sc-1rpovvh-4 hoKycM">
            <div style={{display: "flex", flexDirection: "column", gap: "0.4375rem"}}>
              <p className="Typography__Paragraph-sc-p3xo6h-7 cfflXR" style={{color: "var(--blue)"}}>
                {"Hinomi: the daily exposure index"}
              </p>
              <p className="Typography__Paragraph-sc-p3xo6h-7 jABlnH">
                {"Each day it reads access keys and balances for the top NEAR accounts and every vault, and publishes how much value sits behind classical-only keys against post-quantum keys."}
              </p>
            </div>
          </div>
          <div className="SectionDetails__DetailContainer-sc-1rpovvh-4 hoKycM">
            <div style={{display: "flex", flexDirection: "column", gap: "0.4375rem"}}>
              <p className="Typography__Paragraph-sc-p3xo6h-7 cfflXR" style={{color: "var(--blue)"}}>
                {"Kaigen: the lockdown"}
              </p>
              <p className="Typography__Paragraph-sc-p3xo6h-7 jABlnH">
                {"Classical keys are removed and only post-quantum keys remain. Weekly fire tests run the same path on drill omens and drill vaults, so the lockdown is rehearsed before it is ever needed."}
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
