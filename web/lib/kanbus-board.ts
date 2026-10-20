/**
 * The Kanbus board panel reads a Kanbus project out of the organization's workspace files. A Kanbus project keeps
 * one JSON file per issue under `project/issues/`. This module parses those files and arranges them into columns by
 * status. It has no React, no network and no clock, so it is the same code under the panel and under its tests.
 */

export const KANBUS_ISSUES_DIRECTORY = "project/issues";

/** The most issue files one load reads. The newest by modification time are read first. */
export const KANBUS_ISSUE_FILE_LIMIT = 200;

/** The most cards one column draws before it says how many more it holds. */
export const KANBUS_COLUMN_CARD_LIMIT = 30;

const KNOWN_STATUS_ORDER: readonly string[] = ["backlog", "open", "in_progress", "blocked", "closed"];
const ALWAYS_SHOWN_STATUSES: readonly string[] = ["open", "in_progress", "closed"];

const STATUS_NAMES: Readonly<Record<string, string>> = {
  backlog: "Backlog",
  open: "Open",
  in_progress: "In progress",
  blocked: "Blocked",
  closed: "Closed",
};

const PRIORITY_NAMES: Readonly<Record<number, string>> = {
  0: "Critical",
  1: "High",
  2: "Medium",
  3: "Low",
  4: "Trivial",
};

/** One issue as the board needs it: the fields of a Kanbus issue file that a card shows or a column sorts by. */
export type KanbusBoardIssue = {
  id: string;
  title: string;
  type: string;
  status: string;
  priority: number;
  labels: readonly string[];
  parent: string | null;
  assignee: string | null;
  updatedAt: string | null;
};

export type KanbusBoardCard = KanbusBoardIssue & {
  priorityName: string;
  childCount: number;
};

export type KanbusBoardColumn = {
  status: string;
  name: string;
  total: number;
  cards: readonly KanbusBoardCard[];
  hiddenCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** The issue a Kanbus issue file holds, or null when the text is not an issue (not JSON, or no id, title and status). */
export function parseKanbusIssueFile(text: string): KanbusBoardIssue | null {
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
  return {
    id,
    title,
    type: nonEmptyString(parsed.type) ?? "task",
    status,
    priority: typeof parsed.priority === "number" && Number.isInteger(parsed.priority) ? parsed.priority : 2,
    labels,
    parent: nonEmptyString(parsed.parent),
    assignee: nonEmptyString(parsed.assignee),
    updatedAt: nonEmptyString(parsed.updated_at),
  };
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

function compareCards(left: KanbusBoardIssue, right: KanbusBoardIssue): number {
  if (left.priority !== right.priority) return left.priority - right.priority;
  const leftUpdated = left.updatedAt ?? "";
  const rightUpdated = right.updatedAt ?? "";
  if (leftUpdated !== rightUpdated) return leftUpdated < rightUpdated ? 1 : -1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
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
 * The board's columns: the open, in progress and closed columns always, any other status that has an issue, in the
 * order of the default Kanbus workflow with unknown statuses last. Cards sort by priority, then most recently updated.
 */
export function buildKanbusBoardColumns(issues: readonly KanbusBoardIssue[], cardLimit: number = KANBUS_COLUMN_CARD_LIMIT): KanbusBoardColumn[] {
  const childCountByParent = new Map<string, number>();
  for (const issue of issues) {
    if (issue.parent !== null) childCountByParent.set(issue.parent, (childCountByParent.get(issue.parent) ?? 0) + 1);
  }
  const statuses = new Set<string>(ALWAYS_SHOWN_STATUSES);
  for (const issue of issues) statuses.add(issue.status);
  return [...statuses].sort(compareStatuses).map((status) => {
    const inColumn = issues.filter((issue) => issue.status === status).sort(compareCards);
    const shown = inColumn.slice(0, cardLimit).map((issue) => ({
      ...issue,
      priorityName: priorityName(issue.priority),
      childCount: childCountByParent.get(issue.id) ?? 0,
    }));
    return { status, name: statusColumnName(status), total: inColumn.length, cards: shown, hiddenCount: inColumn.length - shown.length };
  });
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
