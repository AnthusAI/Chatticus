import type { Metadata } from "next";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { WikiIndex } from "@/components/wiki/WikiIndex";
import { listPages } from "@/lib/wiki";
import { WIKI_PAGE_CONTENT } from "./page-content";

export const metadata: Metadata = {
  title: WIKI_PAGE_CONTENT.title,
  description: WIKI_PAGE_CONTENT.description,
  alternates: {
    canonical: "/wiki",
  },
  openGraph: {
    type: "website",
    url: "/wiki",
    title: WIKI_PAGE_CONTENT.ogTitle,
    description: WIKI_PAGE_CONTENT.ogDescription,
    siteName: "Chatticus",
  },
  twitter: {
    card: "summary_large_image",
    title: WIKI_PAGE_CONTENT.ogTitle,
    description: WIKI_PAGE_CONTENT.ogDescription,
  },
};

export default function WikiPage() {
  const pages = listPages();

  return (
    <>
      <Header />
      <main id="main-content">
        <WikiIndex
          badge={WIKI_PAGE_CONTENT.badge}
          title={WIKI_PAGE_CONTENT.mastheadTitle}
          description={WIKI_PAGE_CONTENT.mastheadDescription}
          pages={pages}
        />
      </main>
      <Footer />
    </>
  );
}
