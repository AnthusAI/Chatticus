import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { reduceTurnActivity } from "./turn-activity";
import {
  editCallTurn,
  failedCallTurn,
  longOutputTurn,
  manyCallsTurn,
  missingOptionalFieldsTurn,
  terminalCallTurn,
} from "./turn-activity-fixtures";

// The component sources use the automatic JSX runtime through Next; tsx --test compiles them classically.
(globalThis as { React?: typeof React }).React = React;
type ActivityView = typeof import("../components/assistant-ui/TurnActivityView");
let TurnActivityBody: ActivityView["TurnActivityBody"];
let WorkingIndicator: ActivityView["WorkingIndicator"];

before(async () => {
  ({ TurnActivityBody, WorkingIndicator } = await import("../components/assistant-ui/TurnActivityView"));
});

function render(events: Parameters<typeof reduceTurnActivity>[0]): string {
  return renderToStaticMarkup(
    createElement(TurnActivityBody, { activity: reduceTurnActivity(events) }),
  );
}

describe("WorkingIndicator", () => {
  it("is a polite status with the phase text and a reduced-motion safe animation", () => {
    const html = renderToStaticMarkup(createElement(WorkingIndicator, { phaseText: "Starting your computer" }));
    assert.match(html, /role="status"/);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /Working/);
    assert.match(html, /Starting your computer/);
    assert.match(html, /motion-safe:animate-pulse/);
    assert.doesNotMatch(html, /[\s"]animate-pulse/);
  });
});

describe("TurnActivityBody", () => {
  it("renders nothing without tools or thinking", () => {
    assert.equal(render([{ kind: "turn.started", seq: 1, turn_id: "t" }]), "");
  });

  it("collapses a successful call and shows its label, summary, status and duration", () => {
    const html = render(terminalCallTurn);
    assert.match(html, /Terminal/);
    assert.match(html, /Running: ls -la \/workspace/);
    assert.match(html, /Done/);
    assert.match(html, /420 ms/);
    assert.doesNotMatch(html, /<details[^>]* open/);
    assert.match(html, /ls -la \/workspace/);
  });

  it("opens a failed call with its error summary and output", () => {
    const html = render(failedCallTurn);
    assert.match(html, /<details[^>]* open/);
    assert.match(html, /Failed/);
    assert.match(html, /Exit 1: 2 tests failed/);
    assert.match(html, /expected 4 received 5/);
  });

  it("shows an edit as separate replaced and new text", () => {
    const html = render(editCallTurn);
    assert.match(html, /Edit file/);
    assert.match(html, /src\/greeting\.ts/);
    assert.match(html, /aria-label="Replaced text"/);
    assert.match(html, /aria-label="New text"/);
  });

  it("notes truncated output", () => {
    assert.match(render(longOutputTurn), /Output truncated\./);
  });

  it("shows a running call as Running", () => {
    assert.match(render(failedCallTurn.slice(0, 3)), /Running/);
  });

  it("lists many calls compactly", () => {
    const html = render(manyCallsTurn);
    assert.equal(html.match(/data-testid="tool-card"/g)?.length, 12);
  });

  it("shows only the tool name for events from an missing optional fields", () => {
    const html = render(missingOptionalFieldsTurn);
    assert.match(html, /Terminal/);
    assert.match(html, /No further details were reported\./);
  });

  it("shows a muted Thinking block only when reasoning arrived", () => {
    const withThinking = render([
      { kind: "turn.thinking", seq: 1, turn_id: "t", text: "Weighing two options." },
    ]);
    assert.match(withThinking, /Weighing two options\./);
    assert.doesNotMatch(render(terminalCallTurn), />Thinking</);
  });
});
