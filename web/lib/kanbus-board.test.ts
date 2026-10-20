import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildKanbusBoardColumns, chooseIssueFilesToRead, parseKanbusIssueFile, priorityName, statusColumnName, type KanbusBoardIssue } from "./kanbus-board";

function issue(overrides: Partial<KanbusBoardIssue>): KanbusBoardIssue {
  return { id: "a-1", title: "A", type: "task", status: "open", priority: 2, labels: [], parent: null, assignee: null, updatedAt: null, ...overrides };
}

describe("parseKanbusIssueFile", () => {
  it("reads the fields a card shows and tolerates the rest", () => {
    const parsed = parseKanbusIssueFile(JSON.stringify({ id: "k-1", title: "Fix", type: "bug", status: "in_progress", priority: 0, labels: ["web", 7, ""], parent: "k-0", comments: [], closed_at: null }));
    assert.deepEqual(parsed, { id: "k-1", title: "Fix", type: "bug", status: "in_progress", priority: 0, labels: ["web"], parent: "k-0", assignee: null, updatedAt: null });
  });

  it("defaults the type and the priority", () => {
    const parsed = parseKanbusIssueFile(JSON.stringify({ id: "k-2", title: "T", status: "open" }));
    assert.equal(parsed?.type, "task");
    assert.equal(parsed?.priority, 2);
  });

  it("refuses text that is not an issue", () => {
    assert.equal(parseKanbusIssueFile("not json"), null);
    assert.equal(parseKanbusIssueFile("[]"), null);
    assert.equal(parseKanbusIssueFile(JSON.stringify({ id: "k-3", title: "No status" })), null);
  });
});

describe("buildKanbusBoardColumns", () => {
  it("always shows open, in progress and closed, and orders other statuses by the default workflow", () => {
    const columns = buildKanbusBoardColumns([issue({ id: "x", status: "blocked" }), issue({ id: "y", status: "review" })]);
    assert.deepEqual(columns.map((column) => column.status), ["open", "in_progress", "blocked", "closed", "review"]);
  });

  it("sorts cards by priority and then by most recent update, and counts children", () => {
    const columns = buildKanbusBoardColumns([
      issue({ id: "low", priority: 3 }),
      issue({ id: "old", priority: 1, updatedAt: "2026-10-01T00:00:00Z" }),
      issue({ id: "new", priority: 1, updatedAt: "2026-10-05T00:00:00Z" }),
      issue({ id: "kid", priority: 2, parent: "new", status: "closed" }),
    ]);
    const open = columns.find((column) => column.status === "open");
    assert.deepEqual(open?.cards.map((card) => card.id), ["new", "old", "low"]);
    assert.equal(open?.cards[0].childCount, 1);
  });

  it("limits the cards of a column and says how many are hidden", () => {
    const issues = Array.from({ length: 5 }, (_unused, index) => issue({ id: `i-${index}` }));
    const open = buildKanbusBoardColumns(issues, 3).find((column) => column.status === "open");
    assert.equal(open?.cards.length, 3);
    assert.equal(open?.hiddenCount, 2);
    assert.equal(open?.total, 5);
  });
});

describe("names", () => {
  it("names statuses and priorities", () => {
    assert.equal(statusColumnName("in_progress"), "In progress");
    assert.equal(statusColumnName("needs-review"), "Needs review");
    assert.equal(priorityName(1), "High");
    assert.equal(priorityName(9), "Priority 9");
  });
});

describe("chooseIssueFilesToRead", () => {
  it("keeps JSON files, newest first, up to the limit", () => {
    const { chosen, skippedCount } = chooseIssueFilesToRead(
      [
        { name: "a.json", kind: "file", modified_at: "2026-10-01T00:00:00Z" },
        { name: "b.json", kind: "file", modified_at: "2026-10-03T00:00:00Z" },
        { name: "c.json", kind: "file", modified_at: "2026-10-02T00:00:00Z" },
        { name: "notes.md", kind: "file", modified_at: "2026-10-09T00:00:00Z" },
        { name: "sub", kind: "directory", modified_at: null },
      ],
      2,
    );
    assert.deepEqual(chosen.map((entry) => entry.name), ["b.json", "c.json"]);
    assert.equal(skippedCount, 1);
  });
});
