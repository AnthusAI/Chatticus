/**
 * Single source for the /features/approvals route's title/description and
 * its social preview image copy, so the two can't drift apart -- see
 * page.tsx and opengraph-image.tsx.
 */
export const APPROVALS_PAGE_CONTENT = {
  title: "Approvals | Chatticus",
  description:
    "Sending, publishing, buying, deleting, and changing permissions pause at an approval boundary a person controls -- office-style authority, not a bolted-on safety switch.",
  ogTitle: "Approvals",
  ogDescription: "Consequential actions pause at a boundary a person controls, before they happen.",
  ogHeadline: "Every consequential action waits for a person.",
  ogTagline: "An approval controls what's proposed — never what's already done.",
} as const;
