import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePanelPluginManifest } from "./panel-plugin-manifest";

const validManifest = {
  id: "kanbus",
  name: "Kanbus",
  icon: "kanban",
  version: "0.1.0",
  entry: "https://plugins.chatticus.app/kanbus/0.1.0/index.js",
  isolation: "inline",
  elements: { panel: "kanbus-panel", card: "kanbus-card" },
  sizes: ["card", "split", "full"],
  handles: ["kanbus.board", "kanbus.issue"],
  permissions: ["workspace.files.read"],
};

function problemsOf(raw: unknown): readonly string[] {
  const result = parsePanelPluginManifest(raw);
  assert.equal(result.ok, false);
  return result.ok ? [] : result.problems;
}

describe("panel plugin manifest", () => {
  it("accepts the manifest from the plugin contract", () => {
    const result = parsePanelPluginManifest(validManifest);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.manifest.elements.card, "kanbus-card");
      assert.deepEqual(result.manifest.handles, ["kanbus.board", "kanbus.issue"]);
    }
  });

  it("defaults optional fields", () => {
    const result = parsePanelPluginManifest({ id: "notes", name: "Notes", version: "1.0.0", elements: { panel: "notes-panel" }, sizes: ["split"] });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.manifest.isolation, "inline");
      assert.equal(result.manifest.entry, null);
      assert.deepEqual(result.manifest.permissions, []);
    }
  });

  it("accepts a same-origin entry path and refuses other entries", () => {
    assert.equal(parsePanelPluginManifest({ ...validManifest, entry: "/plugins/kanbus/index.js" }).ok, true);
    for (const entry of ["http://plugins.example/index.js", "//evil.example/index.js", "/../secret.js", "javascript:alert(1)", "https://user:pass@example.com/x.js", "plugin.js"]) {
      assert.match(problemsOf({ ...validManifest, entry }).join(" "), /entry/, entry);
    }
  });

  it("requires custom element names with a hyphen", () => {
    assert.match(problemsOf({ ...validManifest, elements: { panel: "kanbus" } }).join(" "), /elements\.panel/);
    assert.match(problemsOf({ ...validManifest, elements: { panel: "font-face" } }).join(" "), /elements\.panel/);
  });

  it("requires a card element when the card size is supported", () => {
    assert.match(problemsOf({ ...validManifest, elements: { panel: "kanbus-panel" } }).join(" "), /elements\.card/);
  });

  it("reports every problem at once", () => {
    const problems = problemsOf({ id: "Bad Id", name: "", version: "one", elements: {}, sizes: [], handles: ["Bad"], permissions: ["nodots"] });
    assert.ok(problems.length >= 6, problems.join("\n"));
  });

  it("rejects values that are not objects", () => {
    assert.deepEqual(problemsOf(null), ["The manifest must be a JSON object."]);
    assert.deepEqual(problemsOf([]), ["The manifest must be a JSON object."]);
  });
});
