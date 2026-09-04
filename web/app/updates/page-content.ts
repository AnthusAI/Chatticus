/**
 * Single source for the /updates route's title/description and its social
 * preview image copy, so the two can't drift apart -- see page.tsx and
 * opengraph-image.tsx.
 */
export const UPDATES_PAGE_CONTENT = {
  title: "Updates | Chatticus",
  description:
    "Progress notes about Chatticus itself — what is live, what is proven, and what is shipping next.",
  ogTitle: "Updates",
  ogDescription:
    "Honest progress notes about Chatticus — live, proven, and shipping.",
  ogHeadline: "Progress notes about Chatticus itself.",
  ogTagline: "Live, proven, and shipping — checkable claims, not a press release.",
  badge: "Progress notes",
  mastheadTitle: "Updates",
  mastheadDescription:
    "Updates is Chatticus progress notes — what we have shipped, what we have proven in development, and what we are building next. Honest signals about the product itself, not industry commentary.",
  crossLinkBlurb: "For the wider beat on agent workplaces, see",
  crossLinkLabel: "Agent Zoo",
  crossLinkHref: "/agent-zoo",
} as const;
