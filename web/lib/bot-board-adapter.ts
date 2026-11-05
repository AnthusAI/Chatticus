import type { KanbanCategoryDefinition, KanbanConfig, KanbanIssue, KanbanPriorityDefinition, KanbanSortOrder, KanbanStatusDefinition } from "@kanbus/ui";

import type { BotBoardConfiguration, BotBoardIssue } from "./bot-boards-api";
import { priorityName, statusColumnName } from "./kanbus-board";

/**
 * The adapter from the front door's Kanbus issue JSON and board configuration to the records `@kanbus/ui` draws. It has
 * no React, no network and no clock. The board's own statuses, categories, priorities, type colors and workflows are
 * passed through; a default is used only for a field the configuration leaves out.
 */

const FALLBACK_TYPE_COLOR = "gray";
const TO_DO_CATEGORY = "To do";
const IN_PROGRESS_CATEGORY = "In progress";
const DONE_CATEGORY = "Done";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function capitalized(text: string): string {
  return text === "" ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

/** The issue the component draws, from a Kanbus issue: nullable fields become absent, and the links the component has no field for are left out. */
export function kanbanIssueFromBotBoardIssue(issue: BotBoardIssue): KanbanIssue {
  const result: KanbanIssue = {
    id: issue.id,
    title: issue.title,
    type: textOrNull(issue.type) ?? "task",
    status: issue.status,
    priority: Number.isInteger(issue.priority) ? issue.priority : 2,
    labels: Array.isArray(issue.labels) ? issue.labels.filter((label) => typeof label === "string" && label !== "") : [],
  };
  const assignee = textOrNull(issue.assignee);
  if (assignee !== null) result.assignee = assignee;
  const parent = textOrNull(issue.parent);
  if (parent !== null) result.parent = parent;
  const description = textOrNull(issue.description);
  if (description !== null) result.description = description;
  const createdAt = textOrNull(issue.created_at);
  if (createdAt !== null) result.created_at = createdAt;
  const updatedAt = textOrNull(issue.updated_at);
  if (updatedAt !== null) result.updated_at = updatedAt;
  const closedAt = textOrNull(issue.closed_at);
  if (closedAt !== null) result.closed_at = closedAt;
  if (isRecord(issue.custom)) result.custom = issue.custom;
  if (Array.isArray(issue.comments) && issue.comments.length > 0) {
    result.comments = issue.comments.map((comment) => ({
      ...(comment.id === undefined ? {} : { id: comment.id }),
      author: comment.author,
      created_at: comment.created_at,
      ...(comment.text === undefined ? {} : { text: comment.text }),
      ...(comment.comment_type === undefined ? {} : { comment_type: comment.comment_type }),
      ...(comment.data === undefined ? {} : { data: comment.data }),
    }));
  }
  return result;
}

function statusCategoryFallback(key: string, initialStatus: string | null): string {
  if (key === "closed") return DONE_CATEGORY;
  if (key === initialStatus || key === "backlog" || key === "open") return TO_DO_CATEGORY;
  return IN_PROGRESS_CATEGORY;
}

function statusKeysOfWorkflows(workflows: Record<string, Record<string, string[]>> | undefined): string[] {
  const keys: string[] = [];
  if (!isRecord(workflows)) return keys;
  for (const workflow of Object.values(workflows)) {
    if (!isRecord(workflow)) continue;
    for (const [from, targets] of Object.entries(workflow)) {
      for (const key of [from, ...(Array.isArray(targets) ? targets : [])]) if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

function statusDefinitions(configuration: BotBoardConfiguration, issues: readonly KanbanIssue[]): KanbanStatusDefinition[] {
  const initialStatus = textOrNull(configuration.initial_status);
  const definitions: KanbanStatusDefinition[] = [];
  const add = (key: string, entry: Record<string, unknown> | null) => {
    if (definitions.some((definition) => definition.key === key)) return;
    const definition: KanbanStatusDefinition = {
      key,
      name: textOrNull(entry?.name) ?? statusColumnName(key),
      category: textOrNull(entry?.category) ?? statusCategoryFallback(key, initialStatus),
    };
    const color = textOrNull(entry?.color);
    if (color !== null) definition.color = color;
    if (typeof entry?.collapsed === "boolean") definition.collapsed = entry.collapsed;
    definitions.push(definition);
  };
  for (const entry of Array.isArray(configuration.statuses) ? configuration.statuses : []) {
    if (isRecord(entry) && textOrNull(entry.key) !== null) add(entry.key as string, entry);
  }
  if (definitions.length === 0) for (const key of statusKeysOfWorkflows(configuration.workflows)) add(key, null);
  for (const issue of issues) add(issue.status, null);
  return definitions;
}

function categoryDefinitions(configuration: BotBoardConfiguration, statuses: readonly KanbanStatusDefinition[]): KanbanCategoryDefinition[] {
  const definitions: KanbanCategoryDefinition[] = [];
  for (const entry of Array.isArray(configuration.categories) ? configuration.categories : []) {
    if (isRecord(entry) && textOrNull(entry.name) !== null && !definitions.some((definition) => definition.name === entry.name)) {
      const color = textOrNull(entry.color);
      definitions.push(color === null ? { name: entry.name as string } : { name: entry.name as string, color });
    }
  }
  for (const status of statuses) if (!definitions.some((definition) => definition.name === status.category)) definitions.push({ name: status.category });
  return definitions;
}

function priorityDefinitions(configuration: BotBoardConfiguration, issues: readonly KanbanIssue[]): Record<number, KanbanPriorityDefinition> {
  const priorities: Record<number, KanbanPriorityDefinition> = {};
  if (isRecord(configuration.priorities)) {
    for (const [key, entry] of Object.entries(configuration.priorities)) {
      const number = Number(key);
      if (!Number.isInteger(number)) continue;
      const name = isRecord(entry) ? textOrNull(entry.name) : null;
      const color = isRecord(entry) ? textOrNull(entry.color) : null;
      priorities[number] = { name: name === null ? priorityName(number) : capitalized(name), ...(color === null ? {} : { color }) };
    }
  }
  for (const issue of issues) if (priorities[issue.priority] === undefined) priorities[issue.priority] = { name: priorityName(issue.priority) };
  return priorities;
}

/**
 * The `KanbanConfig` for a bot board: the board's own statuses (with any status that a card uses and the
 * configuration lacks added, so no card is dropped), categories, priorities, type colors and workflows.
 */
export function kanbanConfigFromBotBoardConfiguration(configuration: BotBoardConfiguration, issues: readonly KanbanIssue[]): KanbanConfig {
  const statuses = statusDefinitions(configuration, issues);
  const typeColors: Record<string, string> = {};
  if (isRecord(configuration.type_colors)) {
    for (const [type, color] of Object.entries(configuration.type_colors)) if (typeof color === "string") typeColors[type] = color;
  }
  for (const issue of issues) if (typeColors[issue.type] === undefined) typeColors[issue.type] = FALLBACK_TYPE_COLOR;
  const config: KanbanConfig = {
    statuses,
    categories: categoryDefinitions(configuration, statuses),
    priorities: priorityDefinitions(configuration, issues),
    type_colors: typeColors,
  };
  if (Array.isArray(configuration.hierarchy)) config.hierarchy = configuration.hierarchy;
  if (Array.isArray(configuration.types)) config.types = configuration.types;
  if (isRecord(configuration.workflows)) config.workflows = configuration.workflows;
  if (isRecord(configuration.sort_order)) config.sort_order = configuration.sort_order as KanbanSortOrder;
  return config;
}
