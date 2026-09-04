import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BlogPostView } from "@/components/blog/BlogPost";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { renderOgImage } from "@/lib/ogImage";
import { getPost, listPosts, postPath, type BlogCategory } from "@/lib/blog";

export function generateBlogPostStaticParams(category: BlogCategory): { slug: string }[] {
  return listPosts(category).map((post) => ({ slug: post.slug }));
}

export function blogPostMetadata(category: BlogCategory, slug: string): Metadata {
  const post = getPost(category, slug);
  if (!post || post.frontmatter.draft) {
    return {};
  }

  const canonical = postPath(category, slug);

  return {
    title: `${post.frontmatter.title} | Chatticus`,
    description: post.frontmatter.description,
    alternates: {
      canonical,
    },
    openGraph: {
      type: "article",
      url: canonical,
      title: post.frontmatter.title,
      description: post.frontmatter.description,
      siteName: "Chatticus",
    },
    twitter: {
      card: "summary_large_image",
      title: post.frontmatter.title,
      description: post.frontmatter.description,
    },
  };
}

export function blogPostOgAlt(category: BlogCategory, slug: string): string {
  const post = getPost(category, slug);
  if (!post) {
    return "Chatticus";
  }
  return `Chatticus — ${post.frontmatter.title}`;
}

export function renderBlogPostOgImage(category: BlogCategory, slug: string) {
  const post = getPost(category, slug);
  if (!post) {
    throw new Error(`Missing ${category} post for OG image: ${slug}`);
  }

  return renderOgImage({
    headline: post.frontmatter.ogHeadline,
    tagline: post.frontmatter.ogTagline,
  });
}

type BlogPostPageProps = {
  category: BlogCategory;
  slug: string;
};

export async function BlogPostPage({ category, slug }: BlogPostPageProps) {
  const post = getPost(category, slug);
  if (!post || post.frontmatter.draft) {
    notFound();
  }

  return (
    <>
      <Header />
      <main id="main-content">
        <BlogPostView post={post} />
      </main>
      <Footer />
    </>
  );
}
