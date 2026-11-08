import Header from "@/components/landing/Header";
import SectionIntro from "@/components/landing/sections/SectionIntro";
import SectionSendReceiveSwap from "@/components/landing/sections/SectionSendReceiveSwap";
import SectionFeatures from "@/components/landing/sections/SectionFeatures";
import SectionNFTs from "@/components/landing/sections/SectionNFTs";
import SectionAccessible from "@/components/landing/sections/SectionAccessible";
import SectionPrecision from "@/components/landing/sections/SectionPrecision";
import SectionSafety from "@/components/landing/sections/SectionSafety";
import SectionOnboarding from "@/components/landing/sections/SectionOnboarding";
import SectionDetails from "@/components/landing/sections/SectionDetails";
import SectionFAQs from "@/components/landing/sections/SectionFAQs";
import CallToAction from "@/components/landing/sections/CallToAction";

const Rule = () => (
  <div className="InnerContainer__Container-sc-oy047e-0 hKlZHw">
    <hr style={{ background: "var(--gray-light)" }} />
  </div>
);

export default function Home() {
  return (
    <>
      <div className="_app__LoadingBar-sc-6lqo0o-0 fKMLUD" style={{ transformOrigin: "right center", transform: "scaleX(0) translateZ(0px)" }}></div>
      <div className="_app__Wrapper-sc-6lqo0o-1 dPkkOz">
        <p className="landing-caveat" role="note">
          <strong>Testnet only.</strong> No audit, not run on mainnet. The omens in the demo Kizashi are drill omens: nothing here means a production key has broken.
        </p>
        <Header />
        <div style={{ opacity: "1" }}>
          <main>
            <SectionIntro />
            <Rule />
            <SectionSendReceiveSwap />
            <SectionFeatures />
            <SectionNFTs />
            <Rule />
            <SectionAccessible />
            <Rule />
            <SectionPrecision />
            <Rule />
            <SectionSafety />
            <SectionOnboarding />
            <Rule />
            <SectionDetails />
            <Rule />
            <SectionFAQs />
            <CallToAction />
          </main>
        </div>
      </div>
    </>
  );
}
