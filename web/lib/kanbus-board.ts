import type { KanbanConfig, KanbanIssue, KanbanStatusDefinition } from "@kanbus/ui";

/**
 * The Kanbus board panel reads a Kanbus project out of the organization's workspace files. A Kanbus project keeps
 * one JSON file per issue under `project/issues/`. This module parses those files into the `KanbanIssue` records
 * that `@kanbus/ui` renders and derives the `KanbanConfig` it needs. It has no React, no network and no clock, so it
 * is the same code under the panel and under its tests. Drawing columns and cards is the job of `@kanbus/ui`.
 */

export const KANBUS_ISSUES_DIRECTORY = "project/issues";

/** The most issue files one load reads. The newest by modification time are read first. */
export const KANBUS_ISSUE_FILE_LIMIT = 200;

const KNOWN_STATUS_ORDER: readonly string[] = ["backlog", "open", "in_progress", "blocked", "closed"];
const ALWAYS_SHOWN_STATUSES: readonly string[] = ["open", "in_progress", "closed"];

const STATUS_NAMES: Readonly<Record<string, string>> = {
  backlog: "Backlog",
  open: "Open",
  in_progress: "In progress",
  blocked: "Blocked",
  closed: "Closed",
};

const STATUS_CATEGORIES: Readonly<Record<string, string>> = {
  backlog: "To do",
  open: "To do",
  in_progress: "In progress",
  blocked: "In progress",
  closed: "Done",
};

const FALLBACK_STATUS_CATEGORY = "In progress";

const PRIORITY_NAMES: Readonly<Record<number, string>> = {
  0: "Critical",
  1: "High",
  2: "Medium",
  3: "Low",
  4: "Trivial",
};

const TYPE_COLORS: Readonly<Record<string, string>> = {
  initiative: "violet",
  epic: "purple",
  story: "green",
  task: "blue",
  "sub-task": "sky",
  bug: "red",
  chore: "gray",
};

const CATEGORY_NAMES: readonly string[] = ["To do", "In progress", "Done"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** The issue a Kanbus issue file holds, in the shape `@kanbus/ui` renders, or null when the text is not an issue (not JSON, or no id, title and status). */
export function parseKanbusIssueFile(text: string): KanbanIssue | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const id = nonEmptyString(parsed.id);
  const title = nonEmptyString(parsed.title);
  const status = nonEmptyString(parsed.status);
  if (id === null || title === null || status === null) return null;
  const labels = Array.isArray(parsed.labels) ? parsed.labels.filter((label): label is string => typeof label === "string" && label !== "") : [];
  const issue: KanbanIssue = {
    id,
    title,
    type: nonEmptyString(parsed.type) ?? "task",
    status,
    priority: typeof parsed.priority === "number" && Number.isInteger(parsed.priority) ? parsed.priority : 2,
    labels,
  };
  const optionalFields: ReadonlyArray<readonly ["assignee" | "parent" | "created_at" | "updated_at" | "closed_at", unknown]> = [
    ["assignee", parsed.assignee],
    ["parent", parsed.parent],
    ["created_at", parsed.created_at],
    ["updated_at", parsed.updated_at],
    ["closed_at", parsed.closed_at],
  ];
  for (const [field, value] of optionalFields) {
    const fieldText = nonEmptyString(value);
    if (fieldText !== null) issue[field] = fieldText;
  }
  return issue;
}

/** The label a column header shows for a status key. */
export function statusColumnName(status: string): string {
  const known = STATUS_NAMES[status];
  if (known !== undefined) return known;
  const words = status.replace(/[_-]+/g, " ").trim();
  return words === "" ? status : words.charAt(0).toUpperCase() + words.slice(1);
}

/** The word for a priority number: Kanbus's default scale, and "Priority N" beyond it. */
export function priorityName(priority: number): string {
  return PRIORITY_NAMES[priority] ?? `Priority ${priority}`;
}

function compareStatuses(left: string, right: string): number {
  const leftIndex = KNOWN_STATUS_ORDER.indexOf(left);
  const rightIndex = KNOWN_STATUS_ORDER.indexOf(right);
  if (leftIndex >= 0 && rightIndex >= 0) return leftIndex - rightIndex;
  if (leftIndex >= 0) return -1;
  if (rightIndex >= 0) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The `KanbanConfig` for a set of issues: the open, in progress and closed statuses always, any other status that has
 * an issue, in the order of the default Kanbus workflow with unknown statuses last, every priority the issues use, and
 * a color for every type they use. The component draws only statuses that the configuration lists, so each status in
 * use must be listed here.
 */
export function buildKanbusBoardConfig(issues: readonly KanbanIssue[]): KanbanConfig {
  const statusKeys = new Set<string>(ALWAYS_SHOWN_STATUSES);
  const priorityNumbers = new Set<number>([0, 1, 2, 3, 4]);
  const typeColors: Record<string, string> = { ...TYPE_COLORS };
  for (const issue of issues) {
    statusKeys.add(issue.status);
    priorityNumbers.add(issue.priority);
    if (typeColors[issue.type] === undefined) typeColors[issue.type] = "gray";
  }
  const statuses: KanbanStatusDefinition[] = [...statusKeys].sort(compareStatuses).map((key) => ({
    key,
    name: statusColumnName(key),
    category: STATUS_CATEGORIES[key] ?? FALLBACK_STATUS_CATEGORY,
  }));
  const priorities: Record<number, { name: string }> = {};
  for (const priority of [...priorityNumbers].sort((left, right) => left - right)) priorities[priority] = { name: priorityName(priority) };
  const priorityFirst = { "To do": "priority-first", "In progress": "priority-first", Done: "recently-updated" } as const;
  return {
    statuses,
    categories: CATEGORY_NAMES.map((name) => ({ name })),
    priorities,
    type_colors: typeColors,
    sort_order: { categories: priorityFirst },
  };
}

/** The entries of an issues directory the board reads: the JSON files, newest modification first, at most the limit. */
export function chooseIssueFilesToRead<Entry extends { name: string; kind: string; modified_at: string | null }>(
  entries: readonly Entry[],
  limit: number = KANBUS_ISSUE_FILE_LIMIT,
): { chosen: Entry[]; skippedCount: number } {
  const files = entries.filter((entry) => entry.kind === "file" && entry.name.endsWith(".json"));
  const newestFirst = [...files].sort((left, right) => (right.modified_at ?? "").localeCompare(left.modified_at ?? "") || left.name.localeCompare(right.name));
  return { chosen: newestFirst.slice(0, limit), skippedCount: Math.max(0, files.length - limit) };
}
