import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { WikiPageView } from "@/components/wiki/WikiPageView";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { renderOgImage } from "@/lib/ogImage";
import { getPage, listPages, wikiPagePath } from "@/lib/wiki";

export function generateWikiStaticParams(): { slug: string }[] {
  return listPages().map((page) => ({ slug: page.slug }));
}

export function wikiPageMetadata(slug: string): Metadata {
  const page = getPage(slug);
  if (!page || page.frontmatter.draft) {
    return {};
  }

  const canonical = wikiPagePath(slug);

  return {
    title: `${page.frontmatter.title} | Chatticus`,
    description: page.frontmatter.description,
    alternates: {
      canonical,
    },
    openGraph: {
      type: "article",
      url: canonical,
      title: page.frontmatter.title,
      description: page.frontmatter.description,
      siteName: "Chatticus",
    },
    twitter: {
      card: "summary_large_image",
      title: page.frontmatter.title,
      description: page.frontmatter.description,
    },
  };
}

export function wikiPageOgAlt(slug: string): string {
  const page = getPage(slug);
  if (!page) {
    return "Chatticus";
  }
  return `Chatticus — ${page.frontmatter.title}`;
}

export function renderWikiPageOgImage(slug: string) {
  const page = getPage(slug);
  if (!page) {
    throw new Error(`Missing wiki page for OG image: ${slug}`);
  }

  return renderOgImage({
    headline: page.frontmatter.ogHeadline,
    tagline: page.frontmatter.ogTagline,
  });
}

type WikiPageProps = {
  slug: string;
};

export async function WikiPage({ slug }: WikiPageProps) {
  const page = getPage(slug);
  if (!page || page.frontmatter.draft) {
    notFound();
  }

  return (
    <>
      <Header />
      <main id="main-content">
        <WikiPageView page={page} />
      </main>
      <Footer />
    </>
  );
}
