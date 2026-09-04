# News desk: Updates and Agent Zoo

Editor guide for the chattic.us marketing blog. Direct, clear, no hedging, no emojis.

## The beat

A product category is forming: persistent multi-agent workplaces — named bots that hold jobs, share a computer, run in the background, and do useful work together. One good picture of the same idea: a reactor chamber for AI agents to collaborate and do useful work. The industry has not settled on a word. The thing is stable; the jargon moves.

## Public name is Agent Zoo

That is Chatticus's name for the category desk. Never name the blog "Model Zoo" or "the model zoo."

## Synonyms the desk covers

These are names you will see in the wild for the same idea. They are not names for the blog. Keep this as a living list; extend it when a new coinage names the same workplace where agents collaborate and do useful work:

- software factory
- bot farm
- model zoo (one name in the wild; not ours)
- agent org
- reactor chamber
- foundry
- shop floor
- yard (as in shipyard: concurrent work in one place)
- studio

Add further synonyms when they name the same idea: a workplace where agents collaborate and do useful work.

Sourced research (unpublished draft): `web/content/wiki/names-for-the-workplace.md`.

## Who is in the zoo

Coverage includes Chatticus and peers such as Gastown, Grok Bot, and PostHog's agent/cowork work, plus new entries as they appear. This desk MAY name third-party products. That does NOT license renaming Chatticus bots, the computer, skills, routines, or the worker protocol after them. Root `AGENTS.md` still holds for product code.

## Updates vs Agent Zoo

**Updates** — Chatticus's own progress notes. Honesty like `docs/FEATURE_PAGES_BRIEF.md` (live / proven / shipping). Checkable claims.

**Agent Zoo** — the trade desk about the category. Chatticus product changelog does not belong here. Generic LLM or model-release news does not belong unless it changes how a farm actually runs.

## Voice

Chatticus is a participant, not a press office and not an outside reviewer of itself. Warm communal register ("people and bots"). No hedging empty-states ("coming soon", "we're just getting started"). At most one "X, not Y" contrast per page. Claims about Chatticus must be checkable.

## How to publish

1. **Content** — Add `{slug}.md` under `web/content/blog/updates/` or `web/content/blog/agent-zoo/`. Category is the **folder**, not frontmatter. Frontmatter: `title`, `date`, `description`, `ogHeadline`, `ogTagline`, optional `draft`. `draft: true` is excluded from listings. Rebuild the site. No CMS.

2. **Post routes (first published post in a category)** — Next.js static export (`output: "export"`) cannot emit a dynamic `[slug]` route with zero paths, so `web/app/<category>/[slug]/` is added when the first published post in that category lands. Use the shared factory in `web/lib/blog-post-page.tsx`; each category page is a thin wrapper.

Example `web/app/updates/[slug]/page.tsx`:

```tsx
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
```

Example `web/app/updates/[slug]/opengraph-image.tsx` (add with the first post):

```tsx
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
```

Mirror the category name (`updates` or `agent-zoo`) in both files. Remove `[slug]/` only if a category returns to zero published posts (unlikely); otherwise keep it and let `generateStaticParams` track real slugs.
