import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getSendBlockMessage,
  getSendBlockReason,
  resolveVisibleTurnState,
  shouldClearTurnBubbleAfterTerminal,
  shouldStickTranscriptScroll,
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

describe("getSendBlockReason", () => {
  it("blocks when no bot is selected", () => {
    assert.equal(getSendBlockReason(false, null, ""), "no-bot-selected");
  });

  it("blocks when sending is already in progress", () => {
    assert.equal(getSendBlockReason(true, null, "bot-123"), "sending");
  });

  it("blocks when waiting for a turn to complete", () => {
    assert.equal(getSendBlockReason(false, { turn_id: "t1" }, "bot-123"), "waiting-for-turn");
  });

  it("allows sending when a bot is selected and no turn is active", () => {
    assert.equal(getSendBlockReason(false, null, "bot-123"), null);
  });

  it("prioritizes no-bot-selected over other conditions", () => {
    // Even if sending=true and turn exists, if no bot is selected, that's the primary blocker
    assert.equal(getSendBlockReason(true, { turn_id: "t1" }, ""), "no-bot-selected");
  });

  it("prioritizes sending over waiting-for-turn", () => {
    // When actively sending, that takes priority over waiting for a turn
    assert.equal(getSendBlockReason(true, { turn_id: "t1" }, "bot-123"), "sending");
  });
});

describe("getSendBlockMessage", () => {
  it("returns null when sending is allowed", () => {
    assert.equal(getSendBlockMessage(null), null);
  });

  it("provides a message for no-bot-selected", () => {
    assert.equal(getSendBlockMessage("no-bot-selected"), "Select a bot to start the conversation.");
  });

  it("provides a message for sending", () => {
    assert.equal(getSendBlockMessage("sending"), "Message is being sent…");
  });

  it("provides a message for waiting-for-turn", () => {
    assert.equal(getSendBlockMessage("waiting-for-turn"), "Waiting for the bot to finish responding.");
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

describe("shouldStickTranscriptScroll", () => {
  it("always sticks when the channel selection changed", () => {
    assert.equal(shouldStickTranscriptScroll(true, 500), true);
  });

  it("sticks only when the viewport was near the bottom", () => {
    assert.equal(shouldStickTranscriptScroll(false, 100), true);
    assert.equal(shouldStickTranscriptScroll(false, 101), false);
  });
});
