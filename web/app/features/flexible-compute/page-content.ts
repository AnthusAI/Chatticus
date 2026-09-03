/**
 * Single source for the /features/flexible-compute route's title/
 * description and its social preview image copy, so the two can't drift
 * apart -- see page.tsx and opengraph-image.tsx.
 */
export const FLEXIBLE_COMPUTE_PAGE_CONTENT = {
  title: "Flexible Compute | Chatticus",
  description:
    "Every bot shares the same files, but the compute underneath is picked for the task -- a light container for browsing, more for heavier work -- not one fixed machine for everyone.",
  ogTitle: "Flexible Compute",
  ogDescription: "The files are shared. The compute is picked for the task, not fixed for everyone.",
  ogHeadline: "The files are shared. The compute isn't fixed.",
  ogTagline: "A light container for browsing, more for heavier work — chosen per task.",
} as const;
