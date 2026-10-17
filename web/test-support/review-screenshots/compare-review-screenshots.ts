import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { chromium, type Page } from "playwright";

import type { CaptureManifest, CapturedShot } from "./capture-review-screenshots";

/**
 * Compares the shots of a pull request with the same shots of its base branch, pixel by pixel in a headless page,
 * so the gallery can lead with what changed. A shot counts as changed when more than a small share of its pixels
 * differ by more than a small amount, which ignores antialiasing noise and still catches a moved button.
 */

const CHANNEL_DIFFERENCE_TOLERANCE = 24;
const CHANGED_PIXEL_SHARE_THRESHOLD = 0.0005;

export type ShotComparisonStatus = "changed" | "unchanged" | "new" | "removed";

export type ShotComparison = CapturedShot & {
  status: ShotComparisonStatus;
  changedPixelShare: number | null;
};

export type ComparisonReport = {
  comparisons: ShotComparison[];
  headSkipped: CaptureManifest["skipped"];
  headUnansweredRoutes: string[];
  headPageErrors: string[];
};

function readManifest(directory: string): CaptureManifest | null {
  const manifestPath = join(directory, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  return JSON.parse(readFileSync(manifestPath, "utf8")) as CaptureManifest;
}

function pngDataUrl(path: string): string {
  return `data:image/png;base64,${readFileSync(path).toString("base64")}`;
}

const CHANGED_PIXEL_SHARE_IN_PAGE = `async ({ baseUrl, headUrl, tolerance }) => {
  const loadImage = (source) => new Promise((resolveImage, rejectImage) => {
    const image = new Image();
    image.onload = () => resolveImage(image);
    image.onerror = () => rejectImage(new Error("image failed to load"));
    image.src = source;
  });
  const pixelsOf = (image) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const drawing = canvas.getContext("2d");
    drawing.drawImage(image, 0, 0);
    return drawing.getImageData(0, 0, image.width, image.height).data;
  };
  const [baseImage, headImage] = await Promise.all([loadImage(baseUrl), loadImage(headUrl)]);
  if (baseImage.width !== headImage.width || baseImage.height !== headImage.height) return 1;
  const basePixels = pixelsOf(baseImage);
  const headPixels = pixelsOf(headImage);
  let changedPixels = 0;
  for (let offset = 0; offset < basePixels.length; offset += 4) {
    if (
      Math.abs(basePixels[offset] - headPixels[offset]) > tolerance ||
      Math.abs(basePixels[offset + 1] - headPixels[offset + 1]) > tolerance ||
      Math.abs(basePixels[offset + 2] - headPixels[offset + 2]) > tolerance
    ) changedPixels += 1;
  }
  return changedPixels / (basePixels.length / 4);
}`;

async function changedPixelShareOf(page: Page, basePath: string, headPath: string): Promise<number> {
  const inputs = { baseUrl: pngDataUrl(basePath), headUrl: pngDataUrl(headPath), tolerance: CHANNEL_DIFFERENCE_TOLERANCE };
  return page.evaluate(`(${CHANGED_PIXEL_SHARE_IN_PAGE})(${JSON.stringify(inputs)})`) as Promise<number>;
}

async function compareReviewScreenshots(baseDirectory: string, headDirectory: string): Promise<ComparisonReport> {
  const headManifest = readManifest(headDirectory);
  if (headManifest === null) throw new Error(`No manifest.json in ${headDirectory}.`);
  const baseManifest = readManifest(baseDirectory);
  const baseShotsByFileName = new Map((baseManifest?.shots ?? []).map((shot) => [shot.fileName, shot]));
  const headFileNames = new Set(headManifest.shots.map((shot) => shot.fileName));
  const comparisons: ShotComparison[] = [];
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const headShot of headManifest.shots) {
      if (!baseShotsByFileName.has(headShot.fileName)) {
        comparisons.push({ ...headShot, status: "new", changedPixelShare: null });
        continue;
      }
      const changedPixelShare = await changedPixelShareOf(page, join(baseDirectory, headShot.fileName), join(headDirectory, headShot.fileName));
      comparisons.push({
        ...headShot,
        status: changedPixelShare > CHANGED_PIXEL_SHARE_THRESHOLD ? "changed" : "unchanged",
        changedPixelShare,
      });
    }
  } finally {
    await browser.close();
  }
  for (const baseShot of baseShotsByFileName.values()) {
    if (!headFileNames.has(baseShot.fileName)) comparisons.push({ ...baseShot, status: "removed", changedPixelShare: null });
  }
  return {
    comparisons,
    headSkipped: headManifest.skipped,
    headUnansweredRoutes: headManifest.unansweredRoutes,
    headPageErrors: headManifest.pageErrors,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      head: { type: "string" },
      output: { type: "string" },
    },
  });
  if (!values.base || !values.head || !values.output) {
    throw new Error("Usage: compare-review-screenshots --base <base shots> --head <head shots> --output <report.json>");
  }
  const report = await compareReviewScreenshots(resolve(values.base), resolve(values.head));
  writeFileSync(resolve(values.output), `${JSON.stringify(report, null, 2)}\n`);
  const changedCount = report.comparisons.filter((comparison) => comparison.status === "changed").length;
  console.log(`Compared ${report.comparisons.length} shots: ${changedCount} changed.`);
}

if (process.argv[1]?.endsWith("compare-review-screenshots.ts")) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
