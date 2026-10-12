import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Message, ToolActivityItem, Turn } from "./api";
import { buildChatticusThreadMessages, convertChatticusThreadMessage } from "./assistant-ui-bridge";
import { committedMessageActivity, toolCardsFromActivity } from "./committed-activity";
import { reduceTurnActivity } from "./turn-activity";
import { failedCallTurn, terminalCallTurn } from "./turn-activity-fixtures";

(globalThis as { React?: typeof React }).React = React;
type ActivityView = typeof import("../components/assistant-ui/TurnActivityView");
let TurnActivityBody: ActivityView["TurnActivityBody"];

before(async () => {
  ({ TurnActivityBody } = await import("../components/assistant-ui/TurnActivityView"));
});

const item = (overrides: Partial<ToolActivityItem> = {}): ToolActivityItem => ({
  call_id: "call-1",
  tool: "run_terminal",
  summary: "Running: ls -la /workspace",
  arguments: { command: "ls -la /workspace" },
  arguments_truncated: false,
  ok: true,
  result_summary: "Exit 0",
  output: "notes.txt",
  output_truncated: false,
  duration_ms: 420,
  ...overrides,
});

const botMessage = (overrides: Partial<Message> = {}): Message => ({
  message_id: "m2",
  channel_id: "c1",
  tenant_id: "t1",
  seq: 2,
  author_kind: "bot",
  author_id: "b1",
  body: "There is one file, notes.txt.",
  addressed_to_bot_id: null,
  created_at: "2026-01-01T12:00:05.000Z",
  ...overrides,
});

const humanMessage: Message = botMessage({
  message_id: "m1",
  seq: 1,
  author_kind: "human",
  author_id: "u1",
});

const turn = (): Turn => ({
  turn_id: "turn-fixture",
  tenant_id: "t1",
  channel_id: "c1",
  bot_id: "b1",
  status: "completed",
  waiting_for: null,
  prompt_message_seq: 1,
});

function renderCards(activity: ReturnType<typeof committedMessageActivity>): string {
  return renderToStaticMarkup(createElement(TurnActivityBody, { activity }));
}

describe("toolCardsFromActivity", () => {
  it("maps a successful call to a collapsed done card", () => {
    const [card] = toolCardsFromActivity([item()]);
    assert.equal(card?.label, "Terminal");
    assert.equal(card?.status, "ok");
    assert.equal(card?.summary, "Running: ls -la /workspace");
    assert.equal(card?.openByDefault, false);
    assert.equal(card?.durationMs, 420);
  });

  it("maps a failed call to an open card showing the result summary", () => {
    const [card] = toolCardsFromActivity([item({ ok: false, result_summary: "Exit 1: 2 tests failed" })]);
    assert.equal(card?.status, "failed");
    assert.equal(card?.openByDefault, true);
    assert.equal(card?.summary, "Exit 1: 2 tests failed");
  });

  it("maps a null result to a neutral unrecorded card", () => {
    const [card] = toolCardsFromActivity([item({ ok: null, result_summary: null, output: null })]);
    assert.equal(card?.status, "unrecorded");
    assert.equal(card?.openByDefault, false);
    const html = renderCards({ ...committedMessageActivity({ activity: [item({ ok: null })] }, null) });
    assert.match(html, /No result recorded/);
    assert.doesNotMatch(html, /Failed/);
  });

  it("shows a duration only when one is known", () => {
    const known = renderCards(committedMessageActivity({ activity: [item()] }, null));
    const unknown = renderCards(committedMessageActivity({ activity: [item({ duration_ms: null })] }, null));
    assert.match(known, /420 ms/);
    assert.doesNotMatch(unknown, / ms</);
  });

  it("carries truncation flags through", () => {
    const [card] = toolCardsFromActivity([item({ arguments_truncated: true, output_truncated: true })]);
    assert.equal(card?.argumentsTruncated, true);
    assert.equal(card?.outputTruncated, true);
    const html = renderCards(
      committedMessageActivity({ activity: [item({ arguments_truncated: true, output_truncated: true })] }, null),
    );
    assert.match(html, /Arguments truncated\./);
    assert.match(html, /Output truncated\./);
  });

  it("maps a more item to a plain summary row", () => {
    const cards = toolCardsFromActivity([item(), item({ call_id: "more", tool: "more", summary: "and 7 more calls", ok: null })]);
    assert.equal(cards[1]?.kind, "more");
    const html = renderCards(
      committedMessageActivity({ activity: [item(), item({ tool: "more", summary: "and 7 more calls", ok: null })] }, null),
    );
    assert.match(html, /More tool calls/);
    assert.match(html, /and 7 more calls/);
    assert.equal(html.match(/<details/g)?.length, 1);
  });

  it("maps empty, missing and malformed activity to no cards", () => {
    assert.deepEqual(toolCardsFromActivity([]), []);
    assert.deepEqual(toolCardsFromActivity(undefined), []);
    assert.deepEqual(toolCardsFromActivity(null), []);
    assert.deepEqual(toolCardsFromActivity("nope" as unknown as ToolActivityItem[]), []);
  });

  it("renders the same card live and afterwards", () => {
    const live = reduceTurnActivity(failedCallTurn);
    const recorded = committedMessageActivity(
      {
        activity: live.tools.map((card) => ({
          call_id: card.callId,
          tool: card.tool,
          summary: card.summary ?? "",
          arguments: card.arguments ?? {},
          arguments_truncated: card.argumentsTruncated,
          ok: card.status === "failed" ? false : true,
          result_summary: card.summary,
          output: card.output,
          output_truncated: card.outputTruncated,
          duration_ms: card.durationMs,
        })),
      },
      null,
    );
    assert.equal(renderCards(recorded), renderCards({ ...live, thinking: null }));
  });
});

