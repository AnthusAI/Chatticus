"use client";

import { useEffect, useSyncExternalStore } from "react";

import { fetchPanelPluginManifests } from "@/lib/panel-plugin-loader";

import type { PanelPluginManifest } from "@/lib/panel-plugin-manifest";
import { panelPluginRegistry } from "@/lib/panel-plugin-registry";

export function useRegisteredPanelPlugins(): ReadonlyArray<PanelPluginManifest> {
  return useSyncExternalStore(panelPluginRegistry.subscribe, panelPluginRegistry.list, panelPluginRegistry.list);
}

export function useConfiguredPanelPluginManifests(manifestUrls: readonly string[]): void {
  const manifestUrlsKey = manifestUrls.join("\n");
  useEffect(() => {
    const urls = manifestUrlsKey === "" ? [] : manifestUrlsKey.split("\n");
    if (urls.length === 0) return;
    let cancelled = false;
    void fetchPanelPluginManifests(urls, async (url) => (await fetch(url)).json()).then(({ manifests, problems }) => {
      if (cancelled) return;
      manifests.forEach((manifest) => panelPluginRegistry.register(manifest));
      problems.forEach((problem) => console.warn(`Panel plugin manifest skipped: ${problem}`));
    });
    return () => {
      cancelled = true;
    };
  }, [manifestUrlsKey]);
}

export function configuredPanelPluginManifestUrls(rawValue: string | undefined): readonly string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}
