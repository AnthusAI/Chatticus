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

The Board tab has a picker (the Boards button) with two sections. Project boards are the Kanbus project found in the workspace files, as described next. Bot boards are the boards of the organization's bots, read through the front door routes `GET /orgs/{org}/bots/{bot}/board` and `.../board/cards` (`web/lib/bot-boards-api.ts`; the web never talks to Kanbus). Both go to the same frame and the same `IssueCollection`; only the source of the cards differs. `BoardWorkspaceController` (`web/lib/board-workspace-controller.ts`) holds the picker, the remembered choice (local storage, per organization and person) and the states; `web/lib/bot-board-adapter.ts` turns the front door's Kanbus issue JSON and the board's own configuration (statuses, categories, priorities, type colors, workflows) into `KanbanIssue` and `KanbanConfig`. A bot board needs no computer, reads at most 200 cards (100 per page), says when the listing may be behind, and when the environment has no board service (`404 board_service_not_enabled`) the Bot boards section says so in one line and shows no error. The first slice is read-only. Behavior: `features/web_bot_board_picker.feature`.

The Board tab shows a Kanbus project that lives in the organization's workspace. A Kanbus project keeps one JSON file per issue under `project/issues/`. The panel finds `/workspace/project/issues`, or the first top-level folder of the workspace that has `project/issues`, lists it, and reads the issue files through the member file routes (`GET /computer/files` and `GET /computer/files/content`). Those routes answer from the saved copy while the computer is off, so the board does not need the computer running. The panel only reads.

Limits of that data path, all from `docs/LIVE_FILES_PROTOCOL.md`: there is no bulk read, so a load is one listing plus one read per issue file; reads are rate limited to 240 per user per minute and shared with the Files tab; a listing returns at most 2000 entries; a read returns at most 256 KiB. The panel therefore reads at most 200 issue files (the most recently modified first), four at a time, remembers each file by its content hash so a refresh re-reads only changed files, and says plainly when it shows fewer issues than the project holds. A bulk read route, or a server-side board route, is the next step if boards outgrow this.

The columns and cards are drawn by the Kanbus project's own component, `IssueCollection` from `@kanbus/ui` (which composes the Kanbus `Board`, `BoardColumn` and `IssueCard`). Chatticus does not draw a column or a card. It parses the issue files into the component's `KanbanIssue` records and builds a `KanbanConfig` (`web/lib/kanbus-board.ts`): the open, in progress and closed statuses always, any other status that has an issue after them in the default Kanbus workflow order, the default priority names, and a color per issue type. The component's own sort rules order the cards, and its column headers collapse and expand. The panel passes no selection handler, so it stays read-only.

`@kanbus/ui` is a dependency of `web` installed from the immutable `kanbus-ui-0.3.1.tgz` asset of the public `AnthusAI/Kanbus` release `ui-v0.3.1` (the package is not on the npm registry). The lockfile records the tarball's integrity hash, so `npm ci` fetches exactly that file with no credentials. To move to a newer release, change the version in both places of the URL in `web/package.json` and run `npm install`.

The package's stylesheet is imported by `web/styles/kanbus-board.css`, which also maps the component's variables to the workspace tokens, inside the `.chatticus-kanbus-board` wrapper only. The package's `tokens.css` is not imported, because it sets `--font-body` and `--font-mono` on `:root`, which the workspace also uses. The component keys its dark palette off a `.dark` ancestor while the workspace follows `prefers-color-scheme`, so the wrapper gets the `dark` class when the panel's `context.theme` is `dark`. The package uses Tailwind utilities, so `web/tailwind.config.ts` scans the package's `dist` and maps the colors it names (`card`, `muted`, `foreground` and so on) to those variables.

The look is set by the package's own `--kb-*` variables, set on the wrapper and flat by default (no card border, no shadow):

| Property | Value in the wrapper | Meaning |
| --- | --- | --- |
| `--kb-board-gap` | `0.5rem` | Space between columns |
| `--kb-column-width` | `min(20rem, 85%)` | Column width (at most 85% of the panel, so a column never fills a phone) |
| `--kb-column-radius` | `1rem` | Column corner radius |
| `--kb-card-radius` | `0.75rem` | Card corner radius |
| `--kb-card-gap` | `0.5rem` | Space between cards |
| `--kb-card-border` | `0 solid transparent` | Card border |
| `--kb-card-shadow` | `none` | Card shadow |

The card color is `--surface-0`, the text colors follow `--surface-foreground`, and the keyboard focus ring is the component's own, in `--cobalt`.

## Flat style

Plugins mark regions with the flat `surface-*` backgrounds (`--surface-0/1/2`) and never with borders, outlines or divider rules. See `docs/BRAND_GUIDELINES.md`.
