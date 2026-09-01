/** Build-time identity for the single-household v1 web surface. */
export const tenantId =
  process.env.NEXT_PUBLIC_CHATTICUS_TENANT_ID?.trim() || "anthus";

export const userId =
  process.env.NEXT_PUBLIC_CHATTICUS_USER_ID?.trim() || "ryan";

/** Same-origin API base; CloudFront strips the /api prefix at the origin. */
export const apiBase = "/api";
