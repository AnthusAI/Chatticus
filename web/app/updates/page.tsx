import type { Metadata } from "next";
import { BlogIndex } from "@/components/blog/BlogIndex";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { listPosts } from "@/lib/blog";
import { UPDATES_PAGE_CONTENT } from "./page-content";

export const metadata: Metadata = {
  title: UPDATES_PAGE_CONTENT.title,
  description: UPDATES_PAGE_CONTENT.description,
  alternates: {
    canonical: "/updates",
  },
  openGraph: {
    type: "website",
    url: "/updates",
    title: UPDATES_PAGE_CONTENT.ogTitle,
    description: UPDATES_PAGE_CONTENT.ogDescription,
    siteName: "Chatticus",
  },
  twitter: {
    card: "summary_large_image",
    title: UPDATES_PAGE_CONTENT.ogTitle,
    description: UPDATES_PAGE_CONTENT.ogDescription,
  },
};

export default function UpdatesPage() {
  const posts = listPosts("updates");

  return (
    <>
      <Header />
      <main id="main-content">
        <BlogIndex
          category="updates"
          badge={UPDATES_PAGE_CONTENT.badge}
          title={UPDATES_PAGE_CONTENT.mastheadTitle}
          description={UPDATES_PAGE_CONTENT.mastheadDescription}
          crossLink={{
            label: UPDATES_PAGE_CONTENT.crossLinkLabel,
            href: UPDATES_PAGE_CONTENT.crossLinkHref,
            blurb: UPDATES_PAGE_CONTENT.crossLinkBlurb,
          }}
          posts={posts}
        />
      </main>
      <Footer />
    </>
  );
}
