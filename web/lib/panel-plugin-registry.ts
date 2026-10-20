import type { PanelPluginManifest } from "./panel-plugin-manifest";

export const CORE_PANEL_PLUGIN_IDS = ["context", "files", "costs", "board"] as const;

export type CorePanelPluginId = (typeof CORE_PANEL_PLUGIN_IDS)[number];

function corePanelPluginManifest(id: CorePanelPluginId, name: string, icon: string, handles: readonly string[]): PanelPluginManifest {
  return {
    id,
    name,
    icon,
    version: "1.0.0",
    entry: null,
    isolation: "inline",
    elements: { panel: `chatticus-${id}-panel`, card: null },
    sizes: ["split", "full"],
    handles,
    permissions: [],
  };
}

export const CORE_PANEL_PLUGIN_MANIFESTS: ReadonlyArray<PanelPluginManifest> = [
  corePanelPluginManifest("context", "Context", "layout-list", ["workspace.context"]),
  corePanelPluginManifest("files", "Files", "folder", ["file", "workspace"]),
  corePanelPluginManifest("costs", "Costs", "receipt", ["costs"]),
  corePanelPluginManifest("board", "Board", "kanban", ["kanbus.board", "kanbus.issue"]),
];

export type PanelPluginRegistration =
  | { ok: true; replaced: boolean }
  | { ok: false; reason: "core_plugin_is_reserved" };

export type PanelPluginRegistry = {
  register: (manifest: PanelPluginManifest) => PanelPluginRegistration;
  unregister: (pluginId: string) => void;
  list: () => ReadonlyArray<PanelPluginManifest>;
  find: (pluginId: string) => PanelPluginManifest | null;
  findHandlerOfObjectType: (objectType: string) => PanelPluginManifest | null;
  subscribe: (listener: () => void) => () => void;
};

export function createPanelPluginRegistry(coreManifests: ReadonlyArray<PanelPluginManifest> = CORE_PANEL_PLUGIN_MANIFESTS): PanelPluginRegistry {
  const coreIds = new Set(coreManifests.map((manifest) => manifest.id));
  let manifests: ReadonlyArray<PanelPluginManifest> = [...coreManifests];
  const listeners = new Set<() => void>();

  const publish = (next: ReadonlyArray<PanelPluginManifest>) => {
    manifests = next;
    listeners.forEach((listener) => listener());
  };

  return {
    register(manifest) {
      if (coreIds.has(manifest.id)) return { ok: false, reason: "core_plugin_is_reserved" };
      const replaced = manifests.some((existing) => existing.id === manifest.id);
      publish(replaced ? manifests.map((existing) => (existing.id === manifest.id ? manifest : existing)) : [...manifests, manifest]);
      return { ok: true, replaced };
    },
    unregister(pluginId) {
      if (coreIds.has(pluginId) || !manifests.some((existing) => existing.id === pluginId)) return;
      publish(manifests.filter((existing) => existing.id !== pluginId));
    },
    list: () => manifests,
    find: (pluginId) => manifests.find((manifest) => manifest.id === pluginId) ?? null,
    findHandlerOfObjectType: (objectType) => manifests.find((manifest) => manifest.handles.includes(objectType)) ?? null,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const panelPluginRegistry: PanelPluginRegistry = createPanelPluginRegistry();
