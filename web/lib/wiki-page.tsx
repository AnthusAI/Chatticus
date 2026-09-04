import type { Metadata } from "next";
import { notFound } from "next/navigation";
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
        <article className="bg-surface">
          <div className="mx-auto max-w-[92rem] px-5 py-20 sm:px-8 sm:py-28 lg:px-12">
            <h1 className="max-w-4xl font-display text-[clamp(3rem,7vw,6rem)] leading-[0.9] tracking-[-0.06em]">
              {page.frontmatter.title}
            </h1>
            <p className="mt-8 max-w-2xl font-body text-lg leading-relaxed text-ink-soft">
              {page.frontmatter.description}
            </p>
          </div>
        </article>
      </main>
      <Footer />
    </>
  );
}
