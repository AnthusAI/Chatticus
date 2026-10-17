/**
 * The roster (left) and the docked panel (right) are drag-resizable columns of the workspace shell. Their widths are
 * kept in pixels, clamped to a per-column range, and remembered in this browser so the layout survives a reload.
 * The grid still guarantees the conversation its minimum width, so a remembered width that no longer fits a smaller
 * window gives way instead of overflowing.
 */

export type ResizableWorkspaceColumn = "roster" | "panel";

export type WorkspaceColumnWidthRange = { minimumPixels: number; maximumPixels: number };

export const WORKSPACE_COLUMN_WIDTH_RANGES: Readonly<Record<ResizableWorkspaceColumn, WorkspaceColumnWidthRange>> = {
  roster: { minimumPixels: 208, maximumPixels: 480 },
  panel: { minimumPixels: 320, maximumPixels: 1040 },
};

export const WORKSPACE_COLUMN_WIDTH_STORAGE_KEYS: Readonly<Record<ResizableWorkspaceColumn, string>> = {
  roster: "chatticus.workspace.rosterWidthPixels",
  panel: "chatticus.workspace.panelWidthPixels",
};

export const WORKSPACE_COLUMN_WIDTH_CSS_VARIABLES: Readonly<Record<ResizableWorkspaceColumn, string>> = {
  roster: "--workspace-roster-width",
  panel: "--workspace-panel-width",
};

export const WORKSPACE_COLUMN_KEYBOARD_STEP_PIXELS = 16;

export function clampWorkspaceColumnWidth(column: ResizableWorkspaceColumn, widthPixels: number): number {
  const { minimumPixels, maximumPixels } = WORKSPACE_COLUMN_WIDTH_RANGES[column];
  return Math.round(Math.min(maximumPixels, Math.max(minimumPixels, widthPixels)));
}

export function parseStoredWorkspaceColumnWidth(column: ResizableWorkspaceColumn, storedValue: string | null): number | null {
  if (storedValue === null) return null;
  const widthPixels = Number(storedValue);
  if (!Number.isFinite(widthPixels) || widthPixels <= 0) return null;
  return clampWorkspaceColumnWidth(column, widthPixels);
}

/**
 * The roster's handle sits on its right edge and the panel's on its left edge, so dragging toward the conversation
 * widens the column in both cases.
 */
export function workspaceColumnWidthAfterDrag(
  column: ResizableWorkspaceColumn,
  widthAtDragStartPixels: number,
  horizontalPointerTravelPixels: number,
): number {
  const travelTowardConversation = column === "roster" ? horizontalPointerTravelPixels : -horizontalPointerTravelPixels;
  return clampWorkspaceColumnWidth(column, widthAtDragStartPixels + travelTowardConversation);
}

/** The width an arrow, Home or End key on a column's handle moves to; null for any other key. */
export function workspaceColumnWidthAfterKey(column: ResizableWorkspaceColumn, currentWidthPixels: number, key: string): number | null {
  const { minimumPixels, maximumPixels } = WORKSPACE_COLUMN_WIDTH_RANGES[column];
  const widenKey = column === "roster" ? "ArrowRight" : "ArrowLeft";
  const narrowKey = column === "roster" ? "ArrowLeft" : "ArrowRight";
  switch (key) {
    case widenKey:
      return clampWorkspaceColumnWidth(column, currentWidthPixels + WORKSPACE_COLUMN_KEYBOARD_STEP_PIXELS);
    case narrowKey:
      return clampWorkspaceColumnWidth(column, currentWidthPixels - WORKSPACE_COLUMN_KEYBOARD_STEP_PIXELS);
    case "Home":
      return minimumPixels;
    case "End":
      return maximumPixels;
    default:
      return null;
  }
}
