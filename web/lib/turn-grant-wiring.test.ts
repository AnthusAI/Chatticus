import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guard for chatticus-930da7: TurnGrantPanel existed, was fully tested, and was
 * imported by nothing, so turn authority controls did not exist in the product.
 *
 * WHAT THIS PROVES: EnabledWorkspace still references the panel and still gates
 * it on isTurnGrantPanelVisible. That is enough to catch the regression that
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

describe("TurnGrantPanel wiring", () => {
  it("EnabledWorkspace imports TurnGrantPanel", () => {
    assert.match(
      source,
      /import\s*{[^}]*\bTurnGrantPanel\b[^}]*}\s*from\s*["']\.\/TurnGrantPanel["']/,
      "EnabledWorkspace.tsx must import TurnGrantPanel",
    );
  });

  it("EnabledWorkspace imports isTurnGrantPanelVisible", () => {
    assert.match(
      source,
      /import\s*{[^}]*\bisTurnGrantPanelVisible\b[^}]*}\s*from\s*["']\.\.\/lib\/turn-grant["']/,
      "EnabledWorkspace.tsx must import isTurnGrantPanelVisible from lib/turn-grant",
    );
  });

  it("renders TurnGrantPanel gated on isTurnGrantPanelVisible", () => {
    // Whitespace- and argument-agnostic: only that the gate precedes the render,
    // close enough together to be the same expression.
    assert.match(
      source,
      /isTurnGrantPanelVisible\s*\([\s\S]{0,120}?<TurnGrantPanel\b/,
      "EnabledWorkspace.tsx must render TurnGrantPanel gated on isTurnGrantPanelVisible",
    );
  });

  it("passes activeOrg and turnId to TurnGrantPanel", () => {
    const tag = source.match(/<TurnGrantPanel\b[\s\S]*?\/>/);
    assert.ok(tag, "expected a self-closing <TurnGrantPanel /> element");
    assert.match(tag[0], /\bactiveOrg=/, "TurnGrantPanel needs an activeOrg prop");
    assert.match(tag[0], /\bturnId=/, "TurnGrantPanel needs a turnId prop");
  });
});
