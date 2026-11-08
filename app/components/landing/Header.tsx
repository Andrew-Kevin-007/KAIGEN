"use client";

import { ConnectButton } from "@/components/landing/ConnectButton";
import "./samurai.css";

export default function Header() {
  return (
    <div className="glass-nav" style={{zIndex: "214748365", top: "0px", left: "0px", right: "0px", position: "sticky"}}>
      <div className="InnerContainer__Container-sc-oy047e-0 hKlZHw">
        <header style={{zIndex: "999", position: "relative", transform: "translateZ(1px)"}}>
          <div className="Topbar__Content-sc-gsec0x-0 blZVGu" style={{opacity: "1"}}>
            <div className="Topbar__LogoAnchor-sc-gsec0x-1 bBWjGI">
              <a href="/">
                <div className="Logo__Container-sc-brvax7-0 iHjrEA">
                  <span style={{fontWeight: 700, fontSize: "20px", letterSpacing: "-0.03em", lineHeight: 1, color: "currentColor"}}>KAIGEN</span>
                  
                </div>
              </a>
            </div>
            <nav className="Nav__NavContainer-sc-141m4ur-5 cgvYDO">
              <div className="Nav__NavMenu-sc-141m4ur-11 gAvZOD">
                <ul className="Nav__PageMenu-sc-141m4ur-10 clDwSL">
                  <li>
                    <a href="#mechanism">
                      {"Build"}
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                        <path d="M1.5 3.5L5 7L8.5 3.5" stroke="var(--heading)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </a>
                    <div className="Nav__DropdownContainer-sc-141m4ur-3 jmGeWm">
                      <div className="Nav__DropdownContent-sc-141m4ur-4 kZbwzk">
                        <ul>
                          <li>
                            <a href="#mechanism">
                              <div className="Nav__IconContainer-sc-141m4ur-2 jhkKsN connectKit">
                                <svg width="23" height="28" viewBox="0 0 23 28" fill="none" style={{transform: "translateY(1px)"}}>
                                  <path d="M11.3125 4.4375L16.125 4.4375C18.4032 4.4375 20.25 6.28433 20.25 8.5625V8.5625C20.25 10.8407 18.4032 12.6875 16.125 12.6875L6.5 12.6875C4.22183 12.6875 2.375 14.5343 2.375 16.8125V16.8125C2.375 19.0907 4.22183 20.9375 6.5 20.9375H10.625" stroke="#848281" strokeWidth="2" strokeLinecap="round" />
                                  <rect x="1" y="1" width="6.875" height="6.875" rx="3.4375" fill="white" fillOpacity="0.2" stroke="#848281" strokeWidth="2" />
                                  <path d="M16.4175 18C16.8986 17.1667 18.1014 17.1667 18.5825 18L21.1806 22.5C21.6617 23.3333 21.0603 24.375 20.0981 24.375H14.9019C13.9397 24.375 13.3383 23.3333 13.8194 22.5L16.4175 18Z" stroke="#848281" strokeWidth="2" />
                                </svg>
                              </div>
                              <div className="sc-eIcdZJ bQoldi">
                                <div className="Nav__StyledHeading-sc-141m4ur-0 fhJwEg" style={{paddingTop: "1px"}}>
                                  <h5 className="Typography__Paragraph-sc-p3xo6h-7 hAxgce">
                                    {"Contracts"}
                                  </h5>
                                </div>
                                <p className="Typography__Paragraph-sc-p3xo6h-7 idDTlz">
                                  {"Kizashi and Mamori, written in Rust."}
                                </p>
                              </div>
                            </a>
                          </li>
                          <li>
                            <a href="/start">
                              <div className="Nav__IconContainer-sc-141m4ur-2 jhkKsN API">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                                  <path d="M13.8666 7.80008H10.1333C8.8446 7.80008 7.79993 8.84475 7.79993 10.1334V13.8701C7.79993 15.1569 8.8431 16.2001 10.1299 16.2001H13.8699C15.1568 16.2001 16.1999 15.1569 16.1999 13.8701V10.1334C16.1999 8.84475 15.1553 7.80008 13.8666 7.80008Z" stroke="#848281" strokeWidth="2" strokeLinecap="round" />
                                  <path d="M22.5 12.0028C22.5 10.3009 21.2898 8.87787 19.6836 8.5537C19.6643 8.5498 19.6502 8.53289 19.6502 8.5132V8.5132C19.6502 8.4935 19.6643 8.47659 19.6836 8.47269C21.2898 8.14852 22.5 6.7255 22.5 5.02357C22.5 3.07797 20.9225 1.50566 18.983 1.50566C17.2959 1.50566 15.8921 2.68954 15.5428 4.26939C15.5375 4.29351 15.5162 4.31093 15.4915 4.31093V4.31093C15.4668 4.31093 15.4455 4.29348 15.4402 4.26935C15.0909 2.68394 13.6816 1.5 12 1.5C10.3184 1.5 8.90909 2.68392 8.5598 4.26379C8.55447 4.28787 8.53322 4.30528 8.50855 4.30528V4.30528C8.48383 4.30528 8.46253 4.28778 8.45727 4.26362C8.11343 2.68383 6.7041 1.5 5.01696 1.5C3.07754 1.5 1.5 3.07797 1.5 5.01791C1.5 6.71983 2.71015 8.14283 4.31632 8.46703C4.33566 8.47093 4.34976 8.48787 4.34976 8.5076V8.5076C4.34976 8.52728 4.33573 8.54419 4.31645 8.54814C2.71022 8.87775 1.5 10.2952 1.5 12.0028C1.5 13.7104 2.71018 15.1279 4.31637 15.452C4.33568 15.4559 4.34976 15.4728 4.34976 15.4925V15.4925C4.34976 15.5122 4.33568 15.5291 4.31638 15.533C2.71018 15.8571 1.5 17.2802 1.5 18.9821C1.5 20.9277 3.07754 22.5 5.01696 22.5C6.70417 22.5 8.11354 21.3161 8.45732 19.7307C8.46255 19.7065 8.48381 19.6891 8.5085 19.6891V19.6891C8.53317 19.6891 8.55442 19.7065 8.55967 19.7306C8.90348 21.3106 10.3128 22.5 12 22.5C13.6872 22.5 15.0966 21.3161 15.4404 19.7307C15.4456 19.7065 15.4668 19.6891 15.4915 19.6891V19.6891C15.5162 19.6891 15.5375 19.7065 15.5427 19.7306C15.8865 21.3106 17.2959 22.5 18.983 22.5C20.9281 22.5 22.5 20.922 22.5 18.9821C22.5 17.2802 21.2898 15.8571 19.6836 15.533C19.6643 15.5291 19.6502 15.5122 19.6502 15.4925V15.4925C19.6502 15.4728 19.6643 15.4559 19.6836 15.452C21.2898 15.1278 22.5 13.7048 22.5 12.0028Z" stroke="#848281" strokeWidth="2" />
                                </svg>
                              </div>
                              <div className="sc-eIcdZJ bQoldi">
                                <div className="Nav__StyledHeading-sc-141m4ur-0 fhJwEg">
                                  <h5 className="Typography__Paragraph-sc-p3xo6h-7 hAxgce">
                                    {"KAIGEN"}
                                  </h5>
                                </div>
                                <p className="Typography__Paragraph-sc-p3xo6h-7 idDTlz">
                                  {"A guarded vault on every account."}
                                </p>
                              </div>
                            </a>
                          </li>
                        </ul>
                      </div>
                    </div>
                  </li>
                  <li>
                    <a className="" href="#features">
                      {"Resources"}
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                        <path d="M1.5 3.5L5 7L8.5 3.5" stroke="var(--heading)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </a>
                    <div className="Nav__DropdownContainer-sc-141m4ur-3 jmGeWm" style={{width: "164px"}}>
                      <div className="Nav__DropdownContent-sc-141m4ur-4 bInzzw">
                        <ul>
                          <li>
                            <a className="" href="#transparency">
                              <span className="Typography__Paragraph-sc-p3xo6h-7 hAxgce">
                                {"Fire tests"}
                              </span>
                            </a>
                          </li>
                          <li>
                            <a className="" href="#features">
                              <span className="Typography__Paragraph-sc-p3xo6h-7 hAxgce">
                                {"Limits"}
                              </span>
                            </a>
                          </li>
                          <li>
                            <a className="" href="#faqs">
                              <span className="Typography__Paragraph-sc-p3xo6h-7 hAxgce">
                                {"FAQs"}
                              </span>
                            </a>
                          </li>
                        </ul>
                      </div>
                    </div>
                  </li>
                </ul>
                <div className="Nav__ActionMenu-sc-141m4ur-12 ekXEVU">
                  <a className="login-button" href="/vault">
                    <button data-app-download-button="true" className="Button__Container-sc-1jjqbrw-0 hACioR">
                      {"Look up a vault"}
                    </button>
                  </a>
                  <ConnectButton className="Button__Container-sc-1jjqbrw-0 fnjIlG" label="Connect wallet" connectedLabel="Continue" />
                </div>
              </div>
              <button className="Nav__MenuButton-sc-141m4ur-7 fMLkQg">
                <div className="Nav__Hamburger-sc-141m4ur-6 iVRvzB"></div>
              </button>
            </nav>
          </div>
        </header>
      </div>
      <div style={{position: "relative", zIndex: "-1", opacity: "1"}}>
        <hr style={{margin: "0px auto", background: "rgba(0, 0, 0, 0.05)", transform: "translateY(1px)", opacity: "1", maxWidth: "64rem", width: "100%"}} />
      </div>
    </div>
  );
}
