/**
 * Single source for the homepage's title/description and its social
 * preview image copy, so the two can't drift apart -- see page.tsx and
 * opengraph-image.tsx.
 */
export const HOME_PAGE_CONTENT = {
  title: "Chatticus | Build the AI organization you control",
  description:
    "Persistent, named AI teammates with memory, skills, routines, approvals, and one shared computer inside a boundary you control.",
  ogTitle: "Build the AI organization you control",
  ogDescription: "Named AI teammates on one shared computer, inside a boundary you own.",
  ogHeadline: "Build the AI organization you control.",
  ogTagline: "Named teammates. One shared computer. Human approval boundaries.",
} as const;
