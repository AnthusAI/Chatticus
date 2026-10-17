import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { REVIEW_SCREENS, REVIEW_VIEWPORTS, type ReviewColorScheme } from "./review-screenshot-screens";
import type { ComparisonReport, ShotComparison } from "./compare-review-screenshots";

/**
 * Writes the pull request comment that carries the review gallery. It is read on a phone or tablet as often as on
 * a desktop, so it leads with the changed screens side by side with the base branch, then one grid of every screen
 * in light mode, with dark mode and the diagnostics folded away.
 */

export const REVIEW_SCREENSHOT_COMMENT_MARKER = "<!-- review-screenshots -->";

const SIDE_BY_SIDE_IMAGE_WIDTH = 360;
const GRID_IMAGE_WIDTH = 180;

type CommentInputs = {
  report: ComparisonReport;
  headImageBaseUrl: string;
  baseImageBaseUrl: string;
  baseBranchName: string;
  headCommitSha: string;
  runUrl: string;
};

function image(url: string, alt: string, width: number): string {
  return `<a href="${url}"><img src="${url}" alt="${alt}" width="${width}"></a>`;
}

function shotTitle(comparison: ShotComparison): string {
  return `${comparison.screenLabel}, ${comparison.viewportLabel}, ${comparison.colorScheme}`;
}

function percentText(share: number | null): string {
  if (share === null) return "";
  return `${(share * 100).toFixed(share < 0.01 ? 2 : 1)}% of pixels`;
}

function changedSection(inputs: CommentInputs, changed: ShotComparison[]): string[] {
  if (changed.length === 0) return [];
  const lines = ["### What changed", ""];
  for (const comparison of changed) {
    lines.push(`**${shotTitle(comparison)}**${comparison.status === "new" ? " (new screen)" : ` (${percentText(comparison.changedPixelShare)})`}`, "");
    const headCell = image(`${inputs.headImageBaseUrl}/${comparison.fileName}`, `${shotTitle(comparison)} in this pull request`, SIDE_BY_SIDE_IMAGE_WIDTH);
    if (comparison.status === "new") {
      lines.push(headCell, "");
      continue;
    }
    const baseCell = image(`${inputs.baseImageBaseUrl}/${comparison.fileName}`, `${shotTitle(comparison)} on ${inputs.baseBranchName}`, SIDE_BY_SIDE_IMAGE_WIDTH);
    lines.push(`| ${inputs.baseBranchName} | This pull request |`, "| --- | --- |", `| ${baseCell} | ${headCell} |`, "");
  }
  return lines;
}

function gridSection(inputs: CommentInputs, colorScheme: ReviewColorScheme): string[] {
  const headShots = new Map(
    inputs.report.comparisons
      .filter((comparison) => comparison.status !== "removed" && comparison.colorScheme === colorScheme)
      .map((comparison) => [`${comparison.screenId}--${comparison.viewportId}`, comparison]),
  );
  const lines = [
    `| Screen | ${REVIEW_VIEWPORTS.map((viewport) => viewport.label).join(" | ")} |`,
    `| --- | ${REVIEW_VIEWPORTS.map(() => "---").join(" | ")} |`,
  ];
  for (const screen of REVIEW_SCREENS) {
    const cells = REVIEW_VIEWPORTS.map((viewport) => {
      const comparison = headShots.get(`${screen.id}--${viewport.id}`);
      if (!comparison) return "";
      const marker = comparison.status === "changed" || comparison.status === "new" ? "<br>changed" : "";
      return `${image(`${inputs.headImageBaseUrl}/${comparison.fileName}`, shotTitle(comparison), GRID_IMAGE_WIDTH)}${marker}`;
    });
    if (cells.every((cell) => cell === "")) continue;
    lines.push(`| ${screen.label} | ${cells.join(" | ")} |`);
  }
  return lines;
}

function diagnosticsSection(report: ComparisonReport): string[] {
  const failedShots = report.headSkipped.filter((skipped) => skipped.reason !== "not shown at this size");
  const notes = [
    ...failedShots.map((skipped) => `- Could not take ${skipped.screenId} at ${skipped.viewportId} (${skipped.colorScheme}): ${skipped.reason}`),
    ...report.headUnansweredRoutes.map((route) => `- The fake workspace has no answer for \`${route}\``),
    ...report.headPageErrors.map((pageError) => `- Page error: ${pageError}`),
  ];
  if (notes.length === 0) return [];
  return ["<details><summary>Notes from the screenshot run</summary>", "", ...notes, "", "</details>", ""];
}

/** The markdown body of the gallery comment. */
export function reviewScreenshotCommentBody(inputs: CommentInputs): string {
  const changed = inputs.report.comparisons.filter((comparison) => comparison.status === "changed" || comparison.status === "new");
  const removed = inputs.report.comparisons.filter((comparison) => comparison.status === "removed");
  const lightChanged = changed.filter((comparison) => comparison.colorScheme === "light");
  const darkChanged = changed.filter((comparison) => comparison.colorScheme === "dark");
  const shownCount = inputs.report.comparisons.filter((comparison) => comparison.status !== "removed").length;
  const summary =
    changed.length === 0
      ? `None of the ${shownCount} screenshots differ from \`${inputs.baseBranchName}\`.`
      : `${changed.length} of ${shownCount} screenshots differ from \`${inputs.baseBranchName}\`.`;
  return [
    REVIEW_SCREENSHOT_COMMENT_MARKER,
    "## Screenshots",
    "",
    `${summary} Taken from ${inputs.headCommitSha.slice(0, 7)} with seeded demo data. Tap any image for full size.`,
    "",
    ...changedSection(inputs, lightChanged),
    ...(darkChanged.length > 0 ? ["<details><summary>Dark mode changes</summary>", "", ...changedSection(inputs, darkChanged), "</details>", ""] : []),
    ...(removed.length > 0 ? [`Screens no longer taken: ${removed.map(shotTitle).join("; ")}.`, ""] : []),
    "### Every screen, light mode",
    "",
    ...gridSection(inputs, "light"),
    "",
    "<details><summary>Every screen, dark mode</summary>",
    "",
    ...gridSection(inputs, "dark"),
    "",
    "</details>",
    "",
    ...diagnosticsSection(inputs.report),
    `<sub>[Screenshot run](${inputs.runUrl})</sub>`,
    "",
  ].join("\n");
}

function main(): void {
  const { values } = parseArgs({
    options: {
      report: { type: "string" },
      output: { type: "string" },
      "head-image-base-url": { type: "string" },
      "base-image-base-url": { type: "string" },
      "base-branch": { type: "string" },
      "head-sha": { type: "string" },
      "run-url": { type: "string" },
    },
  });
  const required = ["report", "output", "head-image-base-url", "base-image-base-url", "base-branch", "head-sha", "run-url"] as const;
  const missing = required.filter((name) => !values[name]);
  if (missing.length > 0) throw new Error(`Missing --${missing.join(", --")}.`);
  const body = reviewScreenshotCommentBody({
    report: JSON.parse(readFileSync(resolve(values.report!), "utf8")) as ComparisonReport,
    headImageBaseUrl: values["head-image-base-url"]!,
    baseImageBaseUrl: values["base-image-base-url"]!,
    baseBranchName: values["base-branch"]!,
    headCommitSha: values["head-sha"]!,
    runUrl: values["run-url"]!,
  });
  writeFileSync(resolve(values.output!), body);
}

if (process.argv[1]?.endsWith("write-review-screenshot-comment.ts")) {
  main();
}
