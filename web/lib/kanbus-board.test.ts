import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { KanbanIssue } from "@kanbus/ui";

import { buildKanbusBoardConfig, chooseIssueFilesToRead, parseKanbusIssueFile, priorityName, statusColumnName } from "./kanbus-board";

function issue(overrides: Partial<KanbanIssue>): KanbanIssue {
  return { id: "a-1", title: "A", type: "task", status: "open", priority: 2, labels: [], ...overrides };
}

describe("parseKanbusIssueFile", () => {
  it("reads the fields a card shows and tolerates the rest", () => {
    const parsed = parseKanbusIssueFile(JSON.stringify({ id: "k-1", title: "Fix", type: "bug", status: "in_progress", priority: 0, labels: ["web", 7, ""], parent: "k-0", comments: [], closed_at: null }));
    assert.deepEqual(parsed, { id: "k-1", title: "Fix", type: "bug", status: "in_progress", priority: 0, labels: ["web"], parent: "k-0" });
  });

  it("keeps the assignee and the timestamps when the file has them", () => {
    const parsed = parseKanbusIssueFile(JSON.stringify({ id: "k-4", title: "T", status: "open", assignee: "ryan", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z", closed_at: null }));
    assert.equal(parsed?.assignee, "ryan");
    assert.equal(parsed?.created_at, "2026-10-01T00:00:00Z");
    assert.equal(parsed?.updated_at, "2026-10-02T00:00:00Z");
    assert.equal(parsed?.closed_at, undefined);
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

describe("buildKanbusBoardConfig", () => {
  it("always lists open, in progress and closed, and orders other statuses by the default workflow", () => {
    const config = buildKanbusBoardConfig([issue({ id: "x", status: "blocked" }), issue({ id: "y", status: "review" })]);
    assert.deepEqual(config.statuses.map((status) => status.key), ["open", "in_progress", "blocked", "closed", "review"]);
    assert.equal(config.statuses.find((status) => status.key === "in_progress")?.name, "In progress");
  });

  it("lists every priority and type the issues use", () => {
    const config = buildKanbusBoardConfig([issue({ id: "x", priority: 7, type: "spike" })]);
    assert.equal(config.priorities[7].name, "Priority 7");
    assert.equal(config.priorities[0].name, "Critical");
    assert.equal(config.type_colors.spike, "gray");
    assert.equal(config.type_colors.bug, "red");
  });

  it("puts every status in a category that the configuration lists", () => {
    const config = buildKanbusBoardConfig([issue({ id: "x", status: "review" })]);
    const categoryNames = new Set(config.categories.map((category) => category.name));
    assert.ok(config.statuses.every((status) => categoryNames.has(status.category)));
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
