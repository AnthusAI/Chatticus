import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { workspaceColumnWidthStyle, workspaceShellLayoutClassName } from "./panel-plugins";
import {
  WORKSPACE_COLUMN_WIDTH_RANGES,
  clampWorkspaceColumnWidth,
  parseStoredWorkspaceColumnWidth,
  workspaceColumnWidthAfterDrag,
  workspaceColumnWidthAfterKey,
} from "./workspace-column-widths";

describe("workspace column widths", () => {
  it("keeps each column inside its range", () => {
    assert.equal(clampWorkspaceColumnWidth("roster", 10), WORKSPACE_COLUMN_WIDTH_RANGES.roster.minimumPixels);
    assert.equal(clampWorkspaceColumnWidth("roster", 5000), WORKSPACE_COLUMN_WIDTH_RANGES.roster.maximumPixels);
    assert.equal(clampWorkspaceColumnWidth("panel", 480.4), 480);
  });

  it("widens both columns when dragged toward the conversation", () => {
    assert.equal(workspaceColumnWidthAfterDrag("roster", 300, 40), 340);
    assert.equal(workspaceColumnWidthAfterDrag("panel", 500, -40), 540);
    assert.equal(workspaceColumnWidthAfterDrag("panel", 500, 40), 460);
  });

  it("moves by keyboard toward the conversation, and to either end with Home and End", () => {
    assert.equal(workspaceColumnWidthAfterKey("roster", 300, "ArrowRight"), 316);
    assert.equal(workspaceColumnWidthAfterKey("panel", 500, "ArrowLeft"), 516);
    assert.equal(workspaceColumnWidthAfterKey("panel", 500, "Home"), WORKSPACE_COLUMN_WIDTH_RANGES.panel.minimumPixels);
    assert.equal(workspaceColumnWidthAfterKey("roster", 300, "End"), WORKSPACE_COLUMN_WIDTH_RANGES.roster.maximumPixels);
    assert.equal(workspaceColumnWidthAfterKey("roster", 300, "Enter"), null);
  });

  it("ignores a missing or unreadable stored width and clamps a stale one", () => {
    assert.equal(parseStoredWorkspaceColumnWidth("roster", null), null);
    assert.equal(parseStoredWorkspaceColumnWidth("roster", "wide"), null);
    assert.equal(parseStoredWorkspaceColumnWidth("roster", "-3"), null);
    assert.equal(parseStoredWorkspaceColumnWidth("roster", "9000"), WORKSPACE_COLUMN_WIDTH_RANGES.roster.maximumPixels);
  });

  it("marks resized columns on the shell and carries their widths as CSS variables", () => {
    assert.equal(
      workspaceShellLayoutClassName({ collapsed: false, size: "split", rosterResized: true, panelResized: true }),
      "workspace-shell workspace-shell--roster-resized workspace-shell--panel-resized",
    );
    assert.deepEqual(workspaceColumnWidthStyle({ rosterWidthPixels: 320, panelWidthPixels: null }), { "--workspace-roster-width": "320px" });
  });
});
