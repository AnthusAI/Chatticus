import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BlogPostView } from "@/components/blog/BlogPost";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { getPost, buildStaticParams, isStaticExportPlaceholder, postPath } from "@/lib/blog";

export const dynamicParams = false;

type AgentZooPostPageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateStaticParams(): Promise<{ slug: string }[]> {
  return buildStaticParams("agent-zoo");
}

export async function generateMetadata({ params }: AgentZooPostPageProps): Promise<Metadata> {
  const { slug } = await params;
  if (isStaticExportPlaceholder(slug)) {
    notFound();
  }
  const post = getPost("agent-zoo", slug);
  if (!post || post.frontmatter.draft) {
    return {};
  }

  const canonical = postPath("agent-zoo", slug);

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

export default async function AgentZooPostPage({ params }: AgentZooPostPageProps) {
  const { slug } = await params;
  if (isStaticExportPlaceholder(slug)) {
    notFound();
  }
  const post = getPost("agent-zoo", slug);
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
