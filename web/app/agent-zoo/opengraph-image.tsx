import { OG_IMAGE_SIZE, renderOgImage } from "@/lib/ogImage";
import { AGENT_ZOO_PAGE_CONTENT } from "./page-content";

export const dynamic = "force-static";

export const alt = `Chatticus — ${AGENT_ZOO_PAGE_CONTENT.ogTitle}`;
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default function Image() {
  return renderOgImage({
    headline: AGENT_ZOO_PAGE_CONTENT.ogHeadline,
    tagline: AGENT_ZOO_PAGE_CONTENT.ogTagline,
  });
}
