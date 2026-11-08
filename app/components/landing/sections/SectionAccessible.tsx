"use client";



import InkArt from "@/components/landing/InkArt";

export default function SectionAccessible() {
  return (
    <div className="InnerContainer__Container-sc-oy047e-0 hKlZHw">
      <section className="SectionAccessible__Section-sc-1tnsku5-0 cmwFAF">
        <div style={{display: "flex", flexDirection: "column", gap: "16px"}}>
          <p className="Typography__Paragraph-sc-p3xo6h-7 hmrSHZ" style={{color: "var(--green)"}}>
            {"Daily"}
          </p>
          <div style={{display: "flex", flexDirection: "column", gap: "20px"}}>
            <h1 className="Typography__Heading1-sc-p3xo6h-1 fuTHBv">
              {"Watch the exposure"}
              <span>
                {"as it changes."}
              </span>
            </h1>
            <p className="Typography__Paragraph-sc-p3xo6h-7 jABlnH">
              {"Hinomi publishes, every day, how much value on NEAR sits behind classical-only keys and how much is already post-quantum, with history. It is named for the Edo fire-lookout tower."}
            </p>
          </div>
          <ul className="TickList__List-sc-wlabxu-1 kjHLdh" style={{gridTemplateColumns: "1fr", color: "var(--green)", padding: "0.5rem 0px 0.75rem"}}>
            <li style={{display: "flex", alignItems: "flex-start", gap: "0.9375rem"}}>
              <svg width="18" height="14" viewBox="0 0 18 14" fill="none" style={{marginTop: "6px", minWidth: "18px"}}>
                <path d="M1 6.76191L6.33333 12L17 1" stroke="currentColor" strokeWidth="2.25" />
              </svg>
              <span className="TickList__Text-sc-wlabxu-0 ieuDOz">
                {"Classical-only value"}
              </span>
            </li>
            <li style={{display: "flex", alignItems: "flex-start", gap: "0.9375rem"}}>
              <svg width="18" height="14" viewBox="0 0 18 14" fill="none" style={{marginTop: "6px", minWidth: "18px"}}>
                <path d="M1 6.76191L6.33333 12L17 1" stroke="currentColor" strokeWidth="2.25" />
              </svg>
              <span className="TickList__Text-sc-wlabxu-0 ieuDOz">
                {"Post-quantum value"}
              </span>
            </li>
            <li style={{display: "flex", alignItems: "flex-start", gap: "0.9375rem"}}>
              <svg width="18" height="14" viewBox="0 0 18 14" fill="none" style={{marginTop: "6px", minWidth: "18px"}}>
                <path d="M1 6.76191L6.33333 12L17 1" stroke="currentColor" strokeWidth="2.25" />
              </svg>
              <span className="TickList__Text-sc-wlabxu-0 ieuDOz">
                {"Public history"}
              </span>
            </li>
          </ul>
        </div>
        <div>
          <InkArt name="pagoda" alt="Ink drawing of a five-roofed pagoda on a rocky hill, with blossoming branches around it." width={658} height={1004} maxWidth={400} />
        </div>
      </section>
    </div>
  );
}
