/**
 * Single source for the /chat route's title/description and its social
 * preview image copy, so the two can't drift apart -- see page.tsx and
 * opengraph-image.tsx.
 */
export const CHAT_PAGE_CONTENT = {
  title: "Chatticus | Your shared AI workspace",
  description: "Sign in to work alongside your named AI teammates on one shared computer.",
  ogTitle: "Your shared AI workspace",
  ogDescription: "Sign in to work alongside your named AI teammates on one shared computer.",
  ogHeadline: "Sign in to your workspace.",
  ogTagline: "Named teammates, memory, and approvals — all in one room.",
} as const;
