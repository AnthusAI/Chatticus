/**
 * Single source for the /wiki route's title/description and its social
 * preview image copy, so the two can't drift apart -- see page.tsx and
 * opengraph-image.tsx.
 */
export const WIKI_PAGE_CONTENT = {
  title: "Wiki | Chatticus",
  description:
    "Durable notes about agent workplaces — general ideas that stay stable, with current events linked from Updates and Agent Zoo.",
  ogTitle: "Wiki",
  ogDescription:
    "Durable notes about agent workplaces — general ideas that stay stable while the news desks move.",
  ogHeadline: "Durable notes about agent workplaces.",
  ogTagline: "General ideas, plus current events from the news desks.",
  badge: "Durable notes",
  mastheadTitle: "Wiki",
  mastheadDescription:
    "The wiki is durable notes about agent workplaces — general ideas that stay stable while Updates and Agent Zoo cover what changed. It is not a catalog of competitor products.",
} as const;
