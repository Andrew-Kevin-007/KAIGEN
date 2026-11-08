"use client";



import InkArt from "@/components/landing/InkArt";

export default function SectionPrecision() {
  return (
    <div className="InnerContainer__Container-sc-oy047e-0 hKlZHw">
      <section id="transparency" className="SectionPrecision__Section-sc-1r300m7-0 iJVcKk">
        <div style={{display: "flex", flexDirection: "column", gap: "16px"}}>
          <p className="Typography__Paragraph-sc-p3xo6h-7 hmrSHZ" style={{color: "var(--orange)"}}>
            {"Transparent"}
          </p>
          <div style={{display: "flex", flexDirection: "column", gap: "20px"}}>
            <h1 className="Typography__Heading1-sc-p3xo6h-1 fuTHBv">
              {"Every claim, trip and"}
              <span>
                {"fire test on record."}
              </span>
            </h1>
            <p className="Typography__Paragraph-sc-p3xo6h-7 jABlnH">
              {"Claims, trips and weekly fire tests are events on mainnet, with transaction hashes published, so you can check what happened instead of taking our word for it."}
            </p>
          </div>
          <ul className="TickList__List-sc-wlabxu-1 kjHLdh" style={{gridTemplateColumns: "1fr", color: "var(--orange)", padding: "0.5rem 0px 0.75rem"}}>
            <li style={{display: "flex", alignItems: "flex-start", gap: "0.9375rem"}}>
              <svg width="18" height="14" viewBox="0 0 18 14" fill="none" style={{marginTop: "6px", minWidth: "18px"}}>
                <path d="M1 6.76191L6.33333 12L17 1" stroke="currentColor" strokeWidth="2.25" />
              </svg>
              <span className="TickList__Text-sc-wlabxu-0 ieuDOz">
                {"Public events"}
              </span>
            </li>
            <li style={{display: "flex", alignItems: "flex-start", gap: "0.9375rem"}}>
              <svg width="18" height="14" viewBox="0 0 18 14" fill="none" style={{marginTop: "6px", minWidth: "18px"}}>
                <path d="M1 6.76191L6.33333 12L17 1" stroke="currentColor" strokeWidth="2.25" />
              </svg>
              <span className="TickList__Text-sc-wlabxu-0 ieuDOz">
                {"Bounty watchers"}
              </span>
            </li>
            <li style={{display: "flex", alignItems: "flex-start", gap: "0.9375rem"}}>
              <svg width="18" height="14" viewBox="0 0 18 14" fill="none" style={{marginTop: "6px", minWidth: "18px"}}>
                <path d="M1 6.76191L6.33333 12L17 1" stroke="currentColor" strokeWidth="2.25" />
              </svg>
              <span className="TickList__Text-sc-wlabxu-0 ieuDOz">
                {"Weekly fire tests"}
              </span>
            </li>
          </ul>
        </div>
        <div style={{gridRow: "1"}}>
          <InkArt name="bamboo" alt="Ink drawing of two bamboo stalks with leaves." width={513} height={1000} maxWidth={340} />
        </div>
      </section>
    </div>
  );
}
