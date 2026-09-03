import { OG_IMAGE_SIZE, renderOgImage } from "@/lib/ogImage";
import { SHARED_COMPUTER_PAGE_CONTENT } from "./page-content";

// Required for `output: "export"`: this image never varies per-request, so
// it's rendered once at build time into a static file, same as any other
// static asset.
export const dynamic = "force-static";

export const alt = `Chatticus — ${SHARED_COMPUTER_PAGE_CONTENT.ogTitle}`;
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default function Image() {
  return renderOgImage({
    headline: SHARED_COMPUTER_PAGE_CONTENT.ogHeadline,
    tagline: SHARED_COMPUTER_PAGE_CONTENT.ogTagline,
  });
}
