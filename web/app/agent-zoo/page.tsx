import type { Metadata } from "next";
import { BlogIndex } from "@/components/blog/BlogIndex";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { listPosts } from "@/lib/blog";
import { AGENT_ZOO_PAGE_CONTENT } from "./page-content";

export const metadata: Metadata = {
  title: AGENT_ZOO_PAGE_CONTENT.title,
  description: AGENT_ZOO_PAGE_CONTENT.description,
  alternates: {
    canonical: "/agent-zoo",
  },
  openGraph: {
    type: "website",
    url: "/agent-zoo",
    title: AGENT_ZOO_PAGE_CONTENT.ogTitle,
    description: AGENT_ZOO_PAGE_CONTENT.ogDescription,
    siteName: "Chatticus",
  },
  twitter: {
    card: "summary_large_image",
    title: AGENT_ZOO_PAGE_CONTENT.ogTitle,
    description: AGENT_ZOO_PAGE_CONTENT.ogDescription,
  },
};

export default function AgentZooPage() {
  const posts = listPosts("agent-zoo");

  return (
    <>
      <Header />
      <main id="main-content">
        <BlogIndex
          category="agent-zoo"
          badge={AGENT_ZOO_PAGE_CONTENT.badge}
          title={AGENT_ZOO_PAGE_CONTENT.mastheadTitle}
          description={AGENT_ZOO_PAGE_CONTENT.mastheadDescription}
          crossLink={{
            label: AGENT_ZOO_PAGE_CONTENT.crossLinkLabel,
            href: AGENT_ZOO_PAGE_CONTENT.crossLinkHref,
            blurb: AGENT_ZOO_PAGE_CONTENT.crossLinkBlurb,
          }}
          posts={posts}
        />
      </main>
      <Footer />
    </>
  );
}
