import type { Metadata } from "next";
import { MarkdownContent } from "@/components/content/MarkdownContent";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { PRIVACY_PAGE_CONTENT } from "./page-content";

export const metadata: Metadata = {
  title: PRIVACY_PAGE_CONTENT.title,
  description: PRIVACY_PAGE_CONTENT.description,
  alternates: {
    canonical: "/privacy",
  },
  openGraph: {
    type: "website",
    url: "/privacy",
    title: PRIVACY_PAGE_CONTENT.ogTitle,
    description: PRIVACY_PAGE_CONTENT.ogDescription,
    siteName: "Chatticus",
  },
  twitter: {
    card: "summary_large_image",
    title: PRIVACY_PAGE_CONTENT.ogTitle,
    description: PRIVACY_PAGE_CONTENT.ogDescription,
  },
};

export default function PrivacyPage() {
  return (
    <>
      <Header />
      <main id="main-content">
        <section className="bg-surface">
          <div className="mx-auto max-w-[92rem] px-5 py-20 sm:px-8 sm:py-28 lg:px-12">
            <h1 className="max-w-4xl font-display text-[clamp(3rem,7vw,5.5rem)] leading-[0.9] tracking-[-0.06em]">
              Privacy Policy
            </h1>
            <p className="mt-6 max-w-2xl font-body text-lg leading-relaxed text-ink-soft">
              Effective during the Chatticus public beta. Last updated September
              2026.
            </p>
            <div className="mt-12">
              <MarkdownContent>{PRIVACY_PAGE_CONTENT.body}</MarkdownContent>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
