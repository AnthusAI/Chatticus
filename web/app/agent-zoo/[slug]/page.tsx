import {
  BlogPostPage,
  blogPostMetadata,
  generateBlogPostStaticParams,
} from "@/lib/blog-post-page";

export const dynamicParams = false;

type AgentZooPostPageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateStaticParams() {
  return generateBlogPostStaticParams("agent-zoo");
}

export async function generateMetadata({ params }: AgentZooPostPageProps) {
  const { slug } = await params;
  return blogPostMetadata("agent-zoo", slug);
}

export default async function AgentZooPostPage({ params }: AgentZooPostPageProps) {
  const { slug } = await params;
  return BlogPostPage({ category: "agent-zoo", slug });
}
