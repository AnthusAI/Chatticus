const ALLOWED_LINK_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"]);

/**
 * The link target when it is an absolute http, https or mailto URL, else null.
 * Relative links, javascript:, data: and every other scheme are refused.
 */
export function safeLinkTarget(href: string | null | undefined): string | null {
  if (typeof href !== "string") {
    return null;
  }
  const trimmed = href.trim();
  if (trimmed === "") {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    return ALLOWED_LINK_PROTOCOLS.has(parsed.protocol) ? trimmed : null;
  } catch {
    return null;
  }
}
