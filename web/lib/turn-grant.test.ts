import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildRevokePayload,
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

describe("turn grant revocation", () => {
  it("buildRevokePayload() returns every field as an empty array", () => {
    const payload = buildRevokePayload();
    assert.deepEqual(payload.tools, []);
    assert.deepEqual(payload.origins, []);
    assert.deepEqual(payload.recipients, []);
    assert.deepEqual(payload.file_scopes, []);
    assert.deepEqual(payload.egress_classes, []);
    assert.deepEqual(payload.ingest_classes, []);
  });

  it("turnGrantConfirmationText([]) returns the revocation message and does not contain 'Turn grant updated'", () => {
    const message = turnGrantConfirmationText([]);
    assert.equal(message.includes("Turn grant updated"), false);
    assert.match(message, /revoked/i);
    assert.notEqual(message.trim(), "");
  });

  it("turnGrantConfirmationText(['read_workspace']) still returns the existing updated message", () => {
    const message = turnGrantConfirmationText(["read_workspace"]);
    assert.equal(message, "Turn grant updated: read_workspace.");
  });

  it("buildTurnGrantPayload(DEFAULT_TURN_GRANT_FORM) still returns null (guard intact)", () => {
    assert.equal(buildTurnGrantPayload(DEFAULT_TURN_GRANT_FORM), null);
  });
});
