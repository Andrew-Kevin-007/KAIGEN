"use client";

export default function SectionFeatures() {
  return (
    <section id="features" className="SectionFeatures__Section-sc-188t8tm-0 lcJJmu">
      <div className="InnerContainer__Container-sc-oy047e-0 hKlZHw">
        <div className="SectionFeatures__Content-sc-188t8tm-1 llintP">
          <div style={{display: "flex", flexDirection: "column", gap: "0.625rem"}}>
            <h5 className="Typography__Paragraph-sc-p3xo6h-7 hmrSHZ" style={{color: "var(--blue)"}}>
              {"Permissionless trip"}
            </h5>
            <p className="Typography__Paragraph-sc-p3xo6h-7 dwgfHL">
              {"Anyone, a keeper or the app can call trip on a vault. Nothing in between needs trust."}
            </p>
          </div>
          <div style={{display: "flex", flexDirection: "column", gap: "0.625rem"}}>
            <h5 className="Typography__Paragraph-sc-p3xo6h-7 hmrSHZ" style={{color: "var(--blue)"}}>
              {"Signature-proven omens"}
            </h5>
            <p className="Typography__Paragraph-sc-p3xo6h-7 dwgfHL">
              {"An omen's death is proven by a signature that the chain verifies. There is no oracle and no admin, and the contracts are locked after deploy."}
            </p>
          </div>
          <div style={{display: "flex", flexDirection: "column", gap: "0.625rem"}}>
            <h5 className="Typography__Paragraph-sc-p3xo6h-7 hmrSHZ" style={{color: "var(--blue)"}}>
              {"Bounded loss"}
            </h5>
            <p className="Typography__Paragraph-sc-p3xo6h-7 dwgfHL">
              {"A broken daily key can send only up to its limit, or queue a withdrawal the admin can cancel within the delay. That holds even if no omen ever breaks."}
            </p>
          </div>
          <div style={{display: "flex", flexDirection: "column", gap: "0.625rem"}}>
            <h5 className="Typography__Paragraph-sc-p3xo6h-7 hmrSHZ" style={{color: "var(--blue)"}}>
              {"A bounty on real addresses"}
            </h5>
            <p className="Typography__Paragraph-sc-p3xo6h-7 dwgfHL">
              {"The omen keys also hold bounties at a NEAR implicit account, a Solana address and a Bitcoin Taproot address. Anyone can top up the bounty."}
            </p>
          </div>
          <div style={{display: "flex", flexDirection: "column", gap: "0.625rem"}}>
            <h5 className="Typography__Paragraph-sc-p3xo6h-7 hmrSHZ" style={{color: "var(--blue)"}}>
              {"Self-custody"}
            </h5>
            <p className="Typography__Paragraph-sc-p3xo6h-7 dwgfHL">
              {"KAIGEN never holds your keys or your funds. The admin key is made in your browser, and you save an encrypted backup before the vault is created."}
            </p>
          </div>
          <div style={{display: "flex", flexDirection: "column", gap: "0.625rem"}}>
            <h5 className="Typography__Paragraph-sc-p3xo6h-7 hmrSHZ" style={{color: "var(--blue)"}}>
              {"Honest limits"}
            </h5>
            <p className="Typography__Paragraph-sc-p3xo6h-7 dwgfHL">
              {"Validator keys stay classical until about the end of 2027, and an omen proves a curve can be broken, not who broke it. The limits are stated up front."}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
