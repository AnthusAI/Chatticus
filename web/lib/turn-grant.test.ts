import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildTurnGrantPayload,
  DEFAULT_TURN_GRANT_FORM,
  grantTableToPayload,
  turnGrantConfirmationText,
} from "./turn-grant";

describe("turn grant payload builder", () => {
  it("returns null when no tools are selected", () => {
    assert.equal(buildTurnGrantPayload(DEFAULT_TURN_GRANT_FORM), null);
  });

  it("requires an origin when browse is selected", () => {
    const payload = buildTurnGrantPayload({
      ...DEFAULT_TURN_GRANT_FORM,
      browse: true,
      origins: "",
    });
    assert.equal(payload, null);
  });

  it("omits run_terminal unless explicitly checked", () => {
    const payload = buildTurnGrantPayload({
      ...DEFAULT_TURN_GRANT_FORM,
      browse: true,
      origins: "https://docs.example.com",
    });
    assert.ok(payload);
    assert.equal(payload.tools.includes("run_terminal"), false);
  });

  it("includes run_terminal only when checked", () => {
    const payload = buildTurnGrantPayload({
      ...DEFAULT_TURN_GRANT_FORM,
      readWorkspace: true,
      runTerminal: true,
      fileScopes: "/workspace",
    });
    assert.ok(payload);
    assert.deepEqual(payload.tools.sort(), ["read_workspace", "run_terminal"]);
  });

  it("builds browse grants with approved_origin_fetch egress", () => {
    const payload = grantTableToPayload({
      tools: "browse",
      origins: "https://docs.example.com",
      recipients: "",
      file_scopes: "/workspace/docs",
      egress_classes: "approved_origin_fetch",
    });
    assert.deepEqual(payload.tools, ["browse"]);
    assert.deepEqual(payload.origins, ["https://docs.example.com"]);
    assert.deepEqual(payload.egress_classes, ["approved_origin_fetch"]);
    assert.deepEqual(payload.recipients, []);
    assert.deepEqual(payload.ingest_classes, []);
  });

  it("formats confirmation text from sorted tools", () => {
    assert.equal(
      turnGrantConfirmationText(["browse", "read_workspace"]),
      "Turn grant updated: browse, read_workspace.",
    );
  });
});
