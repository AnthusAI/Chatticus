import { ControlSystem } from "@/components/ControlSystem";
import { Evidence } from "@/components/Evidence";
import { Faq } from "@/components/Faq";
import { FinalCta } from "@/components/FinalCta";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { Hero } from "@/components/Hero";
import { OrganizationStory } from "@/components/OrganizationStory";
import { RealityLedger } from "@/components/RealityLedger";

export default function HomePage() {
  return (
    <>
      <Header />
      <main id="main-content">
        <Hero />
        <OrganizationStory />
        <ControlSystem />
        <Evidence />
        <RealityLedger />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </>
  );
}
