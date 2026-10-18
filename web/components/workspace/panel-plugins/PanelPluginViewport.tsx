"use client";

import { useMemo, useSyncExternalStore, type FC } from "react";

import type {
  PanelPluginContext,
  PanelPluginHost,
  PanelPluginObjectReference,
  PanelPluginStatus,
  PanelPluginTheme,
} from "@/lib/panel-plugin-host-api";
import type { PanelPluginManifest } from "@/lib/panel-plugin-manifest";
import type { PanelSize } from "@/lib/panel-plugins";
import { panelPluginPanelDomId, panelPluginTabDomId, type PanelHostPlacement } from "../PanelPluginTabs";
import { PanelPluginElementView } from "./PanelPluginElementView";

const DARK_COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)";

function subscribeToColorScheme(onChange: () => void): () => void {
  const query = window.matchMedia(DARK_COLOR_SCHEME_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function usePanelPluginTheme(): PanelPluginTheme {
  return useSyncExternalStore(
    subscribeToColorScheme,
    () => (window.matchMedia(DARK_COLOR_SCHEME_QUERY).matches ? "dark" : "light"),
    () => "light",
  );
}

export type PanelPluginViewportCallbacks = {
  onOpenObject: (objectReference: PanelPluginObjectReference) => void;
  onTitleChange: (pluginId: string, title: string) => void;
  onStatusChange: (pluginId: string, status: PanelPluginStatus | null) => void;
};

export const PanelPluginViewport: FC<
  PanelPluginViewportCallbacks & {
    placement: PanelHostPlacement;
    plugins: ReadonlyArray<PanelPluginManifest>;
    selectedPluginId: string;
    visitedPluginIds: ReadonlySet<string>;
    size: PanelSize;
    organizationKey: string;
    services: unknown;
    objectReferenceByPluginId: Readonly<Record<string, PanelPluginObjectReference | undefined>>;
  }
> = ({
  placement,
  plugins,
  selectedPluginId,
  visitedPluginIds,
  size,
  organizationKey,
  services,
  objectReferenceByPluginId,
  onOpenObject,
  onTitleChange,
  onStatusChange,
}) => {
  const theme = usePanelPluginTheme();
  const hostByPluginId = useMemo(
    () =>
      new Map<string, PanelPluginHost>(
        plugins.map((plugin) => [
          plugin.id,
          {
            open: onOpenObject,
            setTitle: (title) => onTitleChange(plugin.id, title),
            setStatus: (status) => onStatusChange(plugin.id, status),
          },
        ]),
      ),
    [plugins, onOpenObject, onTitleChange, onStatusChange],
  );

  return (
    <>
      {plugins.map((plugin) => {
        const host = hostByPluginId.get(plugin.id);
        if (!visitedPluginIds.has(plugin.id) || !host) return null;
        const isSelected = plugin.id === selectedPluginId;
        const context: PanelPluginContext = {
          size,
          theme,
          active: isSelected,
          organizationKey,
          objectReference: objectReferenceByPluginId[plugin.id] ?? null,
          services,
        };
        return (
          <div
            key={`${organizationKey}:${plugin.id}`}
            role="tabpanel"
            id={panelPluginPanelDomId(placement, plugin.id)}
            aria-labelledby={panelPluginTabDomId(placement, plugin.id)}
            hidden={!isSelected}
            className="min-h-0 flex-1"
          >
            <PanelPluginElementView manifest={plugin} context={context} host={host} />
          </div>
        );
      })}
    </>
  );
};
