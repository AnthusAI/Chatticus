import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("TurnGrantPanel wiring", () => {
  it("EnabledWorkspace imports TurnGrantPanel", () => {
    const enabledWorkspacePath = join(__dirname, "..", "components", "EnabledWorkspace.tsx");
    const content = readFileSync(enabledWorkspacePath, "utf8");
    assert.match(
      content,
      /import\s+{\s*TurnGrantPanel\s*}\s+from\s+["']\.\/TurnGrantPanel["']/,
      "EnabledWorkspace.tsx must import TurnGrantPanel"
    );
  });

  it("EnabledWorkspace imports isTurnGrantPanelVisible", () => {
    const enabledWorkspacePath = join(__dirname, "..", "components", "EnabledWorkspace.tsx");
    const content = readFileSync(enabledWorkspacePath, "utf8");
    assert.match(
      content,
      /import\s+{\s*isTurnGrantPanelVisible\s*}\s+from\s+["']\.\.\/lib\/turn-grant["']/,
      "EnabledWorkspace.tsx must import isTurnGrantPanelVisible from lib/turn-grant"
    );
  });

  it("EnabledWorkspace renders TurnGrantPanel conditionally", () => {
    const enabledWorkspacePath = join(__dirname, "..", "components", "EnabledWorkspace.tsx");
    const content = readFileSync(enabledWorkspacePath, "utf8");
    assert.match(
      content,
      /isTurnGrantPanelVisible\s*\(\s*turn\?\.turn_id\s*\?\?\s*null\s*,\s*turnStatus\s*\)\s*\?[\s\S]*<TurnGrantPanel/,
      "EnabledWorkspace.tsx must render TurnGrantPanel conditionally using isTurnGrantPanelVisible"
    );
  });

  it("TurnGrantPanel receives activeOrg and turnId props", () => {
    const enabledWorkspacePath = join(__dirname, "..", "components", "EnabledWorkspace.tsx");
    const content = readFileSync(enabledWorkspacePath, "utf8");
    assert.match(
      content,
      /<TurnGrantPanel\s+activeOrg={activeOrg}\s+turnId={turn!\.turn_id}\s*\/>/,
      "TurnGrantPanel must be rendered with activeOrg and turnId props"
    );
  });
});
