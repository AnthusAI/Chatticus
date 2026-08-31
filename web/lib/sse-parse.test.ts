import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isTerminalTurnEvent,
  parseSseFrames,
  TERMINAL_TURN_KINDS,
} from "./sse-parse";

describe("parseSseFrames", () => {
  it("parses a single complete frame", () => {
    const events: Array<{ kind: string; seq: number }> = [];
    const remainder = parseSseFrames(
      'data: {"kind":"turn.token","seq":1,"turn_id":"t1","token":"Hi"}\n\n',
      (event) => events.push(event),
    );
    assert.equal(remainder, "");
    assert.deepEqual(events, [
      { kind: "turn.token", seq: 1, turn_id: "t1", token: "Hi" },
    ]);
  });

  it("buffers partial frames until a blank line arrives", () => {
    const events: string[] = [];
    let buffer =
      'data: {"kind":"turn.token","seq":1,"turn_id":"t1","token":"He"}\n';
    buffer = parseSseFrames(buffer, (event) => events.push(event.kind));
    assert.equal(buffer.endsWith("\n"), true);
    assert.deepEqual(events, []);

    buffer += "\n";
    buffer = parseSseFrames(buffer, (event) => events.push(event.kind));
    assert.equal(buffer, "");
    assert.deepEqual(events, ["turn.token"]);
  });

  it("parses multiple frames in one buffer", () => {
    const kinds: string[] = [];
    parseSseFrames(
      [
        'data: {"kind":"turn.token","seq":1,"turn_id":"t1","token":"A"}',
        "",
        'data: {"kind":"turn.token","seq":2,"turn_id":"t1","token":"B"}',
        "",
        "",
      ].join("\n"),
      (event) => kinds.push(event.kind),
    );
    assert.deepEqual(kinds, ["turn.token", "turn.token"]);
  });

  it("skips frames without a data line", () => {
    const kinds: string[] = [];
    parseSseFrames("event: ping\n\n", (event) => kinds.push(event.kind));
    assert.deepEqual(kinds, []);
  });
});

describe("isTerminalTurnEvent", () => {
  it("recognizes terminal turn kinds", () => {
    for (const kind of TERMINAL_TURN_KINDS) {
      assert.equal(isTerminalTurnEvent(kind), true);
    }
    assert.equal(isTerminalTurnEvent("turn.token"), false);
  });
});
