/**
 * Pure state logic for the read-only computer file panel: path handling,
 * listing display, error wording, range paging and preview classification.
 * Nothing here touches the network or the DOM.
 */

export const WORKSPACE_ROOT = "/workspace";
export const MAX_PATH_LENGTH = 1024;
export const CONTENT_RANGE_BYTES = 262144;
export const LISTING_ENTRY_LIMIT = 2000;
export const IMAGE_PREVIEW_MAX_BYTES = 4 * 1024 * 1024;

export type FileEntryKind = "file" | "directory" | "symlink";

export type FileEntry = {
  name: string;
  path: string;
  kind: FileEntryKind;
  size: number | null;
  mode: string | null;
  sha256: string | null;
  link_target: string | null;
};

export type FileListing = {
  source: "snapshot";
  as_of: string | null;
  path: string;
  truncated: boolean;
  entries: FileEntry[];
};

export type FileContentRange = {
  source: "snapshot";
  as_of: string | null;
  path: string;
  size: number;
  sha256: string;
  encoding: "utf8" | "base64";
  binary: boolean;
  offset: number;
  length: number;
  content: string;
  truncated: boolean;
  masked: boolean;
};

export type FilesErrorBody = { error: string; message?: string };

/**
 * Normalises a path to an absolute path at or under /workspace.
 *
 * Relative paths are taken as relative to /workspace. Returns null for a path
 * that escapes the workspace, holds a NUL, is empty, or is too long.
 */
export function normalizeWorkspacePath(input: string): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed === "" || trimmed.length > MAX_PATH_LENGTH || trimmed.includes("\0")) return null;
  const absolute = trimmed.startsWith("/") ? trimmed : `${WORKSPACE_ROOT}/${trimmed}`;
  const resolved: string[] = [];
  for (const segment of absolute.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (resolved.length === 0) return null;
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  const normalized = `/${resolved.join("/")}`;
  if (normalized === WORKSPACE_ROOT || normalized.startsWith(`${WORKSPACE_ROOT}/`)) {
    return normalized;
  }
  return null;
}

export type BreadcrumbSegment = { label: string; path: string; current: boolean };

/** Breadcrumb segments from /workspace down to the given path; the last is current. */
export function buildBreadcrumbs(path: string): BreadcrumbSegment[] {
  const normalized = normalizeWorkspacePath(path) ?? WORKSPACE_ROOT;
  const rest = normalized.slice(WORKSPACE_ROOT.length).split("/").filter(Boolean);
  const segments: BreadcrumbSegment[] = [{ label: "workspace", path: WORKSPACE_ROOT, current: rest.length === 0 }];
  let accumulated = WORKSPACE_ROOT;
  rest.forEach((part, index) => {
    accumulated = `${accumulated}/${part}`;
    segments.push({ label: part, path: accumulated, current: index === rest.length - 1 });
  });
  return segments;
}

/** The directory containing a path; /workspace is its own parent. */
export function parentDirectory(path: string): string {
  const normalized = normalizeWorkspacePath(path) ?? WORKSPACE_ROOT;
  if (normalized === WORKSPACE_ROOT) return WORKSPACE_ROOT;
  return normalized.slice(0, normalized.lastIndexOf("/")) || WORKSPACE_ROOT;
}

