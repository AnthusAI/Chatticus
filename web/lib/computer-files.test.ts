import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FilesApiError,
  LISTING_ENTRY_LIMIT,
  MASKED_FILE_MESSAGE,
  advanceRangeState,
  asOfLabel,
  base64ToBytes,
  binaryFileLabel,
  buildBreadcrumbs,
  buildListingView,
  classifyFirstRange,
  describeFilesError,
  filesQuery,
  formatFileSize,
  formatRelativeTime,
  normalizeWorkspacePath,
  parentDirectory,
  rangeChangedUnderneath,
  shortenHash,
  sniffImageType,
  sortEntries,
  startRangeState,
  type FileEntry,
} from "./computer-files";
import {
  TINY_PNG_BASE64,
  binaryFileRange,
  emptyListing,
  imageFileRange,
  maskedFileRange,
  textFileRange,
  workspaceListing,
} from "./computer-files-fixtures";

describe("normalizeWorkspacePath", () => {
  it("keeps clean absolute workspace paths", () => {
    assert.equal(normalizeWorkspacePath("/workspace"), "/workspace");
    assert.equal(normalizeWorkspacePath("/workspace/src/a.ts"), "/workspace/src/a.ts");
  });

  it("collapses duplicate slashes, dots and trailing slashes", () => {
    assert.equal(normalizeWorkspacePath("/workspace//src/./a.ts/"), "/workspace/src/a.ts");
    assert.equal(normalizeWorkspacePath("/workspace/src/../docs"), "/workspace/docs");
  });

  it("treats relative paths as relative to /workspace", () => {
    assert.equal(normalizeWorkspacePath("src/a.ts"), "/workspace/src/a.ts");
  });

  it("rejects paths outside the workspace, traversal, NUL, empty and overlong paths", () => {
    assert.equal(normalizeWorkspacePath("/etc/passwd"), null);
    assert.equal(normalizeWorkspacePath("/workspace/../etc"), null);
    assert.equal(normalizeWorkspacePath("/workspacefoo/a"), null);
    assert.equal(normalizeWorkspacePath("../x"), null);
    assert.equal(normalizeWorkspacePath("/workspace/a\0b"), null);
    assert.equal(normalizeWorkspacePath("   "), null);
    assert.equal(normalizeWorkspacePath(`/workspace/${"a".repeat(1100)}`), null);
  });
});

describe("breadcrumbs and parents", () => {
  it("starts at workspace and marks the last segment current", () => {
    assert.deepEqual(buildBreadcrumbs("/workspace/src/lib"), [
      { label: "workspace", path: "/workspace", current: false },
      { label: "src", path: "/workspace/src", current: false },
      { label: "lib", path: "/workspace/src/lib", current: true },
    ]);
    assert.deepEqual(buildBreadcrumbs("/workspace"), [{ label: "workspace", path: "/workspace", current: true }]);
  });

  it("falls back to the root for an invalid path", () => {
    assert.equal(buildBreadcrumbs("/etc")[0].path, "/workspace");
  });

  it("finds the parent directory and stops at the root", () => {
    assert.equal(parentDirectory("/workspace/src/a.ts"), "/workspace/src");
    assert.equal(parentDirectory("/workspace/a.ts"), "/workspace");
    assert.equal(parentDirectory("/workspace"), "/workspace");
  });
});

describe("listing display", () => {
  it("sorts directories first, then links, then files by natural name, without mutating", () => {
    const before = workspaceListing.entries.map((entry) => entry.name);
    const sorted = sortEntries(workspaceListing.entries).map((entry) => entry.name);
    assert.deepEqual(sorted, ["docs", "src", "latest", ".env", "data.bin", "logo.png", "notes.txt"]);
    assert.deepEqual(workspaceListing.entries.map((entry) => entry.name), before);
    const numbered: FileEntry[] = ["f10", "f2"].map((name) => ({
      name, path: `/workspace/${name}`, kind: "file", size: 1, mode: null, sha256: null, link_target: null,
    }));
    assert.deepEqual(sortEntries(numbered).map((entry) => entry.name), ["f2", "f10"]);
  });

  it("describes kind by text, shows sizes for files only and link targets for links", () => {
    const view = buildListingView(workspaceListing);
    const byName = Object.fromEntries(view.rows.map((row) => [row.name, row]));
    assert.equal(byName.src.kindLabel, "Folder");
    assert.equal(byName.src.opensDirectory, true);
    assert.equal(byName.src.sizeLabel, "");
    assert.equal(byName["notes.txt"].kindLabel, "File");
    assert.equal(byName["notes.txt"].sizeLabel, "412 B");
    assert.equal(byName.latest.kindLabel, "Link");
    assert.equal(byName.latest.linkTarget, "/workspace/src/index.ts");
    assert.equal(view.empty, false);
    assert.equal(view.truncatedNote, null);
  });

  it("flags an empty folder and a truncated listing, and caps displayed rows", () => {
    assert.equal(buildListingView(emptyListing).empty, true);
    const many: FileEntry[] = Array.from({ length: LISTING_ENTRY_LIMIT + 5 }, (_, index) => ({
      name: `f${index}`, path: `/workspace/f${index}`, kind: "file", size: 1, mode: null, sha256: null, link_target: null,
    }));
    const view = buildListingView({ entries: many, truncated: true });
    assert.equal(view.rows.length, LISTING_ENTRY_LIMIT);
    assert.match(view.truncatedNote ?? "", /first 2000 entries/);
  });

  it("formats sizes", () => {
    assert.equal(formatFileSize(0), "0 B");
    assert.equal(formatFileSize(1023), "1023 B");
    assert.equal(formatFileSize(1536), "1.5 KiB");
    assert.equal(formatFileSize(262144), "256 KiB");
    assert.equal(formatFileSize(5 * 1024 * 1024), "5 MiB");
    assert.equal(formatFileSize(null), "");
    assert.equal(formatFileSize(-1), "");
  });
});

