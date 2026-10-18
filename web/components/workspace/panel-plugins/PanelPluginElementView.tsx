"use client";

import { useEffect, useRef } from "react";

import {
  PANEL_PLUGIN_ELEMENT_PROPERTY,
  type PanelPluginContext,
  type PanelPluginElement,
  type PanelPluginHost,
} from "@/lib/panel-plugin-host-api";
import type { PanelPluginManifest } from "@/lib/panel-plugin-manifest";
import { usePanelPluginLoadState } from "./use-panel-plugin-load-state";

export function elementTagForSize(manifest: PanelPluginManifest, size: PanelPluginContext["size"]): string {
  return size === "card" ? (manifest.elements.card ?? manifest.elements.panel) : manifest.elements.panel;
}

export function PanelPluginElementView({
  manifest,
  context,
  host,
}: {
  manifest: PanelPluginManifest;
  context: PanelPluginContext;
  host: PanelPluginHost;
}) {
  const loadState = usePanelPluginLoadState(manifest);
  const containerRef = useRef<HTMLDivElement>(null);
  const elementRef = useRef<PanelPluginElement | null>(null);
  const latestBindingRef = useRef({ context, host });
  latestBindingRef.current = { context, host };
  const tag = elementTagForSize(manifest, context.size);

  useEffect(() => {
    if (loadState.status !== "ready" || containerRef.current === null) return;
    const container = containerRef.current;
    const element = document.createElement(tag) as PanelPluginElement;
    element[PANEL_PLUGIN_ELEMENT_PROPERTY] = latestBindingRef.current;
    elementRef.current = element;
    container.append(element);
    return () => {
      element.remove();
      elementRef.current = null;
    };
  }, [loadState.status, tag]);

  useEffect(() => {
    const element = elementRef.current;
    if (element) element[PANEL_PLUGIN_ELEMENT_PROPERTY] = { context, host };
  }, [context, host]);

  if (loadState.status === "failed") {
    return (
      <p role="alert" className="rounded-2xl bg-surface p-4 text-xs text-surface-foreground/70">
        {manifest.name} could not be loaded. {loadState.message}
      </p>
    );
  }
  if (loadState.status === "loading") {
    return <p role="status" className="rounded-2xl bg-surface p-4 text-xs text-surface-foreground/55">Loading {manifest.name}…</p>;
  }
  return <div ref={containerRef} className="h-full min-h-0" />;
}
