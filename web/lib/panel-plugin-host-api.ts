import type { PanelPluginElementSize } from "./panel-plugin-manifest";

export type PanelPluginObjectReference = {
  type: string;
  [property: string]: unknown;
};

export type PanelPluginStatus = {
  label: string;
  tone: "neutral" | "attention" | "danger";
};

export type PanelPluginTheme = "light" | "dark";

export type PanelPluginContext = {
  size: PanelPluginElementSize;
  theme: PanelPluginTheme;
  active: boolean;
  organizationKey: string;
  objectReference: PanelPluginObjectReference | null;
  services: unknown;
};

export type PanelPluginHost = {
  open: (objectReference: PanelPluginObjectReference) => void;
  setTitle: (title: string) => void;
  setStatus: (status: PanelPluginStatus | null) => void;
};

export type PanelPluginElementBinding = {
  context: PanelPluginContext;
  host: PanelPluginHost;
};

export const PANEL_PLUGIN_ELEMENT_PROPERTY = "chatticus";

export type PanelPluginElement = HTMLElement & {
  [PANEL_PLUGIN_ELEMENT_PROPERTY]?: PanelPluginElementBinding;
};
