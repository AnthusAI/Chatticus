import { OG_IMAGE_SIZE, renderOgImage } from "@/lib/ogImage";
import { UPDATES_PAGE_CONTENT } from "./page-content";

export const dynamic = "force-static";

export const alt = `Chatticus — ${UPDATES_PAGE_CONTENT.ogTitle}`;
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default function Image() {
  return renderOgImage({
    headline: UPDATES_PAGE_CONTENT.ogHeadline,
    tagline: UPDATES_PAGE_CONTENT.ogTagline,
  });
}
