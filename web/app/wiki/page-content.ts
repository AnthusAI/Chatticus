/**
 * Single source for the /wiki route's title/description and its social
 * preview image copy, so the two can't drift apart -- see page.tsx and
 * opengraph-image.tsx.
 */
export const WIKI_PAGE_CONTENT = {
  title: "Wiki | Chatticus",
  description:
    "Durable notes about agent workplaces — names for the category, peer products, and concepts that stay stable while the news desk moves.",
  ogTitle: "Wiki",
  ogDescription:
    "Durable notes about agent workplaces — stable names, peers, and concepts.",
  ogHeadline: "Durable notes about agent workplaces.",
  ogTagline: "Stable encyclopedia entries for names, peers, and concepts.",
  badge: "Durable notes",
  mastheadTitle: "Wiki",
  mastheadDescription:
    "The wiki is durable notes about agent workplaces — reactor chambers, software factories, and the other names people use for places where agents collaborate and do useful work. Entries stay stable while Updates and Agent Zoo cover what changed this week.",
} as const;
