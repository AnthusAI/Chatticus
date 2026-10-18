import { createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  PANEL_PLUGIN_ELEMENT_PROPERTY,
  type PanelPluginElementBinding,
} from "@/lib/panel-plugin-host-api";

export function defineReactPanelElement(tagName: string, PanelComponent: ComponentType<PanelPluginElementBinding>): void {
  if (customElements.get(tagName) !== undefined) return;

  class ReactPanelElement extends HTMLElement {
    private reactRoot: Root | null = null;
    private currentBinding: PanelPluginElementBinding | undefined;

    get [PANEL_PLUGIN_ELEMENT_PROPERTY](): PanelPluginElementBinding | undefined {
      return this.currentBinding;
    }

    set [PANEL_PLUGIN_ELEMENT_PROPERTY](binding: PanelPluginElementBinding | undefined) {
      this.currentBinding = binding;
      this.renderCurrentBinding();
    }

    connectedCallback() {
      this.style.display = "block";
      this.style.height = "100%";
      this.renderCurrentBinding();
    }

    disconnectedCallback() {
      const rootToUnmount = this.reactRoot;
      this.reactRoot = null;
      queueMicrotask(() => rootToUnmount?.unmount());
    }

    private renderCurrentBinding() {
      if (!this.isConnected || this.currentBinding === undefined) return;
      this.reactRoot ??= createRoot(this);
      this.reactRoot.render(createElement(PanelComponent, this.currentBinding));
    }
  }

  customElements.define(tagName, ReactPanelElement);
}
