/**
 * The workspace panel is a plugin host. Each panel plugin is one view the panel can show beside the conversation
 * (split) or across the workspace with the conversation docked beside it (full). The core plugins ship with the
 * workspace; plugins from other products are registered the same way through the plugin registry.
 */

import type { PanelPluginManifest } from "./panel-plugin-manifest";
import { CORE_PANEL_PLUGIN_MANIFESTS } from "./panel-plugin-registry";
import { WORKSPACE_COLUMN_WIDTH_CSS_VARIABLES } from "./workspace-column-widths";

/** How much of the workspace the panel takes. */
export type PanelSize = "split" | "full";

export type { CorePanelPluginId } from "./panel-plugin-registry";

const FALLBACK_PANEL_SIZE: PanelSize = "split";

/** The plugin an arrow, Home or End key moves to among the given plugins; null for any other key. */
export function nextPanelPlugin(
  current: string,
  key: string,
  plugins: ReadonlyArray<PanelPluginManifest> = CORE_PANEL_PLUGIN_MANIFESTS,
): string | null {
  const index = plugins.findIndex((plugin) => plugin.id === current);
  const last = plugins.length - 1;
  switch (key) {
    case "ArrowRight":
      return plugins[index === last ? 0 : index + 1].id;
    case "ArrowLeft":
      return plugins[index <= 0 ? last : index - 1].id;
    case "Home":
      return plugins[0].id;
    case "End":
      return plugins[last].id;
    default:
      return null;
  }
}

/** The size the panel takes when a plugin opens: the requested size when the plugin supports it, otherwise split. */
export function panelSizeForPlugin(
  pluginId: string,
  requestedSize: PanelSize,
  plugins: ReadonlyArray<PanelPluginManifest> = CORE_PANEL_PLUGIN_MANIFESTS,
): PanelSize {
  const plugin = plugins.find((candidate) => candidate.id === pluginId);
  return plugin?.sizes.includes(requestedSize) ? requestedSize : FALLBACK_PANEL_SIZE;
}

/** The workspace shell's layout class for the panel's state and which columns carry a user-chosen width. */
export function workspaceShellLayoutClassName(panel: {
  collapsed: boolean;
  size: PanelSize;
  rosterResized?: boolean;
  panelResized?: boolean;
}): string {
  const classNames = ["workspace-shell"];
  if (panel.collapsed) classNames.push("workspace-shell--panel-collapsed");
  else if (panel.size === "full") classNames.push("workspace-shell--panel-full");
  if (panel.rosterResized) classNames.push("workspace-shell--roster-resized");
  if (panel.panelResized) classNames.push("workspace-shell--panel-resized");
  return classNames.join(" ");
}

/** The CSS variables that carry the user-chosen roster and panel widths into the shell's grid. */
export function workspaceColumnWidthStyle(widths: { rosterWidthPixels: number | null; panelWidthPixels: number | null }): Record<string, string> {
  const style: Record<string, string> = {};
  if (widths.rosterWidthPixels !== null) style[WORKSPACE_COLUMN_WIDTH_CSS_VARIABLES.roster] = `${widths.rosterWidthPixels}px`;
  if (widths.panelWidthPixels !== null) style[WORKSPACE_COLUMN_WIDTH_CSS_VARIABLES.panel] = `${widths.panelWidthPixels}px`;
  return style;
}
