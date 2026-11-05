import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { kanbanConfigFromBotBoardConfiguration, kanbanIssueFromBotBoardIssue } from "./bot-board-adapter";
import type { BotBoardConfiguration, BotBoardIssue } from "./bot-boards-api";

const kanbusDefaultConfiguration: BotBoardConfiguration = {
  hierarchy: ["initiative", "epic", "task", "sub-task"],
  types: ["bug", "story", "chore"],
  initial_status: "open",
  workflows: { default: { open: ["in_progress", "closed"], in_progress: ["open", "closed"], closed: ["open"] } },
  priorities: { "0": { name: "critical", color: "red" }, "2": { name: "medium" } },
  statuses: [
    { key: "open", name: "Open", category: "To do" },
    { key: "in_progress", name: "In Progress", category: "In progress", color: "blue" },
    { key: "closed", name: "Closed", category: "Done" },
  ],
  categories: [{ name: "To do" }, { name: "In progress", color: "blue" }, { name: "Done" }],
  type_colors: { task: "blue", bug: "red" },
};

function issue(overrides: Partial<BotBoardIssue> = {}): BotBoardIssue {
  return { id: "as-1", title: "Pay the bill", type: "task", status: "open", priority: 1, ...overrides };
}

describe("kanbanIssueFromBotBoardIssue", () => {
  it("leaves out nullable fields that are null", () => {
    const result = kanbanIssueFromBotBoardIssue(issue({ assignee: null, parent: null, closed_at: null, description: "" }));
    assert.deepEqual(result, { id: "as-1", title: "Pay the bill", type: "task", status: "open", priority: 1, labels: [] });
  });

  it("keeps assignee, parent, timestamps, labels and custom fields", () => {
    const result = kanbanIssueFromBotBoardIssue(
      issue({ assignee: "ryan", parent: "as-0", labels: ["household", ""], created_at: "c", updated_at: "u", closed_at: "x", custom: { closing: "completed" } }),
    );
    assert.deepEqual(result, { id: "as-1", title: "Pay the bill", type: "task", status: "open", priority: 1, assignee: "ryan", parent: "as-0", labels: ["household"], created_at: "c", updated_at: "u", closed_at: "x", custom: { closing: "completed" } });
  });

  it("carries comments with their author and text and drops dependencies, which the component has no field for", () => {
    const result = kanbanIssueFromBotBoardIssue(
      issue({ comments: [{ author: "chatticus:bot:b1", text: "Waiting", created_at: "t" }], dependencies: [{ target: "as-2", type: "blocked-by" }] }),
    );
    assert.deepEqual(result.comments, [{ author: "chatticus:bot:b1", text: "Waiting", created_at: "t" }]);
    assert.ok(!("dependencies" in result));
  });
});

describe("kanbanConfigFromBotBoardConfiguration", () => {
  it("uses the statuses, categories, workflows, hierarchy and types of the board", () => {
    const config = kanbanConfigFromBotBoardConfiguration(kanbusDefaultConfiguration, []);
    assert.deepEqual(config.statuses.map((status) => status.key), ["open", "in_progress", "closed"]);
    assert.deepEqual(config.statuses[1], { key: "in_progress", name: "In Progress", category: "In progress", color: "blue" });
    assert.deepEqual(config.categories, [{ name: "To do" }, { name: "In progress", color: "blue" }, { name: "Done" }]);
    assert.equal(config.workflows, kanbusDefaultConfiguration.workflows);
    assert.deepEqual(config.hierarchy, ["initiative", "epic", "task", "sub-task"]);
    assert.deepEqual(config.types, ["bug", "story", "chore"]);
  });

  it("capitalizes the priority names the board gives", () => {
    const config = kanbanConfigFromBotBoardConfiguration(kanbusDefaultConfiguration, []);
    assert.deepEqual(config.priorities[0], { name: "Critical", color: "red" });
    assert.deepEqual(config.priorities[2], { name: "Medium" });
  });

  it("adds a status that a card uses and the configuration lacks, so no card is dropped", () => {
    const config = kanbanConfigFromBotBoardConfiguration(kanbusDefaultConfiguration, [kanbanIssueFromBotBoardIssue(issue({ status: "review", priority: 7 }))]);
    assert.deepEqual(config.statuses.map((status) => status.key), ["open", "in_progress", "closed", "review"]);
    assert.deepEqual(config.statuses[3], { key: "review", name: "Review", category: "In progress" });
    assert.deepEqual(config.priorities[7], { name: "Priority 7" });
  });

  it("reads bare status keys, as the Kanbus default configuration may give them", () => {
    const config = kanbanConfigFromBotBoardConfiguration({ initial_status: "open", statuses: [{ key: "backlog" }, { key: "open" }, { key: "blocked" }, { key: "closed" }] }, []);
    assert.deepEqual(config.statuses, [
      { key: "backlog", name: "Backlog", category: "To do" },
      { key: "open", name: "Open", category: "To do" },
      { key: "blocked", name: "Blocked", category: "In progress" },
      { key: "closed", name: "Closed", category: "Done" },
    ]);
    assert.deepEqual(config.categories.map((category) => category.name), ["To do", "In progress", "Done"]);
  });

  it("takes the statuses from the workflows when the configuration lists none", () => {
    const config = kanbanConfigFromBotBoardConfiguration({ workflows: { default: { open: ["closed"], closed: ["open"] } } }, []);
    assert.deepEqual(config.statuses.map((status) => status.key), ["open", "closed"]);
  });

  it("gives a type that the board has no color for a gray one", () => {
    const config = kanbanConfigFromBotBoardConfiguration(kanbusDefaultConfiguration, [kanbanIssueFromBotBoardIssue(issue({ type: "chore" }))]);
    assert.deepEqual(config.type_colors, { task: "blue", bug: "red", chore: "gray" });
  });
});
