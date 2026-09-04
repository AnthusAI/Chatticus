import {
  BlogPostPage,
  blogPostMetadata,
  generateBlogPostStaticParams,
} from "@/lib/blog-post-page";

export const dynamicParams = false;

type UpdatesPostPageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateStaticParams() {
  return generateBlogPostStaticParams("updates");
}

export async function generateMetadata({ params }: UpdatesPostPageProps) {
  const { slug } = await params;
  return blogPostMetadata("updates", slug);
}

export default async function UpdatesPostPage({ params }: UpdatesPostPageProps) {
  const { slug } = await params;
  return BlogPostPage({ category: "updates", slug });
}
