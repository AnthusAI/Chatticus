# Marketing wiki

Editor guide for the chattic.us marketing wiki. Direct, clear, no hedging, no emojis.

## Wiki vs blog vs Kanbus wiki

**Wiki** — the public encyclopedia on chattic.us. Stable concepts, category names, peer products, and durable notes that should not age like a news post.

**Blog** — dated desks under `web/content/blog/`:
- **Updates** — Chatticus progress notes.
- **Agent Zoo** — the trade desk about agent workplaces (the public name for that news desk).

**Kanbus `project/wiki`** — the internal board wiki. Do not confuse it with this marketing wiki. Never edit `project/` by hand.

## Public name of the news desk

The news desk is still **Agent Zoo**. The wiki may document "model zoo" as one name in the wild for the same idea; that is not the wiki's own name.

## Voice

Warm communal register. No hedging empty-states ("coming soon", "we're just getting started"). Claims about Chatticus must be checkable.

## Frontmatter

Each page is `web/content/wiki/{slug}.md`. Required fields:

- `title`
- `description`
- `ogHeadline`
- `ogTagline`
- optional `draft` (bool)
- optional `relatedPosts` — YAML list of `category/slug` strings pointing at blog posts, for example:

```yaml
relatedPosts:
  - updates/first-week
  - agent-zoo/gastown
```

Blog posts may list wiki slugs in optional `relatedWiki`:

```yaml
relatedWiki:
  - reactor-chamber
```

Missing targets are omitted when resolving links; they must not fail the build.

## Draft research notes

`draft: true` pages live in git as research notes. They are excluded from wiki listings and from `generateStaticParams`. Remove `draft` or set `draft: false` when the page is ready to publish.

## How to publish a page

1. **Content** — Add `{slug}.md` under `web/content/wiki/`. Rebuild the site. No CMS.

2. **Page routes (first published page)** — Next.js static export (`output: "export"`) cannot emit a dynamic `[slug]` route with zero paths, so `web/app/wiki/[slug]/` is added when the first published wiki page lands. Use the shared factory in `web/lib/wiki-page.tsx`; the route is a thin wrapper.

Example `web/app/wiki/[slug]/page.tsx`:

```tsx
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
```

Example `web/app/wiki/[slug]/opengraph-image.tsx` (add with the first page):

```tsx
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
```

## Launching the wiki on the site

Do not add the wiki to the footer or header until editors decide the encyclopedia is ready to launch. Until then, `/wiki` stays `noindex` and is reachable only by direct URL.

When you launch, add a Wiki link in the footer (and header if desired), remove `robots: noindex` from `web/app/wiki/page.tsx`, and rebuild.
