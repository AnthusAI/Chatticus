import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPanelPluginLoader, fetchPanelPluginManifests, type PanelPluginElementRegistry } from "./panel-plugin-loader";
import { parsePanelPluginManifest, type PanelPluginManifest } from "./panel-plugin-manifest";

function manifestWith(overrides: Record<string, unknown> = {}): PanelPluginManifest {
  const result = parsePanelPluginManifest({
    id: "kanbus",
    name: "Kanbus",
    version: "1.0.0",
    entry: "/plugins/kanbus/index.js",
    elements: { panel: "kanbus-panel" },
    sizes: ["split"],
    ...overrides,
  });
  assert.equal(result.ok, true);
  return (result as { ok: true; manifest: PanelPluginManifest }).manifest;
}

function elementRegistryDefining(definedTags: Set<string>): PanelPluginElementRegistry & { define: (tag: string) => void } {
  const waiters = new Map<string, Array<() => void>>();
  const define = (tag: string) => {
    definedTags.add(tag);
    waiters.get(tag)?.forEach((resolve) => resolve());
  };
  return {
    get: (tag) => (definedTags.has(tag) ? {} : undefined),
    whenDefined: (tag) =>
      new Promise((resolve) => {
        if (definedTags.has(tag)) resolve(undefined);
        else waiters.set(tag, [...(waiters.get(tag) ?? []), () => resolve(undefined)]);
      }),
    define,
  };
}

describe("panel plugin loader", () => {
  it("imports the entry module once and reports ready when the panel element is defined", async () => {
    const imported: string[] = [];
    const elements = elementRegistryDefining(new Set());
    const loader = createPanelPluginLoader({
      importModule: async (entry) => {
        imported.push(entry);
        elements.define("kanbus-panel");
      },
      elements,
    });
    assert.deepEqual(await loader.load(manifestWith()), { status: "ready" });
    assert.deepEqual(await loader.load(manifestWith()), { status: "ready" });
    assert.deepEqual(imported, ["/plugins/kanbus/index.js"]);
  });

  it("does not import anything for a core plugin without an entry", async () => {
    let imports = 0;
    const loader = createPanelPluginLoader({ importModule: async () => void (imports += 1), elements: elementRegistryDefining(new Set(["kanbus-panel"])) });
    assert.deepEqual(await loader.load(manifestWith({ entry: undefined })), { status: "ready" });
    assert.equal(imports, 0);
  });

  it("reports a failed import and tries again on the next load", async () => {
    let attempts = 0;
    const elements = elementRegistryDefining(new Set());
    const loader = createPanelPluginLoader({
      importModule: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("network down");
        elements.define("kanbus-panel");
      },
      elements,
    });
    assert.deepEqual(await loader.load(manifestWith()), { status: "failed", message: "network down" });
    assert.deepEqual(await loader.load(manifestWith()), { status: "ready" });
  });

  it("fails when the module never defines the panel element", async () => {
    const loader = createPanelPluginLoader({
      importModule: async () => undefined,
      elements: elementRegistryDefining(new Set()),
      secondsToWaitForElementDefinition: 0.01,
    });
    assert.deepEqual(await loader.load(manifestWith()), { status: "failed", message: "The plugin never defined <kanbus-panel>." });
  });

  it("does not load plugins that ask for iframe isolation yet", async () => {
    let imports = 0;
    const loader = createPanelPluginLoader({ importModule: async () => void (imports += 1), elements: elementRegistryDefining(new Set()) });
    const state = await loader.load(manifestWith({ isolation: "iframe" }));
    assert.equal(state.status, "failed");
    assert.equal(imports, 0);
  });
});

describe("fetching panel plugin manifests", () => {
  it("keeps valid manifests and reports each problem with its URL", async () => {
    const documents: Record<string, unknown> = {
      "/a.json": { id: "a", name: "A", version: "1.0.0", elements: { panel: "a-panel" }, sizes: ["split"] },
      "/b.json": { id: "B" },
    };
    const { manifests, problems } = await fetchPanelPluginManifests(["/a.json", "/b.json", "/missing.json"], async (url) => {
      if (!(url in documents)) throw new Error("404");
      return documents[url];
    });
    assert.deepEqual(manifests.map((manifest) => manifest.id), ["a"]);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /^\/b\.json: /);
    assert.equal(problems[1], "/missing.json: 404");
  });
});
