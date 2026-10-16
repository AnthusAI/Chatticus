/**
 * The workspace panel is a plugin host. Each panel plugin is one view the panel can show beside the conversation
 * (split) or across the workspace with the conversation docked beside it (full). The core plugins ship with the
 * workspace; plugins from other products are registered the same way when the external loader lands.
 */

/** How much of the workspace the panel takes. */
export type PanelSize = "split" | "full";

/** The panel plugins that ship with the workspace. */
export type CorePanelPluginId = "context" | "files" | "costs";

/** What the host needs to list, open and size one panel plugin. */
export type PanelPluginDefinition = {
  id: CorePanelPluginId;
  label: string;
  supportedSizes: readonly PanelSize[];
};

const EVERY_PANEL_SIZE: readonly PanelSize[] = ["split", "full"];

/** The core panel plugins, in tab order. */
export const CORE_PANEL_PLUGINS: ReadonlyArray<PanelPluginDefinition> = [
  { id: "context", label: "Context", supportedSizes: EVERY_PANEL_SIZE },
  { id: "files", label: "Files", supportedSizes: EVERY_PANEL_SIZE },
  { id: "costs", label: "Costs", supportedSizes: EVERY_PANEL_SIZE },
];

/** The plugin an arrow, Home or End key moves to; null for any other key. */
export function nextPanelPlugin(current: CorePanelPluginId, key: string): CorePanelPluginId | null {
  const index = CORE_PANEL_PLUGINS.findIndex((plugin) => plugin.id === current);
  const last = CORE_PANEL_PLUGINS.length - 1;
  switch (key) {
    case "ArrowRight":
      return CORE_PANEL_PLUGINS[index === last ? 0 : index + 1].id;
    case "ArrowLeft":
      return CORE_PANEL_PLUGINS[index === 0 ? last : index - 1].id;
    case "Home":
      return CORE_PANEL_PLUGINS[0].id;
    case "End":
      return CORE_PANEL_PLUGINS[last].id;
    default:
      return null;
  }
}

/** The size the panel takes when a plugin opens: the requested size when the plugin supports it, otherwise split. */
export function panelSizeForPlugin(pluginId: CorePanelPluginId, requestedSize: PanelSize): PanelSize {
  const plugin = CORE_PANEL_PLUGINS.find((candidate) => candidate.id === pluginId);
  return plugin?.supportedSizes.includes(requestedSize) ? requestedSize : "split";
}

/** The workspace shell's layout class for the panel's state. */
export function workspaceShellLayoutClassName(panel: { collapsed: boolean; size: PanelSize }): string {
  if (panel.collapsed) return "workspace-shell workspace-shell--panel-collapsed";
  return panel.size === "full" ? "workspace-shell workspace-shell--panel-full" : "workspace-shell";
}
