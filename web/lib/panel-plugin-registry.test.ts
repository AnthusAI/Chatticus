import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePanelPluginManifest, type PanelPluginManifest } from "./panel-plugin-manifest";
import { CORE_PANEL_PLUGIN_MANIFESTS, createPanelPluginRegistry } from "./panel-plugin-registry";
import { nextPanelPlugin, panelSizeForPlugin } from "./panel-plugins";

function manifestNamed(id: string, overrides: Record<string, unknown> = {}): PanelPluginManifest {
  const result = parsePanelPluginManifest({
    id,
    name: id,
    version: "1.0.0",
    elements: { panel: `${id}-panel` },
    sizes: ["split", "full"],
    handles: [`${id}.thing`],
    ...overrides,
  });
  assert.equal(result.ok, true);
  return (result as { ok: true; manifest: PanelPluginManifest }).manifest;
}

describe("panel plugin registry", () => {
  it("starts with the core plugins in tab order", () => {
    assert.deepEqual(createPanelPluginRegistry().list().map((plugin) => plugin.id), ["context", "files", "costs", "board"]);
  });

  it("appends registered plugins after the core plugins and notifies subscribers", () => {
    const registry = createPanelPluginRegistry();
    let notifications = 0;
    const unsubscribe = registry.subscribe(() => (notifications += 1));
    assert.deepEqual(registry.register(manifestNamed("notebook")), { ok: true, replaced: false });
    assert.deepEqual(registry.list().map((plugin) => plugin.id), ["context", "files", "costs", "board", "notebook"]);
    assert.equal(notifications, 1);
    unsubscribe();
    registry.unregister("notebook");
    assert.equal(notifications, 1);
  });

  it("replaces a plugin registered again in the same position", () => {
    const registry = createPanelPluginRegistry();
    registry.register(manifestNamed("notebook"));
    registry.register(manifestNamed("browser"));
    assert.deepEqual(registry.register(manifestNamed("notebook", { version: "2.0.0" })), { ok: true, replaced: true });
    assert.deepEqual(registry.list().map((plugin) => `${plugin.id}@${plugin.version}`).slice(4), ["notebook@2.0.0", "browser@1.0.0"]);
  });

  it("refuses to replace or remove a core plugin", () => {
    const registry = createPanelPluginRegistry();
    assert.deepEqual(registry.register(manifestNamed("files")), { ok: false, reason: "core_plugin_is_reserved" });
    registry.unregister("files");
    assert.equal(registry.list().length, CORE_PANEL_PLUGIN_MANIFESTS.length);
  });

  it("finds the plugin that handles an object type", () => {
    const registry = createPanelPluginRegistry();
    registry.register(manifestNamed("notebook", { handles: ["notes.page", "notes.index"] }));
    assert.equal(registry.findHandlerOfObjectType("notes.index")?.id, "notebook");
    assert.equal(registry.findHandlerOfObjectType("file")?.id, "files");
    assert.equal(registry.findHandlerOfObjectType("unknown"), null);
  });

  it("keeps the registered list stable between changes so subscribers can compare snapshots", () => {
    const registry = createPanelPluginRegistry();
    assert.equal(registry.list(), registry.list());
  });

  it("moves between registered plugins with the keyboard and falls back to split for unsupported sizes", () => {
    const registry = createPanelPluginRegistry();
    registry.register(manifestNamed("cardonly", { sizes: ["card"], elements: { panel: "cardonly-panel", card: "cardonly-card" } }));
    const plugins = registry.list();
    assert.equal(nextPanelPlugin("board", "ArrowRight", plugins), "cardonly");
    assert.equal(nextPanelPlugin("cardonly", "ArrowRight", plugins), "context");
    assert.equal(panelSizeForPlugin("cardonly", "full", plugins), "split");
    assert.equal(panelSizeForPlugin("files", "full", plugins), "full");
  });
});
