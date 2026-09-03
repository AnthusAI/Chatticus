import type { Metadata } from "next";
import { ControlSystem } from "@/components/ControlSystem";
import { Evidence } from "@/components/Evidence";
import { Faq } from "@/components/Faq";
import { FinalCta } from "@/components/FinalCta";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { Hero } from "@/components/Hero";
import { OrganizationStory } from "@/components/OrganizationStory";
import { RealityLedger } from "@/components/RealityLedger";
import { HOME_PAGE_CONTENT } from "./page-content";

export const metadata: Metadata = {
  title: HOME_PAGE_CONTENT.title,
  description: HOME_PAGE_CONTENT.description,
  keywords: [
    "AI teammates",
    "AI organization",
    "self-hosted AI agents",
    "agent computer",
    "AI approvals",
  ],
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: "/",
    title: HOME_PAGE_CONTENT.ogTitle,
    description: HOME_PAGE_CONTENT.ogDescription,
    siteName: "Chatticus",
    // Image comes from app/opengraph-image.tsx (renders the real logo mark
    // as a PNG at build time) -- Next injects it automatically, and Twitter
    // falls back to it too since no twitter-image file exists.
  },
  twitter: {
    card: "summary_large_image",
    title: HOME_PAGE_CONTENT.ogTitle,
    description: HOME_PAGE_CONTENT.ogDescription,
  },
};

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