describe("as-of wording", () => {
  const now = Date.parse("2026-10-12T10:00:00.000Z");
  it("is relative and plain", () => {
    assert.equal(formatRelativeTime("2026-10-12T09:59:50.000Z", now), "just now");
    assert.equal(formatRelativeTime("2026-10-12T09:55:00.000Z", now), "5 minutes ago");
    assert.equal(formatRelativeTime("2026-10-12T09:59:00.000Z", now), "1 minute ago");
    assert.equal(formatRelativeTime("2026-10-12T07:00:00.000Z", now), "3 hours ago");
    assert.equal(formatRelativeTime("2026-10-10T10:00:00.000Z", now), "2 days ago");
    assert.equal(asOfLabel("2026-10-12T09:55:00.000Z", now), "Saved 5 minutes ago");
  });
  it("is absent for missing or invalid times, and clamps the future", () => {
    assert.equal(asOfLabel(null, now), null);
    assert.equal(asOfLabel("nonsense", now), null);
    assert.equal(formatRelativeTime("2027-01-01T00:00:00.000Z", now), "just now");
  });
});

describe("describeFilesError", () => {
  const cases: Array<[number, string, string, string]> = [
    [404, "no_snapshot", "empty", "This organization's computer has no saved files yet"],
    [404, "not_found", "notice", "Not in the saved copy yet; it appears after the computer saves"],
    [409, "snapshot_not_indexed", "notice", "The saved copy is being upgraded; try again later"],
    [422, "not_a_file", "error", "That is a folder or link, not a file"],
    [400, "invalid_path", "error", "That path is not inside the workspace"],
  ];
  for (const [status, code, tone, title] of cases) {
    it(`maps ${code}`, () => {
      const view = describeFilesError(new FilesApiError(status, code, "server words"));
      assert.equal(view.tone, tone);
      assert.equal(view.title, title);
    });
  }
  it("never echoes server text and treats unknown failures as retryable", () => {
    const view = describeFilesError(new FilesApiError(500, "boom", "stack trace here"));
    assert.equal(view.title, "Could not load files; try again");
    assert.equal(view.retryable, true);
    assert.equal(describeFilesError(new TypeError("network")).retryable, true);
  });
  it("explains access refusals", () => {
    assert.match(describeFilesError(new FilesApiError(403, null, "x")).title, /do not have access/);
  });
});

describe("range paging", () => {
  const first = { size: 600000, sha256: "h", offset: 0, length: 262144, truncated: true };
  it("pages through a large file in 256 KiB ranges until the size is reached", () => {
    let state = startRangeState(first);
    assert.deepEqual(state, { size: 600000, sha256: "h", loadedBytes: 262144, nextOffset: 262144, done: false });
    state = advanceRangeState(state, { ...first, offset: 262144 });
    assert.equal(state.nextOffset, 524288);
    assert.equal(state.done, false);
    state = advanceRangeState(state, { ...first, offset: 524288, length: 75712, truncated: false });
    assert.equal(state.loadedBytes, 600000);
    assert.equal(state.done, true);
  });
  it("is done for a small file and for an empty range", () => {
    assert.equal(startRangeState({ size: 10, sha256: "h", offset: 0, length: 10, truncated: false }).done, true);
    assert.equal(startRangeState({ size: 0, sha256: "h", offset: 0, length: 0, truncated: false }).done, true);
  });
  it("detects a file that changed between ranges", () => {
    const state = startRangeState(first);
    assert.equal(rangeChangedUnderneath(state, { sha256: "other" }), true);
    assert.equal(rangeChangedUnderneath(state, { sha256: "h" }), false);
  });
});

describe("masked, binary and image handling", () => {
  it("classifies the first range", () => {
    assert.deepEqual(classifyFirstRange(textFileRange), { kind: "text" });
    assert.deepEqual(classifyFirstRange(maskedFileRange), { kind: "masked" });
    assert.deepEqual(classifyFirstRange(imageFileRange), { kind: "image-candidate" });
    assert.deepEqual(classifyFirstRange({ ...binaryFileRange, size: 9 * 1024 * 1024 }), { kind: "binary", size: 9 * 1024 * 1024 });
  });
  it("masked wins even when flagged binary", () => {
    assert.deepEqual(classifyFirstRange({ ...maskedFileRange, binary: true, encoding: "base64" }), { kind: "masked" });
    assert.equal(MASKED_FILE_MESSAGE, "This file looks like it holds a secret and is not shown.");
  });
  it("words binary files plainly", () => {
    assert.equal(binaryFileLabel(9000), "Binary file, 9000 bytes");
  });
  it("sniffs only PNG, JPEG, GIF and WebP by signature", () => {
    assert.equal(sniffImageType(base64ToBytes(TINY_PNG_BASE64)), "image/png");
    assert.equal(sniffImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.equal(sniffImageType(new TextEncoder().encode("GIF89a....")), "image/gif");
    const webp = new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ");
    assert.equal(sniffImageType(webp), "image/webp");
    assert.equal(sniffImageType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
    assert.equal(sniffImageType(new TextEncoder().encode("<!doctype html><html>")), null);
    assert.equal(sniffImageType(new Uint8Array()), null);
  });
  it("shortens hashes and builds queries", () => {
    assert.equal(shortenHash("a".repeat(64)), "a".repeat(12));
    assert.equal(shortenHash("abc"), "abc");
    assert.equal(filesQuery("/workspace/a b", { offset: 0, length: 262144 }), "path=%2Fworkspace%2Fa+b&offset=0&length=262144");
  });
});
