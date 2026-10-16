"use client";

import type { FC, KeyboardEvent } from "react";

import { CORE_PANEL_PLUGINS, nextPanelPlugin, type CorePanelPluginId } from "@/lib/panel-plugins";

/** Where a panel plugin host is mounted; each placement gets its own DOM ids so both can exist at once. */
export type PanelHostPlacement = "docked" | "sheet";

export function panelPluginTabDomId(placement: PanelHostPlacement, id: CorePanelPluginId): string {
  return `panel-plugin-${placement}-tab-${id}`;
}

export function panelPluginPanelDomId(placement: PanelHostPlacement, id: CorePanelPluginId): string {
  return `panel-plugin-${placement}-panel-${id}`;
}

/** One tab per panel plugin; arrow keys move between them. */
export const PanelPluginTabs: FC<{
  placement: PanelHostPlacement;
  selected: CorePanelPluginId;
  onSelect: (id: CorePanelPluginId) => void;
}> = ({ placement, selected, onSelect }) => {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = nextPanelPlugin(selected, event.key);
    if (next === null) return;
    event.preventDefault();
    onSelect(next);
    document.getElementById(panelPluginTabDomId(placement, next))?.focus();
  };
  return (
    <div role="tablist" aria-label="Panel plugins" onKeyDown={onKeyDown} className="flex min-w-0 gap-1">
      {CORE_PANEL_PLUGINS.map((plugin) => {
        const isSelected = plugin.id === selected;
        return (
          <button
            key={plugin.id}
            id={panelPluginTabDomId(placement, plugin.id)}
            type="button"
            role="tab"
            aria-selected={isSelected}
            aria-controls={panelPluginPanelDomId(placement, plugin.id)}
            tabIndex={isSelected ? 0 : -1}
            onClick={() => onSelect(plugin.id)}
            className={`min-h-11 rounded-full px-4 text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt ${
              isSelected ? "bg-surface" : "hover:bg-surface/60"
            }`}
          >
            {plugin.label}
          </button>
        );
      })}
    </div>
  );
};

/** Switches the panel between sitting beside the conversation and filling the workspace. */
export const PanelSizeSwitch: FC<{
  size: "split" | "full";
  onChange: (size: "split" | "full") => void;
}> = ({ size, onChange }) => (
  <div role="group" aria-label="Panel size" className="flex shrink-0 gap-0.5 rounded-full p-0.5">
    {(["split", "full"] as const).map((option) => (
      <button
        key={option}
        type="button"
        aria-pressed={size === option}
        onClick={() => onChange(option)}
        className={`min-h-11 rounded-full px-3 text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt ${
          size === option ? "bg-surface" : "hover:bg-surface/60"
        }`}
      >
        {option === "split" ? "Split" : "Full"}
      </button>
    ))}
  </div>
);
