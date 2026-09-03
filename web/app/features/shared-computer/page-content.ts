/**
 * Single source for the /features/shared-computer route's title/
 * description and its social preview image copy, so the two can't drift
 * apart -- see page.tsx and opengraph-image.tsx.
 */
export const SHARED_COMPUTER_PAGE_CONTENT = {
  title: "Shared Computer | Chatticus",
  description:
    "Every bot in an organization works on one computer -- same browser sessions, same credentials, same files -- instead of one login and one machine per bot.",
  ogTitle: "Shared Computer",
  ogDescription: "One computer for the whole organization. No clones. No per-bot logins to manage.",
  ogHeadline: "One computer. Every bot already signed in.",
  ogTagline: "Same sessions, same credentials, same files — no clones, no per-bot logins.",
} as const;
