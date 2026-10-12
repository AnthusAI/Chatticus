import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Message, ToolActivityItem } from "./api";
import { touchingCards } from "./computer-files-fixtures";
import {
  TOUCHED_FILES_LIMIT,
  collectTouchedFiles,
  touchActionLabel,
  touchedFilesFromActivity,
} from "./touched-files";
import type { ToolCardModel } from "./turn-activity";

function item(tool: string, args: Record<string, unknown>, ok: boolean | null = true): ToolActivityItem {
  return {
    call_id: `${tool}-${JSON.stringify(args)}`,
    tool,
    summary: "",
    arguments: args,
    arguments_truncated: false,
    ok,
    result_summary: null,
    output: null,
    output_truncated: false,
    duration_ms: null,
  };
}

describe("collectTouchedFiles", () => {
  it("returns distinct paths newest first with the strongest action", () => {
    assert.deepEqual(collectTouchedFiles(touchingCards), [
      { path: "/workspace/src/index.ts", action: "wrote" },
      { path: "/workspace/notes.txt", action: "edited" },
    ]);
  });

  it("orders by the last touch even when a weaker action came last", () => {
    const cards = touchingCards.slice(0, 4);
    assert.deepEqual(collectTouchedFiles(cards).map((file) => file.path), [
      "/workspace/src/index.ts",
      "/workspace/notes.txt",
    ]);
    const reversed = [cards[1], cards[2]];
    assert.deepEqual(collectTouchedFiles(reversed).map((file) => file.path), [
      "/workspace/notes.txt",
      "/workspace/src/index.ts",
    ]);
  });

  it("ignores failed calls, paths outside the workspace, traversal and tools without a path", () => {
    const terminal: ToolCardModel = { ...touchingCards[0], tool: "run_terminal", arguments: { command: "ls" } };
    const traversal: ToolCardModel = { ...touchingCards[0], arguments: { path: "/workspace/../etc/shadow" } };
    const noArgs: ToolCardModel = { ...touchingCards[0], arguments: null };
    const numeric: ToolCardModel = { ...touchingCards[0], arguments: { path: 4 } };
    assert.deepEqual(collectTouchedFiles([terminal, traversal, noArgs, numeric, touchingCards[4], touchingCards[5]]), []);
  });

  it("caps the list at 50", () => {
    const many = Array.from({ length: 80 }, (_, index) => ({
      ...touchingCards[0],
      callId: `c${index}`,
      arguments: { path: `/workspace/f${index}` },
    }));
    const files = collectTouchedFiles(many);
    assert.equal(files.length, TOUCHED_FILES_LIMIT);
    assert.equal(files[0].path, "/workspace/f79");
  });
});

describe("touchedFilesFromActivity", () => {
  const message = (seq: number, activity: ToolActivityItem[] | undefined): Pick<Message, "seq" | "activity"> => ({ seq, activity });

  it("reads committed activity by sequence and puts live cards last (newest)", () => {
    const committed = [
      message(4, [item("write_workspace", { path: "/workspace/new.txt" })]),
      message(2, [item("read_workspace", { path: "/workspace/old.txt" })]),
      message(3, undefined),
    ];
    const live = [touchingCards[1]];
    assert.deepEqual(touchedFilesFromActivity(committed, live), [
      { path: "/workspace/src/index.ts", action: "wrote" },
      { path: "/workspace/new.txt", action: "wrote" },
      { path: "/workspace/old.txt", action: "read" },
    ]);
  });

  it("returns nothing for no activity", () => {
    assert.deepEqual(touchedFilesFromActivity([], []), []);
  });

  it("marks actions with plain words", () => {
    assert.equal(touchActionLabel("wrote"), "Wrote");
    assert.equal(touchActionLabel("edited"), "Edited");
    assert.equal(touchActionLabel("read"), "Read");
  });
});
