import { ImageResponse } from "next/og";
import { CHATTICUS_MARK_MODEL } from "anthus-vultus";

/**
 * Shared renderer behind every route's `opengraph-image.tsx`, so each page
 * can hand it its own headline/tagline instead of every shared link on the
 * site showing the homepage's pitch. See app/opengraph-image.tsx and
 * app/chat/opengraph-image.tsx for the per-route usage.
 */

export const OG_IMAGE_SIZE = { width: 1200, height: 630 };

const PAPER = "#f2efe7";
const INK = "#11130f";
const CLAY = "#ef6a47";
/** Matches Wordmark.tsx's light-mode SHADOW_BUBBLE_LIGHT -- this card only ever renders the light colorway. */
const SHADOW_BUBBLE = "#cbc4ad";

/** The mark's two bubbles are the only "path" body shapes it has; this pulls their `d` strings straight from the real model instead of hand-copying coordinates. */
function bubblePathD(index: 0 | 1): string {
  const shape = CHATTICUS_MARK_MODEL.body[index];
  if (shape.kind !== "path") {
    throw new Error(`Expected CHATTICUS_MARK_MODEL.body[${index}] to be a path shape`);
  }
  return shape.d;
}

export type OgImageContent = {
  /** The big line -- what this specific page is about, not a site-wide tagline. */
  headline: string;
  /** The pill underneath -- a short, concrete supporting detail. */
  tagline: string;
};

export function renderOgImage({ headline, tagline }: OgImageContent) {
  const { leftEye, rightEye } = CHATTICUS_MARK_MODEL.features;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          padding: "0 80px",
          background: PAPER,
        }}
      >
        <svg width={300} height={300} viewBox="0 0 28 28" style={{ flexShrink: 0 }}>
          <path d={bubblePathD(0)} fill={SHADOW_BUBBLE} />
          <path d={bubblePathD(1)} fill={CLAY} />
          <circle cx={leftEye.cx} cy={leftEye.cy} r={2} fill={PAPER} />
          <circle cx={rightEye.cx} cy={rightEye.cy} r={2} fill={PAPER} />
        </svg>
        <div style={{ display: "flex", flexDirection: "column", width: 660, marginLeft: 56 }}>
          <div style={{ display: "flex", fontSize: 34, fontWeight: 800, color: INK, letterSpacing: "-0.03em" }}>
            <span>Chatticus</span>
            <span style={{ color: CLAY }}>.</span>
          </div>
          <div
            style={{
              display: "flex",
              width: "100%",
              fontSize: 54,
              fontWeight: 700,
              color: INK,
              marginTop: 18,
              lineHeight: 1.12,
            }}
          >
            {headline}
          </div>
          <div
            style={{
              display: "flex",
              width: "100%",
              fontSize: 24,
              color: PAPER,
              background: INK,
              marginTop: 28,
              padding: "16px 24px",
              borderRadius: 28,
              lineHeight: 1.3,
            }}
          >
            {tagline}
          </div>
        </div>
      </div>
    ),
    { ...OG_IMAGE_SIZE },
  );
}
