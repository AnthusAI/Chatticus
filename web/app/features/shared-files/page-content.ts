/**
 * Single source for the /features/shared-files route's title/description
 * and its social preview image copy, so the two can't drift apart -- see
 * page.tsx and opengraph-image.tsx.
 */
export const SHARED_FILES_PAGE_CONTENT = {
  title: "Shared Files | Chatticus",
  description:
    "Talking to a bot, running a computer, and reading a shared file are three separate capabilities in Chatticus, not one bundle -- and every bot reads and writes the same filing cabinet.",
  ogTitle: "Shared Files",
  ogDescription: "A bot doesn't need a computer just to touch a file. One filing cabinet, every bot can reach it.",
  ogHeadline: "A bot doesn't need a computer to touch a file.",
  ogTagline: "Talking, running a computer, and reading a file are three separate things.",
} as const;
