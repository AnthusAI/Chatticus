import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isComposerSendBlocked,
  resolveVisibleTurnState,
  shouldClearTurnBubbleAfterTerminal,
  turnPresentation,
} from "./workspace-state";

describe("resolveVisibleTurnState", () => {
  it("does not show Completed when the turn bubble was cleared", () => {
    assert.equal(resolveVisibleTurnState("completed", null, ""), null);
  });

  it("shows Completed while the terminal bubble is still visible", () => {
    assert.equal(
      resolveVisibleTurnState("completed", { waiting_for: null }, ""),
      "completed",
    );
  });

  it("maps streaming and waiting from the active turn", () => {
    assert.equal(
      resolveVisibleTurnState("active", { waiting_for: "approval" }, ""),
      "waiting",
    );
    assert.equal(
      resolveVisibleTurnState("active", { waiting_for: null }, "Hello"),
      "streaming",
    );
  });
});

describe("isComposerSendBlocked", () => {
  it("blocks while sending or while a turn bubble is open", () => {
    assert.equal(isComposerSendBlocked(true, null), true);
    assert.equal(isComposerSendBlocked(false, { turn_id: "t1" }), true);
    assert.equal(isComposerSendBlocked(false, null), false);
  });
});

describe("shouldClearTurnBubbleAfterTerminal", () => {
  it("clears the bubble after success or failure", () => {
    assert.equal(shouldClearTurnBubbleAfterTerminal("turn.completed"), true);
    assert.equal(shouldClearTurnBubbleAfterTerminal("turn.failed"), true);
    assert.equal(shouldClearTurnBubbleAfterTerminal("turn.reconciling"), false);
  });
});

describe("turnPresentation", () => {
  it("labels header states for humans", () => {
    assert.equal(turnPresentation("completed"), "Completed");
  });
});
