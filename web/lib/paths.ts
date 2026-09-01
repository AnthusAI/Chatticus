/** Build org-scoped API paths for the thin-turn front door. */
export function orgApiPath(tenantId: string, suffix: string): string {
  const normalized = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `/orgs/${encodeURIComponent(tenantId)}${normalized}`;
}
