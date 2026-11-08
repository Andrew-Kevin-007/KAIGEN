"use client";


import InkArt from "@/components/landing/InkArt";

export default function SectionSafety() {
  return (
    <div className="InnerContainer__Container-sc-oy047e-0 hKlZHw">
      <section className="SectionSafety__Section-sc-c0l6l8-0 kNTtOn">
        <div style={{display: "flex", flexDirection: "column", gap: "16px"}}>
          <p className="Typography__Paragraph-sc-p3xo6h-7 hmrSHZ" style={{color: "var(--blue)"}}>
            {"Bounded"}
          </p>
          <div style={{display: "flex", flexDirection: "column", gap: "24px"}}>
            <h1 className="Typography__Heading1-sc-p3xo6h-1 fuTHBv">
              {"Bounded loss."}
              <span>
                {"Calm days."}
              </span>
            </h1>
            <p className="Typography__Paragraph-sc-p3xo6h-7 jABlnH">
              {"Mamori limits what a classical key can ever do, and a false alarm moves no funds, it only locks a vault into post-quantum-only mode. KAIGEN has no admin and no upgrade path after deploy."}
            </p>
          </div>
          <ul className="TickList__List-sc-wlabxu-1 kjHLdh" style={{gridTemplateColumns: "1fr 1fr", color: "var(--blue)", padding: "1rem 0px 0px"}}>
            <li style={{display: "flex", alignItems: "flex-start", gap: "0.9375rem"}}>
              <svg width="18" height="14" viewBox="0 0 18 14" fill="none" style={{marginTop: "6px", minWidth: "18px"}}>
                <path d="M1 6.76191L6.33333 12L17 1" stroke="currentColor" strokeWidth="2.25" />
              </svg>
              <span className="TickList__Text-sc-wlabxu-0 ieuDOz">
                {"Self-custody"}
              </span>
            </li>
            <li style={{display: "flex", alignItems: "flex-start", gap: "0.9375rem"}}>
              <svg width="18" height="14" viewBox="0 0 18 14" fill="none" style={{marginTop: "6px", minWidth: "18px"}}>
                <path d="M1 6.76191L6.33333 12L17 1" stroke="currentColor" strokeWidth="2.25" />
              </svg>
              <span className="TickList__Text-sc-wlabxu-0 ieuDOz">
                {"Own your admin key"}
              </span>
            </li>
            <li style={{display: "flex", alignItems: "flex-start", gap: "0.9375rem"}}>
              <svg width="18" height="14" viewBox="0 0 18 14" fill="none" style={{marginTop: "6px", minWidth: "18px"}}>
                <path d="M1 6.76191L6.33333 12L17 1" stroke="currentColor" strokeWidth="2.25" />
              </svg>
              <span className="TickList__Text-sc-wlabxu-0 ieuDOz">
                {"No account needed"}
              </span>
            </li>
            <li style={{display: "flex", alignItems: "flex-start", gap: "0.9375rem"}}>
              <svg width="18" height="14" viewBox="0 0 18 14" fill="none" style={{marginTop: "6px", minWidth: "18px"}}>
                <path d="M1 6.76191L6.33333 12L17 1" stroke="currentColor" strokeWidth="2.25" />
              </svg>
              <span className="TickList__Text-sc-wlabxu-0 ieuDOz">
                {"No lock-in"}
              </span>
            </li>
            <li style={{display: "flex", alignItems: "flex-start", gap: "0.9375rem"}}>
              <svg width="18" height="14" viewBox="0 0 18 14" fill="none" style={{marginTop: "6px", minWidth: "18px"}}>
                <path d="M1 6.76191L6.33333 12L17 1" stroke="currentColor" strokeWidth="2.25" />
              </svg>
              <span className="TickList__Text-sc-wlabxu-0 ieuDOz">
                {"Verify it yourself"}
              </span>
            </li>
          </ul>
        </div>
        <div style={{gridRow: "1", display: "flex", flexDirection: "column", gap: "1.5rem", padding: "2rem 0"}}>
          <InkArt name="cherry" className="ink-art--soft" alt="Ink and watercolour drawing of a branch of red blossoms." width={716} height={1244} maxWidth={420} />
        </div>
      </section>
    </div>
  );
}
