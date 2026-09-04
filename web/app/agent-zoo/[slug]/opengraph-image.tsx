import { OG_IMAGE_SIZE } from "@/lib/ogImage";
import {
  blogPostOgAlt,
  generateBlogPostStaticParams,
  renderBlogPostOgImage,
} from "@/lib/blog-post-page";

export const dynamic = "force-static";

export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

type AgentZooPostOgImageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateStaticParams() {
  return generateBlogPostStaticParams("agent-zoo");
}

export async function generateMetadata({ params }: AgentZooPostOgImageProps) {
  const { slug } = await params;
  return { alt: blogPostOgAlt("agent-zoo", slug) };
}

export default async function Image({ params }: AgentZooPostOgImageProps) {
  const { slug } = await params;
  return renderBlogPostOgImage("agent-zoo", slug);
}