/** Human size such as "12 B", "3.4 KiB", "1.2 MiB"; empty when unknown. */
export function formatFileSize(size: number | null): string {
  if (size === null || !Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${size} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

const KIND_RANK: Record<FileEntryKind, number> = { directory: 0, symlink: 1, file: 2 };

/** Directories first, then links, then files; each group by name. Does not mutate. */
export function sortEntries(entries: readonly FileEntry[]): FileEntry[] {
  return [...entries].sort((left, right) => {
    const rank = KIND_RANK[left.kind] - KIND_RANK[right.kind];
    if (rank !== 0) return rank;
    return left.name.localeCompare(right.name, "en", { numeric: true, sensitivity: "base" });
  });
}

export type EntryRowModel = {
  name: string;
  path: string;
  kind: FileEntryKind;
  kindLabel: "Folder" | "File" | "Link";
  sizeLabel: string;
  linkTarget: string | null;
  opensDirectory: boolean;
};

const KIND_LABELS = { directory: "Folder", file: "File", symlink: "Link" } as const;

/** Row display model for one entry. */
export function describeEntry(entry: FileEntry): EntryRowModel {
  return {
    name: entry.name,
    path: entry.path,
    kind: entry.kind,
    kindLabel: KIND_LABELS[entry.kind],
    sizeLabel: entry.kind === "file" ? formatFileSize(entry.size) : "",
    linkTarget: entry.kind === "symlink" ? entry.link_target : null,
    opensDirectory: entry.kind === "directory",
  };
}

export type ListingView = {
  rows: EntryRowModel[];
  empty: boolean;
  truncatedNote: string | null;
};

/** What the listing shows: sorted rows, an empty flag and a truncation note. */
export function buildListingView(listing: Pick<FileListing, "entries" | "truncated">): ListingView {
  const limited = sortEntries(listing.entries).slice(0, LISTING_ENTRY_LIMIT);
  return {
    rows: limited.map(describeEntry),
    empty: limited.length === 0,
    truncatedNote: listing.truncated
      ? `Only the first ${LISTING_ENTRY_LIMIT} entries are shown.`
      : null,
  };
}

/** "just now", "5 minutes ago" and so on; null when the time is unknown or invalid. */
export function formatRelativeTime(value: string | null | undefined, now: number): string | null {
  if (!value) return null;
  const then = Date.parse(value);
  if (Number.isNaN(then)) return null;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

export const SAVED_COPY_NOTE = "Showing the last saved copy of the computer";

/** The "as of" line, or null when the server gave no time. */
export function asOfLabel(asOf: string | null | undefined, now: number): string | null {
  const relative = formatRelativeTime(asOf, now);
  return relative === null ? null : `Saved ${relative}`;
}

export class FilesApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = "FilesApiError";
    this.status = status;
    this.code = code;
  }
}

export type FilesErrorView = {
  tone: "empty" | "notice" | "error";
  title: string;
  retryable: boolean;
};

export const NO_SNAPSHOT_MESSAGE = "This organization's computer has no saved files yet";
export const NOT_IN_SAVED_COPY_MESSAGE =
  "Not in the saved copy yet; it appears after the computer saves";

/** Plain-English wording for a file route failure. */
export function describeFilesError(error: unknown): FilesErrorView {
  if (error instanceof FilesApiError) {
    switch (error.code) {
      case "no_snapshot":
        return { tone: "empty", title: NO_SNAPSHOT_MESSAGE, retryable: true };
      case "not_found":
        return { tone: "notice", title: NOT_IN_SAVED_COPY_MESSAGE, retryable: true };
      case "snapshot_not_indexed":
        return { tone: "notice", title: "The saved copy is being upgraded; try again later", retryable: true };
      case "not_a_file":
        return { tone: "error", title: "That is a folder or link, not a file", retryable: false };
      case "invalid_path":
        return { tone: "error", title: "That path is not inside the workspace", retryable: false };
      case "range_too_large":
        return { tone: "error", title: "The file could not be read in pieces; try again", retryable: true };
      default:
        break;
    }
    if (error.status === 401 || error.status === 403) {
      return { tone: "error", title: "You do not have access to this computer's files", retryable: false };
    }
  }
  return { tone: "error", title: "Could not load files; try again", retryable: true };
}

export type RangeState = {
  size: number;
  sha256: string;
  loadedBytes: number;
  nextOffset: number;
  done: boolean;
};

/** Paging state after the first range of a file. */
export function startRangeState(first: Pick<FileContentRange, "size" | "sha256" | "offset" | "length" | "truncated">): RangeState {
  return advanceRangeState(
    { size: first.size, sha256: first.sha256, loadedBytes: 0, nextOffset: first.offset, done: false },
    first,
  );
}

/** Paging state after one more range has been read. */
export function advanceRangeState(
  state: RangeState,
  range: Pick<FileContentRange, "size" | "sha256" | "offset" | "length" | "truncated">,
): RangeState {
  const nextOffset = range.offset + range.length;
  const done = range.length <= 0 || nextOffset >= range.size || range.truncated === false;
  return {
    size: range.size,
    sha256: range.sha256,
    loadedBytes: state.loadedBytes + Math.max(0, range.length),
    nextOffset,
    done,
  };
}

/** True when the file changed between ranges (the whole-file hash differs). */
export function rangeChangedUnderneath(state: RangeState, range: Pick<FileContentRange, "sha256">): boolean {
  return state.sha256 !== range.sha256;
}

export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** Decodes standard base64 into bytes. */
export function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The image type of PNG, JPEG, GIF and WebP bytes by signature; null for anything else. */
export function sniffImageType(bytes: Uint8Array): ImageMime | null {
  const startsWith = (signature: number[], at = 0) => signature.every((byte, index) => bytes[at + index] === byte);
  if (bytes.length >= 8 && startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (bytes.length >= 3 && startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (bytes.length >= 6 && (startsWith([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))) {
    return "image/gif";
  }
  if (bytes.length >= 12 && startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return null;
}

export type PreviewKind =
  | { kind: "masked" }
  | { kind: "text" }
  | { kind: "image-candidate" }
  | { kind: "binary"; size: number };

/** How the first range of a file is to be shown. SVG and HTML are text, never images. */
export function classifyFirstRange(
  range: Pick<FileContentRange, "masked" | "binary" | "encoding" | "size">,
): PreviewKind {
  if (range.masked) return { kind: "masked" };
  if (!range.binary && range.encoding === "utf8") return { kind: "text" };
  if (range.binary && range.encoding === "base64" && range.size <= IMAGE_PREVIEW_MAX_BYTES) {
    return { kind: "image-candidate" };
  }
  return { kind: "binary", size: range.size };
}

/** "Binary file, N bytes". */
export function binaryFileLabel(size: number): string {
  return `Binary file, ${size} bytes`;
}

export const MASKED_FILE_MESSAGE = "This file looks like it holds a secret and is not shown.";

/** A short hash for display; the full value belongs in a title. */
export function shortenHash(sha256: string): string {
  return sha256.length > 12 ? sha256.slice(0, 12) : sha256;
}

/** Query string for a listing or content request. */
export function filesQuery(path: string, extra: Record<string, number> = {}): string {
  const params = new URLSearchParams({ path });
  for (const [key, value] of Object.entries(extra)) params.set(key, String(value));
  return params.toString();
}
