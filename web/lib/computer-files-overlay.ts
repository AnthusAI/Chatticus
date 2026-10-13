/**
 * The changes waiting for the computer (the edit overlay): the JSON of
 * host-protocol/src/edit-overlay.ts as the panel needs it, plus the words for
 * the marks in a listing and the entries of the Pending changes list.
 */

import type { OverlayState } from "./computer-files";

export type OverlayConflictReason = "changed" | "collision" | "not_empty" | "kind_mismatch";

export type OverlayConflict = {
  reason: OverlayConflictReason;
  disk_sha256: string | null;
  found_at: string;
};

type OverlayEntryBase = {
  path: string;
  edited_by: string;
  edited_at: string;
  revision: number;
  conflict: OverlayConflict | null;
};

export type OverlayEntry =
  | (OverlayEntryBase & {
      op: "put";
      sha256: string;
      size: number;
      mode: string;
      base_sha256: string | null;
      from: string | null;
      from_sha256: string | null;
    })
  | (OverlayEntryBase & {
      op: "delete";
      directory: boolean;
      recursive: boolean;
      base_sha256: string | null;
      tree_sha256: string | null;
    })
  | (OverlayEntryBase & { op: "mkdir"; mode: string })
  | (OverlayEntryBase & {
      op: "move";
      from: string;
      directory: boolean;
      sha256: string | null;
      tree_sha256: string | null;
      size: number;
      mode: string;
    });

export const EDITED_MARK = "Edited, waiting for the computer";
export const NEW_MARK = "New, waiting for the computer";
export const RENAMED_MARK = "Renamed, waiting for the computer";
export const WAITING_MARK = "Changed, waiting for the computer";
export const CONFLICT_MARK = "Conflicts with a newer version";

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

/** The mark under a listing row for the change waiting at its path; null when nothing waits. */
export function markForListingRow(overlay: OverlayState, entry: OverlayEntry | undefined): string | null {
  if (overlay === "none") return null;
  if (overlay === "conflict") return CONFLICT_MARK;
  if (!entry) return WAITING_MARK;
  switch (entry.op) {
    case "put":
      if (entry.from !== null) return RENAMED_MARK;
      return entry.base_sha256 === null ? NEW_MARK : EDITED_MARK;
    case "move":
      return RENAMED_MARK;
    case "mkdir":
      return NEW_MARK;
    case "delete":
      return WAITING_MARK;
  }
}

/** One line of the Pending changes list, for example "Deleted a.txt" or "New folder docs". */
export function describePendingChange(entry: OverlayEntry): string {
  const name = nameOf(entry.path);
  switch (entry.op) {
    case "put":
      if (entry.from !== null) return `Renamed ${nameOf(entry.from)} to ${name}`;
      return entry.base_sha256 === null ? `New file ${name}` : `Edited ${name}`;
    case "move":
      return `Renamed ${nameOf(entry.from)} to ${name}`;
    case "mkdir":
      return `New folder ${name}`;
    case "delete":
      return entry.directory ? `Deleted folder ${name}` : `Deleted ${name}`;
  }
}

/** The entry waiting at exactly this path, if any. */
export function overlayEntryAt(entries: readonly OverlayEntry[], path: string): OverlayEntry | undefined {
  return entries.find((entry) => entry.path === path);
}

/** Pending entries by path, so a listing can mark its rows. */
export function overlayEntriesByPath(entries: readonly OverlayEntry[]): Map<string, OverlayEntry> {
  return new Map(entries.map((entry) => [entry.path, entry]));
}

/**
 * Entries to list on screen: a delete or a move leaves no row to mark, so the
 * Pending changes list is where a person finds, and can discard, every kind.
 */
export function sortPendingChanges(entries: readonly OverlayEntry[]): OverlayEntry[] {
  return [...entries].sort((left, right) => left.path.localeCompare(right.path, "en", { numeric: true }));
}
