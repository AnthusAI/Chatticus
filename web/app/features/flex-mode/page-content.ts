/**
 * Single source for the /features/flex-mode route's title/description and
 * its social preview image copy, so the two can't drift apart -- see
 * page.tsx and opengraph-image.tsx.
 */
export const FLEX_MODE_PAGE_CONTENT = {
  title: "Flex Mode | Chatticus",
  description:
    "Your background bots don't need to be fast, they need to be cheap and right. Flex Mode routes patient work through the same model, on a cheaper lane.",
  ogTitle: "Flex Mode",
  ogDescription: "Your background bots don't need to be fast, they need to be cheap and right.",
  ogHeadline: "Your bots don't need to be fast. They need to be cheap and right.",
  ogTagline: "Same model, same prompt — just scheduled with patience instead of urgency.",
} as const;
