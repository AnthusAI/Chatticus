import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TurnEvent } from "./api";
import {
  describeTool,
  formatToolDuration,
  presentToolArguments,
  reduceTurnActivity,
} from "./turn-activity";
import {
  editCallTurn,
  failedCallTurn,
  longOutputTurn,
  manyCallsTurn,
  missingOptionalFieldsTurn,
  terminalCallTurn,
} from "./turn-activity-fixtures";

function event(kind: string, seq: number, extra: Partial<TurnEvent> = {}): TurnEvent {
  return { kind, seq, turn_id: "t", ...extra };
}

describe("reduceTurnActivity phases", () => {
  it("is idle with no events", () => {
    const activity = reduceTurnActivity([]);
    assert.equal(activity.phase, "idle");
    assert.equal(activity.showWorkingIndicator, false);
    assert.equal(activity.hasActivity, false);
  });

  it("says Thinking after turn start and after each model request", () => {
    assert.equal(reduceTurnActivity([event("turn.started", 1)]).phaseText, "Thinking");
    assert.equal(reduceTurnActivity([event("turn.started", 1), event("model.request", 2)]).phaseText, "Thinking");
  });

  it("walks the computer phases and returns to Thinking", () => {
    const starting = [
      event("turn.started", 1),
      event("computer.starting", 2, { detail: "Starting your computer" }),
      event("turn.waiting", 3, { body: "workspace" }),
    ];
    assert.equal(reduceTurnActivity(starting).phaseText, "Starting your computer");
    const ready = [...starting, event("computer.ready", 4)];
    assert.equal(reduceTurnActivity(ready).phaseText, "Computer ready");
    assert.equal(reduceTurnActivity([...ready, event("model.request", 5)]).phaseText, "Thinking");
  });

  it("names other gates", () => {
    const activity = reduceTurnActivity([event("turn.waiting", 1, { body: "approval" })]);
    assert.equal(activity.phase, "waiting");
    assert.equal(activity.phaseText, "Waiting for approval");
  });

  it("hides the indicator at the first answer token and after completion", () => {
    const streaming = reduceTurnActivity([event("turn.started", 1), event("turn.token", 2, { token: "Hi" })]);
    assert.equal(streaming.showWorkingIndicator, false);
    assert.equal(streaming.phase, "answering");
    const done = reduceTurnActivity([event("turn.started", 1), event("turn.completed", 2)]);
    assert.equal(done.showWorkingIndicator, false);
    assert.equal(done.phase, "done");
  });

  it("keeps the indicator through an empty token", () => {
    const activity = reduceTurnActivity([event("turn.started", 1), event("turn.token", 2, { token: "" })]);
    assert.equal(activity.showWorkingIndicator, true);
  });

  it("marks a failed turn", () => {
    const activity = reduceTurnActivity([event("turn.started", 1), event("turn.failed", 2, { body: "no quota" })]);
    assert.equal(activity.phase, "failed");
    assert.equal(activity.showWorkingIndicator, false);
  });

  it("ignores late phase events after the answer started", () => {
    const activity = reduceTurnActivity([
      event("turn.token", 1, { token: "Hi" }),
      event("model.request", 2),
    ]);
    assert.equal(activity.phase, "answering");
  });
});

