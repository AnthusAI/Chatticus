"use client";

import type { FC, KeyboardEvent } from "react";

import { INSPECTOR_TABS, nextInspectorTab, type InspectorTabId } from "@/lib/inspector-tabs";

export function inspectorTabDomId(id: InspectorTabId): string {
  return `inspector-tab-${id}`;
}

export function inspectorPanelDomId(id: InspectorTabId): string {
  return `inspector-panel-${id}`;
}

/** Context and Files tabs for the conversation inspector; arrow keys move between them. */
export const InspectorTabs: FC<{
  selected: InspectorTabId;
  onSelect: (id: InspectorTabId) => void;
}> = ({ selected, onSelect }) => {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = nextInspectorTab(selected, event.key);
    if (next === null) return;
    event.preventDefault();
    onSelect(next);
    document.getElementById(inspectorTabDomId(next))?.focus();
  };
  return (
    <div role="tablist" aria-label="Inspector sections" onKeyDown={onKeyDown} className="flex gap-1.5 pb-3">
      {INSPECTOR_TABS.map((tab) => {
        const isSelected = tab.id === selected;
        return (
          <button
            key={tab.id}
            id={inspectorTabDomId(tab.id)}
            type="button"
            role="tab"
            aria-selected={isSelected}
            aria-controls={inspectorPanelDomId(tab.id)}
            tabIndex={isSelected ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            className={`min-h-11 rounded-full px-4 text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt ${
              isSelected ? "bg-surface-high" : "bg-surface hover:bg-surface-high"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
};
