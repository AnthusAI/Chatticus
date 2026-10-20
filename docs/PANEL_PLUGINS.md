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

`web/components/workspace/panel-plugins/core-panel-elements.tsx` defines `chatticus-context-panel`, `chatticus-files-panel`, `chatticus-costs-panel` and `chatticus-board-panel`. `defineReactPanelElement` wraps any React component in such an element, rendering it into its own React root. Core plugins receive their controllers through `context.services`, which only first-party plugins may rely on.

## The Board plugin (Kanbus)

The Board tab shows a Kanbus project that lives in the organization's workspace. A Kanbus project keeps one JSON file per issue under `project/issues/`. The panel finds `/workspace/project/issues`, or the first top-level folder of the workspace that has `project/issues`, lists it, and reads the issue files through the member file routes (`GET /computer/files` and `GET /computer/files/content`). Those routes answer from the saved copy while the computer is off, so the board does not need the computer running. The panel only reads.

Limits of that data path, all from `docs/LIVE_FILES_PROTOCOL.md`: there is no bulk read, so a load is one listing plus one read per issue file; reads are rate limited to 240 per user per minute and shared with the Files tab; a listing returns at most 2000 entries; a read returns at most 256 KiB. The panel therefore reads at most 200 issue files (the most recently modified first), four at a time, remembers each file by its content hash so a refresh re-reads only changed files, and says plainly when it shows fewer issues than the project holds. A bulk read route, or a server-side board route, is the next step if boards outgrow this.

Columns are the statuses in the default Kanbus workflow order (backlog, open, in progress, blocked, closed), with open, in progress and closed always shown and any other status that has an issue added after. Cards sort by priority and then by most recent update, and show the title, id, type, priority, labels, the parent id and the number of children.

Theming is a small set of CSS custom properties the panel reads, each falling back to the workspace `--surface-*` tokens, so light and dark need no extra rules. Set them on any ancestor of the panel to restyle the board without touching the panel:

| Property | Default | Meaning |
| --- | --- | --- |
| `--kb-board-gap` | `0.5rem` | Space between columns |
| `--kb-column-width` | `16rem` | Column width (at most 85% of the panel, so a column never fills a phone) |
| `--kb-column-radius` | `1rem` | Column corner radius |
| `--kb-column-background` | `var(--surface-0)` | Column background |
| `--kb-card-radius` | `0.75rem` | Card corner radius |
| `--kb-card-background` | `var(--surface-1)` | Card background |
| `--kb-card-gap` | `0.5rem` | Space between cards |
| `--kb-card-shadow` | `none` | Card hard-edge shadow |

The names with the `--kb-` prefix are the ones `@kanbus/ui` already uses for the same things in its scoped newsprint theme (`--kb-board-gap`, `--kb-column-width`, `--kb-column-radius`, `--kb-card-radius`, `--kb-card-gap`, `--kb-card-shadow`), so a Kanbus theme can be applied here by setting those properties. `@kanbus/ui` itself is not a dependency: it is MIT licensed but not published to npm, it peers on React 18 while the web app is on React 19, and its stylesheet sets global `:root` and `html.dark` variables and uses borders and outlines, which the brand rules forbid.

## Flat style

Plugins mark regions with the flat `surface-*` backgrounds (`--surface-0/1/2`) and never with borders, outlines or divider rules. See `docs/BRAND_GUIDELINES.md`.
