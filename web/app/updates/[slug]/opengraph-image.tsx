import { OG_IMAGE_SIZE } from "@/lib/ogImage";
import {
  blogPostOgAlt,
  generateBlogPostStaticParams,
  renderBlogPostOgImage,
} from "@/lib/blog-post-page";

export const dynamic = "force-static";

export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

type UpdatesPostOgImageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateStaticParams() {
  return generateBlogPostStaticParams("updates");
}

export async function generateMetadata({ params }: UpdatesPostOgImageProps) {
  const { slug } = await params;
  return { alt: blogPostOgAlt("updates", slug) };
}

export default async function Image({ params }: UpdatesPostOgImageProps) {
  const { slug } = await params;
  return renderBlogPostOgImage("updates", slug);
}
