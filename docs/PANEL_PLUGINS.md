# Panel plugins

The right-hand panel of the workspace is a plugin host. Context, Files and Costs are plugins, and so is anything added later (a Kanbus board, a code editor, a browser). This is the contract those plugins follow. The first draft lived in the project files as `panel-plugin-contract.md`.

## A plugin is a custom element described by a manifest

A manifest (`web/lib/panel-plugin-manifest.ts`) names the plugin, the custom element tags it defines, the sizes it supports and the object types it handles:

```json
{
  "id": "kanbus",
  "name": "Kanbus",
  "version": "0.1.0",
  "entry": "https://plugins.example/kanbus/0.1.0/index.js",
  "elements": { "panel": "kanbus-panel", "card": "kanbus-card" },
  "sizes": ["card", "split", "full"],
  "handles": ["kanbus.board", "kanbus.issue"],
  "permissions": ["workspace.files.read"]
}
```

- `entry` is an ES module (an https URL or a same-origin path). The host imports it and waits for `elements.panel` to be defined. A plugin bundles its own React, so React versions never meet across the element boundary. Core plugins have no entry.
- `isolation` defaults to `inline` (light DOM in the page, sharing the Chatticus CSS variables). `iframe` is reserved for the browser tab and third-party plugins and is refused by the loader until its `postMessage` bridge exists.
- The `card` size is declared and validated, but nothing renders cards in the transcript yet.

## What the host gives the element

The host creates the element and assigns the property `chatticus`, again each time anything changes:

```js
element.chatticus = { context, host };
```

- `context.size`: `card`, `split` or `full`. At `full` the conversation docks beside the panel.
- `context.theme`: `light` or `dark`.
- `context.active`: false while another tab is selected. Hidden plugins stay mounted, so pause polling when inactive.
- `context.objectReference`: the object last opened in this plugin, for example `{ type: "kanbus.issue", id: "chatticus-daa715" }`.
- `host.open(reference)`: opens the plugin whose manifest `handles` that type. Agents name object types, never components.
- `host.setTitle(title)` and `host.setStatus({ label, tone })`: rename the tab and show a badge.

Not built yet from the draft contract: `host.post`, `host.requestApproval`, `host.fetch`, `host.subscribe`, and `permissions` enforcement. The manifest already carries `permissions` so plugins can declare them now.

## Registering plugins

`panelPluginRegistry` (`web/lib/panel-plugin-registry.ts`) holds the tab order: core plugins first, then the others in registration order. Core ids cannot be replaced or removed. Set `NEXT_PUBLIC_PANEL_PLUGIN_MANIFEST_URLS` to a comma-separated list of manifest URLs and the workspace fetches and registers them at startup; invalid manifests are skipped with a console warning.

A plugin that fails to import, or never defines its element, shows an error in its own tab and leaves the other tabs working.

## Core plugins

`web/components/workspace/panel-plugins/core-panel-elements.tsx` defines `chatticus-context-panel`, `chatticus-files-panel` and `chatticus-costs-panel`. `defineReactPanelElement` wraps any React component in such an element, rendering it into its own React root. Core plugins receive their controllers through `context.services`, which only first-party plugins may rely on.

## Flat style

Plugins mark regions with the flat `surface-*` backgrounds (`--surface-0/1/2`) and never with borders, outlines or divider rules. See `docs/BRAND_GUIDELINES.md`.