describe("reduceTurnActivity tool cards", () => {
  it("builds an ok terminal card with duration, arguments and output", () => {
    const activity = reduceTurnActivity(terminalCallTurn);
    assert.equal(activity.tools.length, 1);
    const [card] = activity.tools;
    assert.equal(card.label, "Terminal");
    assert.equal(card.kind, "command");
    assert.equal(card.status, "ok");
    assert.equal(card.summary, "Running: ls -la /workspace");
    assert.equal(card.durationMs, 420);
    assert.deepEqual(card.arguments, { command: "ls -la /workspace" });
    assert.match(card.output ?? "", /notes\.txt/);
    assert.equal(card.openByDefault, false);
  });

  it("shows a running card until its result arrives", () => {
    const events = failedCallTurn.slice(0, 3);
    const [card] = reduceTurnActivity(events).tools;
    assert.equal(card.status, "running");
    assert.equal(card.output, null);
    assert.equal(reduceTurnActivity(events).phaseText, "Using terminal");
  });

  it("opens failed cards by default and uses the result summary as the error", () => {
    const [card] = reduceTurnActivity(failedCallTurn).tools;
    assert.equal(card.status, "failed");
    assert.equal(card.openByDefault, true);
    assert.equal(card.summary, "Exit 1: 2 tests failed");
    assert.equal(reduceTurnActivity(failedCallTurn).phaseText, "Thinking");
  });

  it("describes an edit as old and new text", () => {
    const [card] = reduceTurnActivity(editCallTurn).tools;
    assert.equal(card.label, "Edit file");
    const shown = presentToolArguments(card.kind, card.arguments);
    assert.equal(shown?.path, "src/greeting.ts");
    assert.equal(shown?.oldText, 'return "helo";');
    assert.equal(shown?.newText, 'return "hello";');
  });

  it("carries the truncation flag", () => {
    const [card] = reduceTurnActivity(longOutputTurn).tools;
    assert.equal(card.outputTruncated, true);
    assert.ok((card.output ?? "").split("\n").length > 50);
  });

  it("keeps many calls in order", () => {
    const activity = reduceTurnActivity(manyCallsTurn);
    assert.equal(activity.tools.length, 12);
    assert.deepEqual(
      activity.tools.map((card) => card.callId),
      Array.from({ length: 12 }, (_, index) => `call-${index}`),
    );
    assert.ok(activity.tools.every((card) => card.status === "ok"));
  });

  it("degrades to the tool name when optional fields are missing", () => {
    const activity = reduceTurnActivity(missingOptionalFieldsTurn);
    assert.equal(activity.tools.length, 1);
    const [card] = activity.tools;
    assert.equal(card.label, "Terminal");
    assert.equal(card.summary, null);
    assert.equal(card.arguments, null);
    assert.equal(card.output, null);
    assert.equal(card.status, "ok");
    assert.equal(card.durationMs, null);
  });

  it("pairs results with calls by call_id", () => {
    const activity = reduceTurnActivity([
      event("tool.call", 1, { tool: "run_terminal", call_id: "a1" }),
      event("tool.call", 2, { tool: "run_terminal", call_id: "a2" }),
      event("tool.result", 3, { tool: "run_terminal", call_id: "a2", ok: false }),
    ]);
    assert.deepEqual(activity.tools.map((card) => card.status), ["running", "failed"]);
  });

  it("merges a duplicate call_id into one card in its first position", () => {
    const activity = reduceTurnActivity([
      event("tool.call", 1, { tool: "run_terminal", call_id: "x" }),
      event("tool.call", 2, { tool: "read_workspace", call_id: "y" }),
      event("tool.call", 3, { tool: "run_terminal", call_id: "x", summary: "later summary", arguments: { command: "ls" } }),
    ]);
    assert.equal(activity.tools.length, 2);
    assert.equal(activity.tools[0].callId, "x");
    assert.equal(activity.tools[0].summary, "later summary");
    assert.deepEqual(activity.tools[0].arguments, { command: "ls" });
  });

  it("builds a card from a result that has no call", () => {
    const activity = reduceTurnActivity([event("tool.result", 1, { tool: "run_terminal", call_id: "z", ok: true })]);
    assert.equal(activity.tools.length, 1);
    assert.equal(activity.tools[0].status, "ok");
  });

  it("falls back to the tool name for an unknown tool", () => {
    assert.deepEqual(describeTool("custom_thing"), { label: "custom_thing", kind: "generic" });
    assert.equal(describeTool("run_terminal").label, "Terminal");
    assert.equal(describeTool("read_workspace").label, "Read file");
    assert.equal(describeTool("write_workspace").label, "Write file");
    assert.equal(describeTool("edit_workspace").label, "Edit file");
    assert.equal(describeTool("browse").label, "Browse");
  });
});

describe("reduceTurnActivity thinking", () => {
  it("is null when no turn.thinking event arrives", () => {
    assert.equal(reduceTurnActivity(terminalCallTurn).thinking, null);
  });

  it("joins reasoning summaries in order", () => {
    const activity = reduceTurnActivity([
      event("turn.thinking", 1, { text: "First I look." }),
      event("turn.thinking", 2, { text: "Then I act." }),
    ]);
    assert.equal(activity.thinking, "First I look.\n\nThen I act.");
    assert.equal(activity.hasActivity, true);
  });
});

describe("reduceTurnActivity replay", () => {
  it("rebuilds identical state from the full list", () => {
    assert.deepEqual(reduceTurnActivity(terminalCallTurn), reduceTurnActivity([...terminalCallTurn]));
  });

  it("is unchanged when events are delivered twice", () => {
    const doubled = [...terminalCallTurn.slice(0, 8), ...terminalCallTurn];
    assert.deepEqual(reduceTurnActivity(doubled), reduceTurnActivity(terminalCallTurn));
  });

  it("matches the incremental state at every prefix", () => {
    for (let length = 1; length <= terminalCallTurn.length; length += 1) {
      const incremental = reduceTurnActivity(terminalCallTurn.slice(0, length));
      const replayed = reduceTurnActivity(JSON.parse(JSON.stringify(terminalCallTurn.slice(0, length))));
      assert.deepEqual(replayed, incremental);
    }
  });
});

describe("formatToolDuration and presentToolArguments", () => {
  it("formats durations", () => {
    assert.equal(formatToolDuration(null), null);
    assert.equal(formatToolDuration(420), "420 ms");
    assert.equal(formatToolDuration(1900), "1.9 s");
    assert.equal(formatToolDuration(12400), "12 s");
  });

  it("shows a command and keeps unknown arguments", () => {
    const shown = presentToolArguments("command", { command: "ls", cwd: "/workspace" });
    assert.equal(shown?.command, "ls");
    assert.deepEqual(shown?.other, [["cwd", "/workspace"]]);
    assert.equal(presentToolArguments("command", null), null);
  });

  it("shows a write as path and preview", () => {
    const shown = presentToolArguments("write", { path: "a.txt", bytes: 5, preview: "hello" });
    assert.equal(shown?.path, "a.txt");
    assert.equal(shown?.preview, "hello");
    assert.deepEqual(shown?.other, [["bytes", "5"]]);
  });
});
