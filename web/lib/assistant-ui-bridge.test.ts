import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Message } from "./api";
import {
  buildChatticusThreadMessages,
  convertChatticusThreadMessage,
  streamingAssistantPlaceholder,
  streamingMessageId,
  textFromAppendMessageContent,
} from "./assistant-ui-bridge";

const sampleMessage = (overrides: Partial<Message> = {}): Message => ({
  message_id: "m1",
  channel_id: "c1",
  tenant_id: "t1",
  seq: 1,
  author_kind: "human",
  author_id: "u1",
  body: "Hello",
  addressed_to_bot_id: "b1",
  created_at: "2026-01-01T12:00:00.000Z",
  ...overrides,
});

describe("buildChatticusThreadMessages", () => {
  it("returns committed messages only when no turn is active", () => {
    const messages = [sampleMessage()];
    const built = buildChatticusThreadMessages(messages, null, "", null);
    assert.equal(built.length, 1);
    assert.equal(built[0]?.kind, "committed");
  });

  it("appends a streaming shell when a turn is open", () => {
    const built = buildChatticusThreadMessages([], {
      turn_id: "turn-1",
      tenant_id: "t1",
      channel_id: "c1",
      bot_id: "b1",
      status: "active",
      waiting_for: null,
    }, "Hi", "active");
    assert.equal(built.length, 1);
    assert.equal(built[0]?.kind, "streaming");
  });
});

describe("convertChatticusThreadMessage", () => {
  const botNames = new Map([["b1", "Ada"]]);

  it("maps human messages to user role", () => {
    const converted = convertChatticusThreadMessage(
      { kind: "committed", message: sampleMessage() },
      botNames,
    );
    assert.equal(converted.role, "user");
    assert.deepEqual(converted.content, [{ type: "text", text: "Hello" }]);
  });

  it("maps bot messages with author metadata", () => {
    const converted = convertChatticusThreadMessage(
      {
        kind: "committed",
        message: sampleMessage({
          author_kind: "bot",
          author_id: "b1",
          body: "Reply",
        }),
      },
      botNames,
    );
    assert.equal(converted.role, "assistant");
    assert.equal(converted.metadata?.custom?.authorBotName, "Ada");
  });

  it("uses progress text and running status for streaming assistant rows", () => {
    const converted = convertChatticusThreadMessage(
      {
        kind: "streaming",
        turnId: "turn-1",
        botId: "b1",
        body: "Partial",
        waitingFor: null,
        turnStatus: "active",
      },
      botNames,
    );
    assert.equal(converted.id, streamingMessageId("turn-1"));
    assert.deepEqual(converted.content, [{ type: "text", text: "Partial" }]);
    assert.deepEqual(converted.status, { type: "running" });
  });

  it("falls back to a waiting placeholder when progress is empty", () => {
    const converted = convertChatticusThreadMessage(
      {
        kind: "streaming",
        turnId: "turn-1",
        botId: "b1",
        body: "",
        waitingFor: "approval",
        turnStatus: "active",
      },
      botNames,
    );
    assert.deepEqual(
      converted.content,
      [{ type: "text", text: streamingAssistantPlaceholder("approval", "active") }],
    );
  });
});

describe("textFromAppendMessageContent", () => {
  it("joins text parts from append payloads", () => {
    assert.equal(
      textFromAppendMessageContent([
        { type: "text", text: "Hello " },
        { type: "text", text: "world" },
      ]),
      "Hello world",
    );
  });
});
