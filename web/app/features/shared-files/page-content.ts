/**
 * Single source for the /features/shared-files route's title/description
 * and its social preview image copy, so the two can't drift apart -- see
 * page.tsx and opengraph-image.tsx.
 */
export const SHARED_FILES_PAGE_CONTENT = {
  title: "Shared Files | Chatticus",
  description:
    "One filing cabinet every bot and person in the organization can reach -- not a separate inbox or folder per bot, no re-uploading, no siloed copies.",
  ogTitle: "Shared Files",
  ogDescription: "One filing cabinet every bot can reach. No siloed copies, no re-uploading.",
  ogHeadline: "One filing cabinet. Every bot can reach it.",
  ogTagline: "A file one bot saves, the next bot can already see.",
} as const;
