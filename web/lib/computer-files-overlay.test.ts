import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CONFLICT_MARK,
  EDITED_MARK,
  NEW_MARK,
  RENAMED_MARK,
  WAITING_MARK,
  describePendingChange,
  markForListingRow,
  overlayEntriesByPath,
  sortPendingChanges,
  type OverlayEntry,
} from "./computer-files-overlay";

const base = { edited_by: "ryan", edited_at: "2026-10-12T10:00:00.000Z", revision: 1, conflict: null };
const sha = "a".repeat(64);

const edit: OverlayEntry = { ...base, op: "put", path: "/workspace/notes.md", sha256: sha, size: 3, mode: "644", base_sha256: sha, from: null, from_sha256: null };
const created: OverlayEntry = { ...edit, path: "/workspace/new.md", base_sha256: null };
const renamedPut: OverlayEntry = { ...edit, path: "/workspace/b.md", from: "/workspace/a.md", from_sha256: sha };
const moved: OverlayEntry = { ...base, op: "move", path: "/workspace/new.md", from: "/workspace/old.md", directory: false, sha256: sha, tree_sha256: null, size: 1, mode: "644" };
const removed: OverlayEntry = { ...base, op: "delete", path: "/workspace/a.txt", directory: false, recursive: false, base_sha256: sha, tree_sha256: null };
const removedFolder: OverlayEntry = { ...removed, path: "/workspace/old", directory: true, recursive: true };
const folder: OverlayEntry = { ...base, op: "mkdir", path: "/workspace/docs", mode: "775" };

describe("the mark under a listing row", () => {
  it("says nothing when no change waits", () => {
    assert.equal(markForListingRow("none", undefined), null);
    assert.equal(markForListingRow("none", edit), null);
  });

  it("names the kind of change waiting for the computer", () => {
    assert.equal(markForListingRow("pending", edit), EDITED_MARK);
    assert.equal(markForListingRow("pending", created), NEW_MARK);
    assert.equal(markForListingRow("pending", folder), NEW_MARK);
    assert.equal(markForListingRow("pending", moved), RENAMED_MARK);
    assert.equal(markForListingRow("pending", renamedPut), RENAMED_MARK);
  });

  it("falls back to a generic mark when the list of changes could not be read, and flags a conflict", () => {
    assert.equal(markForListingRow("pending", undefined), WAITING_MARK);
    assert.equal(markForListingRow("conflict", edit), CONFLICT_MARK);
  });
});

describe("the Pending changes list", () => {
  it("describes every kind of change in one line", () => {
    assert.equal(describePendingChange(edit), "Edited notes.md");
    assert.equal(describePendingChange(created), "New file new.md");
    assert.equal(describePendingChange(removed), "Deleted a.txt");
    assert.equal(describePendingChange(removedFolder), "Deleted folder old");
    assert.equal(describePendingChange(folder), "New folder docs");
    assert.equal(describePendingChange(moved), "Renamed old.md to new.md");
    assert.equal(describePendingChange(renamedPut), "Renamed a.md to b.md");
  });

  it("sorts by path with natural numbers and indexes by path", () => {
    const entries = [{ ...edit, path: "/workspace/f10" }, { ...edit, path: "/workspace/f2" }];
    assert.deepEqual(sortPendingChanges(entries).map((entry) => entry.path), ["/workspace/f2", "/workspace/f10"]);
    assert.equal(overlayEntriesByPath(entries).get("/workspace/f2")?.path, "/workspace/f2");
  });
});
