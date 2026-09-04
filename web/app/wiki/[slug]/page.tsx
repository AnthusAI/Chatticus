import {
  WikiPage,
  generateWikiStaticParams,
  wikiPageMetadata,
} from "@/lib/wiki-page";

export const dynamicParams = false;

type WikiSlugPageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateStaticParams() {
  return generateWikiStaticParams();
}

export async function generateMetadata({ params }: WikiSlugPageProps) {
  const { slug } = await params;
  return wikiPageMetadata(slug);
}

export default async function WikiSlugPage({ params }: WikiSlugPageProps) {
  const { slug } = await params;
  return WikiPage({ slug });
}
