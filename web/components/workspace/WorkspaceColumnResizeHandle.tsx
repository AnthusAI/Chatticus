"use client";

import { useCallback, useEffect, useRef, useState, type FC, type KeyboardEvent, type PointerEvent } from "react";

import {
  WORKSPACE_COLUMN_WIDTH_RANGES,
  WORKSPACE_COLUMN_WIDTH_STORAGE_KEYS,
  parseStoredWorkspaceColumnWidth,
  workspaceColumnWidthAfterDrag,
  workspaceColumnWidthAfterKey,
  type ResizableWorkspaceColumn,
} from "@/lib/workspace-column-widths";

function readStoredWorkspaceColumnWidth(column: ResizableWorkspaceColumn): number | null {
  try {
    return parseStoredWorkspaceColumnWidth(column, window.localStorage.getItem(WORKSPACE_COLUMN_WIDTH_STORAGE_KEYS[column]));
  } catch {
    return null;
  }
}

function writeStoredWorkspaceColumnWidth(column: ResizableWorkspaceColumn, widthPixels: number | null): void {
  try {
    const storageKey = WORKSPACE_COLUMN_WIDTH_STORAGE_KEYS[column];
    if (widthPixels === null) window.localStorage.removeItem(storageKey);
    else window.localStorage.setItem(storageKey, String(widthPixels));
  } catch {
    return;
  }
}

/**
 * A column's user-chosen width, or null while it keeps the shell's default. Restored from this browser after mount,
 * so server and first client render agree.
 */
export function useResizableWorkspaceColumnWidth(column: ResizableWorkspaceColumn) {
  const [widthPixels, setWidthPixels] = useState<number | null>(null);
  useEffect(() => {
    setWidthPixels(readStoredWorkspaceColumnWidth(column));
  }, [column]);
  const changeWidthPixels = useCallback(
    (nextWidthPixels: number | null) => {
      setWidthPixels(nextWidthPixels);
      writeStoredWorkspaceColumnWidth(column, nextWidthPixels);
    },
    [column],
  );
  return [widthPixels, changeWidthPixels] as const;
}

/**
 * A flat drag strip laid over the gap beside a column. It has no rule of its own; a surface step shows only while it
 * is hovered, focused or dragged. Double-click returns the column to its default width.
 */
export const WorkspaceColumnResizeHandle: FC<{
  column: ResizableWorkspaceColumn;
  label: string;
  measureRenderedColumnWidthPixels: () => number;
  onWidthChange: (widthPixels: number | null) => void;
}> = ({ column, label, measureRenderedColumnWidthPixels, onWidthChange }) => {
  const dragStartRef = useRef<{ pointerX: number; widthPixels: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [renderedWidthPixels, setRenderedWidthPixels] = useState<number | null>(null);
  const { minimumPixels, maximumPixels } = WORKSPACE_COLUMN_WIDTH_RANGES[column];

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStartRef.current = { pointerX: event.clientX, widthPixels: measureRenderedColumnWidthPixels() };
    setIsDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const dragStart = dragStartRef.current;
    if (!dragStart) return;
    const nextWidthPixels = workspaceColumnWidthAfterDrag(column, dragStart.widthPixels, event.clientX - dragStart.pointerX);
    setRenderedWidthPixels(nextWidthPixels);
    onWidthChange(nextWidthPixels);
  };
  const endDrag = () => {
    dragStartRef.current = null;
    setIsDragging(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const nextWidthPixels = workspaceColumnWidthAfterKey(column, measureRenderedColumnWidthPixels(), event.key);
    if (nextWidthPixels === null) return;
    event.preventDefault();
    setRenderedWidthPixels(nextWidthPixels);
    onWidthChange(nextWidthPixels);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={minimumPixels}
      aria-valuemax={maximumPixels}
      aria-valuenow={renderedWidthPixels ?? undefined}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onFocus={() => setRenderedWidthPixels(Math.round(measureRenderedColumnWidthPixels()))}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        setRenderedWidthPixels(null);
        onWidthChange(null);
      }}
      data-dragging={isDragging ? "true" : undefined}
      className={`workspace-column-resize-handle workspace-column-resize-handle--${column}`}
    />
  );
};
