import { OG_IMAGE_SIZE } from "@/lib/ogImage";
import {
  generateWikiStaticParams,
  renderWikiPageOgImage,
  wikiPageOgAlt,
} from "@/lib/wiki-page";

export const dynamic = "force-static";

export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

type WikiSlugOgImageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateStaticParams() {
  return generateWikiStaticParams();
}

export async function generateMetadata({ params }: WikiSlugOgImageProps) {
  const { slug } = await params;
  return { alt: wikiPageOgAlt(slug) };
}

export default async function Image({ params }: WikiSlugOgImageProps) {
  const { slug } = await params;
  return renderWikiPageOgImage(slug);
}
