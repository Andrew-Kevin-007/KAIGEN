"use client";

import { ConnectButton } from "@/components/landing/ConnectButton";
import "@/components/landing/samurai.css";


import { SiteFooter } from "@/components/SiteFooter";

export default function CallToAction() {
  return (
    <div style={{opacity: "1"}}>
      <section className="CallToAction__CalloutContainer-sc-1h8o5cy-2 dhshTJ">
        <div className="InnerContainer__Container-sc-oy047e-0 hKlZHw">
          <div className="CallToAction__ContentContainer-sc-1h8o5cy-3 fMWa-dx">
            <div style={{display: "flex", flexDirection: "column", gap: "1.5rem"}}>
              <h1 className="Typography__Heading1-sc-p3xo6h-1 fuTHBv">
                {"Explore KAIGEN"}
              </h1>
              <p className="Typography__Paragraph-sc-p3xo6h-7 dwgfHL">
                {"KAIGEN turns NEAR's new post-quantum keys into an automatic lockdown, so your account does not need you online on the day an omen breaks."}
              </p>
            </div>
            <ConnectButton className="SectionIntro__Button-sc-1nhl813-4 dQyCQZ" label="Connect wallet" connectedLabel="Continue" />
          </div>
          <SiteFooter />
        </div>
        <div className="cta-ink" aria-hidden="true">
          <img src="/media/katana-ink.png" alt="" width={640} height={1273} />
        </div>
      </section>
    </div>
  );
}