describe("committedMessageActivity", () => {
  it("prefers the server record over the retained live cards", () => {
    const retained = reduceTurnActivity(terminalCallTurn);
    const activity = committedMessageActivity({ activity: [item({ call_id: "server" })] }, retained);
    assert.deepEqual(activity.tools.map((card) => card.callId), ["server"]);
  });

  it("treats an empty server list as no calls", () => {
    const retained = reduceTurnActivity(terminalCallTurn);
    assert.equal(committedMessageActivity({ activity: [] }, retained).tools.length, 0);
  });

  it("keeps the live cards when an older server sends no activity field", () => {
    const retained = reduceTurnActivity(terminalCallTurn);
    assert.deepEqual(committedMessageActivity({}, retained).tools, retained.tools);
  });
});

describe("live to committed transition", () => {
  const events = terminalCallTurn;

  it("shows the live cards in the streaming bubble", () => {
    const built = buildChatticusThreadMessages([humanMessage], turn(), "", "active", null, false, events);
    const streaming = built[built.length - 1];
    assert.equal(streaming?.kind, "streaming");
    if (streaming?.kind === "streaming") {
      assert.equal(streaming.activity.tools.length, 1);
    }
  });

  it("puts the same cards on the committed reply while the turn is still open", () => {
    const reply = botMessage({ activity: undefined });
    const built = buildChatticusThreadMessages([humanMessage, reply], turn(), "x", "completed", null, false, events);
    assert.equal(built.length, 2);
    const last = built[1];
    assert.equal(last?.kind, "committed");
    if (last?.kind === "committed") {
      assert.equal(last.activity?.tools.length, 1);
      assert.equal(last.activity?.tools[0]?.callId, "call-1");
    }
  });

  it("uses the server record on the committed reply once it arrives", () => {
    const reply = botMessage({ activity: [item({ call_id: "server-1" }), item({ call_id: "server-2" })] });
    const built = buildChatticusThreadMessages([humanMessage, reply], turn(), "x", "completed", null, false, events);
    const last = built[1];
    if (last?.kind === "committed") {
      assert.deepEqual(last.activity?.tools.map((card) => card.callId), ["server-1", "server-2"]);
    } else {
      assert.fail("expected a committed reply");
    }
  });

  it("keeps the live cards after the turn is cleared when an older server sends no activity", () => {
    const retained = { messageId: "m2", activity: reduceTurnActivity(events) };
    const built = buildChatticusThreadMessages([humanMessage, botMessage()], null, "", null, null, false, [], retained);
    const last = built[1];
    if (last?.kind === "committed") {
      assert.equal(last.activity?.tools.length, 1);
    } else {
      assert.fail("expected a committed reply");
    }
  });

  it("does not leak retained cards onto a different message", () => {
    const retained = { messageId: "other", activity: reduceTurnActivity(events) };
    const built = buildChatticusThreadMessages([humanMessage, botMessage()], null, "", null, null, false, [], retained);
    const last = built[1];
    assert.equal(last?.kind === "committed" ? last.activity : "wrong", null);
  });

  it("does not attach live cards to an older reply from before the prompt", () => {
    const older = botMessage({ message_id: "m0", seq: 0 });
    const built = buildChatticusThreadMessages([older], turn(), "", "reconciling", null, false, events);
    const first = built[0];
    assert.equal(first?.kind === "committed" ? first.activity : "wrong", null);
  });

  it("gives a committed reply without any activity no cards", () => {
    const built = buildChatticusThreadMessages([humanMessage, botMessage()], null, "", null);
    const last = built[1];
    assert.equal(last?.kind === "committed" ? last.activity : "wrong", null);
  });

  it("passes the activity to the rendered message", () => {
    const converted = convertChatticusThreadMessage(
      {
        kind: "committed",
        message: botMessage(),
        activity: committedMessageActivity({ activity: [item()] }, null),
      },
      new Map(),
    );
    const custom = converted.metadata?.custom as { activity?: { tools: unknown[] } };
    assert.equal(custom.activity?.tools.length, 1);
  });
});
