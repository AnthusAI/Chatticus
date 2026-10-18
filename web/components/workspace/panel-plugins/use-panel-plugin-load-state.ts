"use client";

import { useEffect, useState } from "react";

import { createPanelPluginLoader, type PanelPluginLoadState } from "@/lib/panel-plugin-loader";
import type { PanelPluginManifest } from "@/lib/panel-plugin-manifest";
import { defineCorePanelElements } from "./core-panel-elements";

let sharedLoader: ReturnType<typeof createPanelPluginLoader> | null = null;

function panelPluginLoader() {
  sharedLoader ??= createPanelPluginLoader({
    importModule: (entry) => import(/* webpackIgnore: true */ entry),
    elements: customElements,
  });
  return sharedLoader;
}

export function usePanelPluginLoadState(manifest: PanelPluginManifest): PanelPluginLoadState {
  const [loadState, setLoadState] = useState<PanelPluginLoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setLoadState({ status: "loading" });
    if (manifest.entry === null) defineCorePanelElements();
    void panelPluginLoader()
      .load(manifest)
      .then((state) => {
        if (!cancelled) setLoadState(state);
      });
    return () => {
      cancelled = true;
    };
  }, [manifest]);

  return loadState;
}
