"use client";

import type { FC, KeyboardEvent } from "react";

import type { PanelPluginStatus } from "@/lib/panel-plugin-host-api";
import type { PanelPluginManifest } from "@/lib/panel-plugin-manifest";
import { CORE_PANEL_PLUGIN_MANIFESTS } from "@/lib/panel-plugin-registry";
import { nextPanelPlugin } from "@/lib/panel-plugins";

/** Where a panel plugin host is mounted; each placement gets its own DOM ids so both can exist at once. */
export type PanelHostPlacement = "docked" | "sheet";

export function panelPluginTabDomId(placement: PanelHostPlacement, id: string): string {
  return `panel-plugin-${placement}-tab-${id}`;
}

export function panelPluginPanelDomId(placement: PanelHostPlacement, id: string): string {
  return `panel-plugin-${placement}-panel-${id}`;
}

/** One tab per panel plugin; arrow keys move between them. */
export const PanelPluginTabs: FC<{
  placement: PanelHostPlacement;
  selected: string;
  onSelect: (id: string) => void;
  plugins?: ReadonlyArray<PanelPluginManifest>;
  titleByPluginId?: Readonly<Record<string, string | undefined>>;
  statusByPluginId?: Readonly<Record<string, PanelPluginStatus | undefined>>;
}> = ({ placement, selected, onSelect, plugins = CORE_PANEL_PLUGIN_MANIFESTS, titleByPluginId = {}, statusByPluginId = {} }) => {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = nextPanelPlugin(selected, event.key, plugins);
    if (next === null) return;
    event.preventDefault();
    onSelect(next);
    document.getElementById(panelPluginTabDomId(placement, next))?.focus();
  };
  return (
    <div role="tablist" aria-label="Panel plugins" onKeyDown={onKeyDown} className="flex min-w-0 gap-1">
      {plugins.map((plugin) => {
        const isSelected = plugin.id === selected;
        const status = statusByPluginId[plugin.id];
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
            {titleByPluginId[plugin.id] ?? plugin.name}
            {status ? <span className={`ml-1.5 rounded-full px-1.5 py-0.5 font-mono text-[0.6rem] ${status.tone === "danger" ? "bg-clay/25" : status.tone === "attention" ? "bg-amber/25" : "bg-surface-raised"}`}>{status.label}</span> : null}
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
