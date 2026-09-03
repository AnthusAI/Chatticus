/**
 * Single source for the homepage's title/description and its social
 * preview image copy, so the two can't drift apart -- see page.tsx and
 * opengraph-image.tsx.
 */
export const HOME_PAGE_CONTENT = {
  title: "Chatticus | Shared spaces for people and bots",
  description:
    "Persistent, named AI teammates with memory, skills, routines, approvals, and one shared computer inside a boundary you control.",
  ogTitle: "Shared spaces for people and bots",
  ogDescription: "Named AI teammates on one shared computer, inside a boundary you own.",
  ogHeadline: "Shared spaces for people and bots.",
  ogTagline: "Named teammates. One shared computer. Human approval boundaries.",
} as const;
