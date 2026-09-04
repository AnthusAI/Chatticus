/**
 * Single source for the /agent-zoo route's title/description and its social
 * preview image copy, so the two can't drift apart -- see page.tsx and
 * opengraph-image.tsx.
 */
export const AGENT_ZOO_PAGE_CONTENT = {
  title: "Agent Zoo | Chatticus",
  description:
    "Workplaces where agents collaborate and do useful work — the category Chatticus belongs to.",
  ogTitle: "Agent Zoo",
  ogDescription:
    "The trade desk on agent workplaces — peers, patterns, and useful work in the wild.",
  ogHeadline: "Workplaces where agents collaborate and do useful work.",
  ogTagline: "Chatticus is a participant in this space, not its press office.",
  badge: "The category beat",
  mastheadTitle: "Agent Zoo",
  mastheadDescription:
    "Agent Zoo covers workplaces where agents collaborate and do useful work — software factories, bot farms, reactor chambers, and the rest of the names the industry keeps trying on the same idea. Chatticus belongs here; we write as a participant, not a detached reviewer.",
  crossLinkBlurb: "For Chatticus product progress, see",
  crossLinkLabel: "Updates",
  crossLinkHref: "/updates",
} as const;
