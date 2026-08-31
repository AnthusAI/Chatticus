import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  avatarActivityAfterEvent,
  avatarActivityFromTurn,
  botAvatarAriaLabel,
  botAvatarStateFromActivity,
} from "./avatar-state";
import type { TurnEvent } from "./api";

function event(kind: string, seq: number): TurnEvent {
  return { kind, seq, turn_id: "turn-1" };
}

describe("avatarActivityAfterEvent", () => {
  it("maps turn lifecycle kinds to avatar activity", () => {
    assert.equal(avatarActivityAfterEvent("idle", "turn.started"), "thinking");
    assert.equal(avatarActivityAfterEvent("thinking", "turn.waiting"), "waiting");
    assert.equal(avatarActivityAfterEvent("thinking", "turn.token"), "speaking");
    assert.equal(avatarActivityAfterEvent("speaking", "turn.completed"), "completed");
    assert.equal(avatarActivityAfterEvent("speaking", "turn.failed"), "idle");
  });
});

describe("avatarActivityFromTurn", () => {
  it("tracks the latest event across a turn", () => {
    const events = [
      event("turn.started", 1),
      event("turn.token", 2),
      event("turn.token", 3),
    ];
    assert.equal(avatarActivityFromTurn(events, "active", false), "speaking");
  });

  it("shows thinking while a turn is active but quiet", () => {
    assert.equal(
      avatarActivityFromTurn([event("turn.started", 1)], "active", false),
      "thinking",
    );
  });

  it("shows thinking while sending before stream events arrive", () => {
    assert.equal(avatarActivityFromTurn([], null, true), "thinking");
  });

  it("returns completed when the turn finished", () => {
    const events = [event("turn.started", 1), event("turn.token", 2)];
    assert.equal(avatarActivityFromTurn(events, "completed", false), "completed");
  });
});

describe("botAvatarStateFromActivity", () => {
  it("maps activity to Vultus states", () => {
    assert.equal(botAvatarStateFromActivity("idle"), "neutral");
    assert.equal(botAvatarStateFromActivity("thinking"), "thinking");
    assert.equal(botAvatarStateFromActivity("waiting"), "toolCalling");
    assert.equal(botAvatarStateFromActivity("speaking"), "speakingOpen");
    assert.equal(botAvatarStateFromActivity("completed"), "speakingComplete");
  });
});

describe("botAvatarAriaLabel", () => {
  it("describes the avatar activity for screen readers", () => {
    assert.equal(botAvatarAriaLabel("Luna", "speaking"), "Luna is speaking");
    assert.equal(botAvatarAriaLabel("Luna", "idle"), "Luna avatar");
  });
});
