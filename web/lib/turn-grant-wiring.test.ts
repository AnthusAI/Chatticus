import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guard for chatticus-930da7: TurnGrantPanel existed, was fully tested, and was
 * imported by nothing, so turn authority controls did not exist in the product.
 *
 * WHAT THIS PROVES: the Context panel element still renders the panel, and
 * EnabledWorkspace still decides when to offer it with isTurnGrantPanelVisible. That is enough to catch the regression that
 * actually happened — the component being orphaned.
 *
 * WHAT THIS DOES NOT PROVE: that the panel renders. These assertions read source
 * text; they cannot tell a mounted component from one inside an unreachable
 * branch. Replace this with a real render assertion when the web suite can mount
 * components. Keep the patterns loose — pinning exact formatting turns routine
 * reformatting into a false failure rather than a caught defect.
 */
const source = readFileSync(
  join(__dirname, "..", "components", "EnabledWorkspace.tsx"),
  "utf8",
);

const contextPanelSource = readFileSync(
  join(__dirname, "..", "components", "workspace", "panel-plugins", "core-panel-elements.tsx"),
  "utf8",
);

describe("TurnGrantPanel wiring", () => {
  it("the Context panel element imports TurnGrantPanel", () => {
    assert.match(
      contextPanelSource,
      /import\s*{[^}]*\bTurnGrantPanel\b[^}]*}\s*from\s*["']@\/components\/TurnGrantPanel["']/,
      "core-panel-elements.tsx must import TurnGrantPanel",
    );
  });

  it("EnabledWorkspace imports isTurnGrantPanelVisible", () => {
    assert.match(
      source,
      /import\s*{[^}]*\bisTurnGrantPanelVisible\b[^}]*}\s*from\s*["']\.\.\/lib\/turn-grant["']/,
      "EnabledWorkspace.tsx must import isTurnGrantPanelVisible from lib/turn-grant",
    );
  });

  it("EnabledWorkspace gates the grant offered to the Context panel on isTurnGrantPanelVisible", () => {
    assert.match(
      source,
      /turnGrantTurnId:[^\n]*isTurnGrantPanelVisible\s*\(/,
      "EnabledWorkspace.tsx must set turnGrantTurnId only when isTurnGrantPanelVisible says so",
    );
  });

  it("the Context panel element renders TurnGrantPanel only when a grant turn is offered", () => {
    assert.match(
      contextPanelSource,
      /turnGrantTurnId\s*!==\s*null\s*\?\s*<TurnGrantPanel\b/,
      "core-panel-elements.tsx must render TurnGrantPanel gated on turnGrantTurnId",
    );
  });

  it("passes activeOrg and turnId to TurnGrantPanel", () => {
    const tag = contextPanelSource.match(/<TurnGrantPanel\b[\s\S]*?\/>/);
    assert.ok(tag, "expected a self-closing <TurnGrantPanel /> element");
    assert.match(tag[0], /\bactiveOrg=/, "TurnGrantPanel needs an activeOrg prop");
    assert.match(tag[0], /\bturnId=/, "TurnGrantPanel needs a turnId prop");
  });
});
