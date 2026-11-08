"use client";

import { motion } from "framer-motion";
import { ConnectButton } from "@/components/landing/ConnectButton";
import "@/components/landing/samurai.css";

import EraPanels from "@/components/landing/EraPanels";

import InkArt from "@/components/landing/InkArt";

export default function SectionIntro() {
  return (
    <>
    <div style={{overflow: "hidden"}}>
      <section id="join" className="SectionIntro__Section-sc-1nhl813-0 hcdKOK samurai-backdrop">
        <div className="samurai-backdrop__art" aria-hidden="true">
          <img src="/media/ink/samurai.png" alt="" width={469} height={647} fetchPriority="high" />
        </div>
        <div className="InnerContainer__Container-sc-oy047e-0 hKlZHw">
          <section>
            <div style={{position: "relative", display: "flex", flexDirection: "column", alignItems: "stretch", textAlign: "center", gap: "6px", paddingBottom: "38px"}}>
              <motion.div style={{margin: "0px auto", maxWidth: "100%", padding: "0px 1rem"}} initial={{opacity: 0, y: 32}} animate={{opacity: 1, y: 0}} transition={{duration: 0.937, ease: [0.19, 1, 0.22, 1], delay: 0}}></motion.div>
              <h1 className="SectionIntro__Title-sc-1nhl813-1 geYPoR" style={{perspective: "600px", overflow: "hidden", paddingBottom: "16px"}}>
                <motion.span style={{display: "inline-block", position: "relative"}} initial={{opacity: 0, rotate: 0, rotateX: -45, y: "100%"}} animate={{opacity: 1, rotate: 0, rotateX: 0, y: 0}} transition={{duration: 0.937, ease: [0.19, 1, 0.22, 1], delay: 0.3}}>{"When"}</motion.span>
                {" "}
                <motion.span style={{display: "inline-block", position: "relative"}} initial={{opacity: 0, rotate: 0, rotateX: -45, y: "100%"}} animate={{opacity: 1, rotate: 0, rotateX: 0, y: 0}} transition={{duration: 0.937, ease: [0.19, 1, 0.22, 1], delay: 0.35}}>{"keys"}</motion.span>
                {" "}
                <br />
                <motion.span style={{display: "inline-block", position: "relative"}} initial={{opacity: 0, rotate: 0, rotateX: -45, y: "100%"}} animate={{opacity: 1, rotate: 0, rotateX: 0, y: 0}} transition={{duration: 0.937, ease: [0.19, 1, 0.22, 1], delay: 0.6}}>{"break,"}</motion.span>
                {" "}
                <motion.span style={{display: "inline-block", position: "relative"}} initial={{opacity: 0, rotate: 0, rotateX: -45, y: "100%"}} animate={{opacity: 1, rotate: 0, rotateX: 0, y: 0}} transition={{duration: 0.937, ease: [0.19, 1, 0.22, 1], delay: 0.65}}>{"adapt."}</motion.span>
                {" "}
              </h1>
              <motion.div style={{margin: "0px auto", maxWidth: "440px", padding: "0px 1rem"}} initial={{opacity: 0, y: 32}} animate={{opacity: 1, y: 0}} transition={{duration: 0.937, ease: [0.19, 1, 0.22, 1], delay: 1}}>
                <p className="Typography__Paragraph-sc-p3xo6h-7 gWkJEG">
                  {"KAIGEN protects NEAR accounts from the day quantum computers break today's signatures. When a public omen key is broken, every opted-in vault locks itself into post-quantum-only mode."}
                </p>
              </motion.div>
              <motion.div className="SectionIntro__ButtonContainer-sc-1nhl813-3 OJwrO" initial={{opacity: 0, y: 32}} animate={{opacity: 1, y: 0}} transition={{duration: 0.937, ease: [0.19, 1, 0.22, 1], delay: 1.1}}>
                <ConnectButton className="SectionIntro__Button-sc-1nhl813-4 dQyCQZ" label="Connect wallet" connectedLabel="Continue" />
              </motion.div>
            </div>
          </section>
        </div>
      </section>
      <div className="InnerContainer__Container-sc-oy047e-0 hKlZHw" style={{transform: "none", opacity: "1"}}>
        <section className="SectionExplore__Section-sc-1nsvpxz-0 kVnmLA">
          <h1 className="Typography__Heading1-sc-p3xo6h-1 fuTHBv">
            {"One signed claim "}
            <span>
              {"moves the era."}
            </span>
          </h1>
          <InkArt name="blade-2" alt="Ink drawing of a katana's guard and blade with kanji engraved down the steel." width={663} height={1308} maxWidth={340} />
          <EraPanels />
        </section>
      </div>
    </div>
    </>
  );
}
