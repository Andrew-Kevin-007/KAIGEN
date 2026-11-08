"use client";



export default function SectionFAQs() {
  return (
    <div className="InnerContainer__Container-sc-oy047e-0 hKlZHw">
      <section id="faqs" className="SectionFAQs__Section-sc-1d7bac3-0 cQxkDi" style={{columnGap: "5rem", rowGap: "2rem", position: "relative", isolation: "isolate"}}>
        <div className="faq-backdrop" aria-hidden="true">
          <img src="/media/ink/lily.png" alt="" width={553} height={1156} />
        </div>
        <h1 className="Typography__Heading1-sc-p3xo6h-1 fuTHBv">
          {"Frequently asked questions"}
        </h1>
        <div style={{display: "flex", alignItems: "flex-start", flexDirection: "column"}}>
          <div className="Accordion__StyledCollapsableContainer-sc-1qwu44b-0 kMKQKR">
            <div itemScope itemProp="mainEntity" itemType="https://schema.org/Question" className="Item__StyledCollapsableItem-sc-bjycf3-2 egfBPj">
              <button className="Item__Toggle-sc-bjycf3-4 iIeMnL">
                <div style={{position: "absolute", width: "14px", height: "2px", borderRadius: "2px", background: "currentcolor", transform: "none"}}></div>
                <div style={{position: "absolute", width: "2px", height: "14px", borderRadius: "2px", background: "currentcolor", transform: "translateX(6px) scale(1) rotateZ(0deg) translateZ(0px)"}}></div>
              </button>
              <div className="Item__ContentArea-sc-bjycf3-3 zAoJF">
                <div itemProp="name" className="Item__Question-sc-bjycf3-0 gtqjE">
                  <h4 className="Typography__Paragraph-sc-p3xo6h-7 eHgZom">
                    {"Is KAIGEN safe?"}
                  </h4>
                </div>
                <div itemScope itemProp="acceptedAnswer" itemType="https://schema.org/Answer" style={{overflow: "hidden", height: "0px"}}>
                  <div style={{opacity: "0"}}>
                    <div className="Item__Answer-sc-bjycf3-1 dRpVAN">
                      <p className="Typography__Paragraph-sc-p3xo6h-7 dwgfHL">
                        {"Only you hold the admin key, and a broken classical key can spend only its daily limit. KAIGEN has no admin and no upgrade path after deploy. It has not had an outside audit, but you can "}
                        <a href="#transparency">
                          {"check the claims yourself"}
                        </a>
                        {" against mainnet with one command."}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div itemScope itemProp="mainEntity" itemType="https://schema.org/Question" className="Item__StyledCollapsableItem-sc-bjycf3-2 egfBPj">
              <button className="Item__Toggle-sc-bjycf3-4 iIeMnL">
                <div style={{position: "absolute", width: "14px", height: "2px", borderRadius: "2px", background: "currentcolor", transform: "none"}}></div>
                <div style={{position: "absolute", width: "2px", height: "14px", borderRadius: "2px", background: "currentcolor", transform: "translateX(6px) scale(1) rotateZ(0deg) translateZ(0px)"}}></div>
              </button>
              <div className="Item__ContentArea-sc-bjycf3-3 zAoJF">
                <div itemProp="name" className="Item__Question-sc-bjycf3-0 gtqjE">
                  <h4 className="Typography__Paragraph-sc-p3xo6h-7 eHgZom">
                    {"What if I lose the admin key?"}
                  </h4>
                </div>
                <div itemScope itemProp="acceptedAnswer" itemType="https://schema.org/Answer" style={{overflow: "hidden", height: "0px"}}>
                  <div style={{opacity: "0"}}>
                    <div className="Item__Answer-sc-bjycf3-1 dRpVAN">
                      <p className="Typography__Paragraph-sc-p3xo6h-7 dwgfHL">
                        {"Daily keys can still queue withdrawals while the era is calm. After kaigen, funds are stuck, which is why an encrypted backup is required before the vault is created. See "}
                        <a href="/migrate">
                          {"the backup step"}
                        </a>
                        {" and "}
                        <a href="#features">
                          {"the limits"}
                        </a>
                        {"."}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div itemScope itemProp="mainEntity" itemType="https://schema.org/Question" className="Item__StyledCollapsableItem-sc-bjycf3-2 egfBPj">
              <button className="Item__Toggle-sc-bjycf3-4 iIeMnL">
                <div style={{position: "absolute", width: "14px", height: "2px", borderRadius: "2px", background: "currentcolor", transform: "none"}}></div>
                <div style={{position: "absolute", width: "2px", height: "14px", borderRadius: "2px", background: "currentcolor", transform: "translateX(6px) scale(1) rotateZ(0deg) translateZ(0px)"}}></div>
              </button>
              <div className="Item__ContentArea-sc-bjycf3-3 zAoJF">
                <div itemProp="name" className="Item__Question-sc-bjycf3-0 gtqjE">
                  <h4 className="Typography__Paragraph-sc-p3xo6h-7 eHgZom">
                    {"Which networks does KAIGEN cover?"}
                  </h4>
                </div>
                <div itemScope itemProp="acceptedAnswer" itemType="https://schema.org/Answer" style={{overflow: "hidden", height: "0px"}}>
                  <div style={{opacity: "0"}}>
                    <div className="Item__Answer-sc-bjycf3-1 dRpVAN">
                      <p className="Typography__Paragraph-sc-p3xo6h-7 dwgfHL">
                        {"KAIGEN targets NEAR mainnet and NEAR's ML-DSA-65 post-quantum keys, live since network upgrade 2.13 on 20 July 2026. Other chains appear only as bounty addresses."}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <a className="ButtonSecondary__Anchor-sc-famgus-1 keMDOg" href="#features">
            <div className="ButtonSecondary__Container-sc-famgus-0 gDEmYq">
              {"Read the limits"}
              <svg width="18" height="15" viewBox="0 0 18 15" fill="none" style={{marginLeft: "2px", transform: "none"}}>
                <path fillRule="evenodd" clipRule="evenodd" d="M9.94417 0.373474L17.2534 7.49997L9.94417 14.6265L8.7225 13.3735L13.8492 8.37497H0L0 6.62497L13.8492 6.62497L8.7225 1.62647L9.94417 0.373474Z" fill="currentColor" />
              </svg>
            </div>
          </a>
        </div>
      </section>
    </div>
  );
}
