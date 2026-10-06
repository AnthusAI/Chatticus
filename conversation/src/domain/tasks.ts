import type { IdSource } from "../http/app.ts";
import {
	TaskAccessDeniedError,
	TaskCloseReasonRequiredError,
	TaskEvidenceRequiredError,
	TaskNotFoundError,
} from "../http/errors.ts";
import type { Task } from "../store/codecs/task.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import { botById, pythonRepr } from "./bots.ts";

export { TaskAccessDeniedError, TaskCloseReasonRequiredError, TaskEvidenceRequiredError, TaskNotFoundError };
export type { Task };

/** Lifecycle of one durable Task item outside the channel. */
export const TaskStatus = {
	Open: "open",
	Blocked: "blocked",
	Completed: "completed",
	Closed: "closed",
} as const;

/** The actions of the task tool, in the order the model sees them. */
export const TASK_TOOL_ACTIONS = ["create", "get", "complete", "close"] as const;

/** One action of the task tool. */
export type TaskToolAction = (typeof TASK_TOOL_ACTIONS)[number];

/** A task tool call that is malformed: a missing title, a missing task id or an unknown action (the Python ValueError). */
export class TaskToolRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TaskToolRequestError";
	}
}

/** What the task functions read and write. */
export type TaskDependencies = { store: MessagingStore; ids: IdSource };

/**
 * Create one open Task item with bot provenance.
 *
 * Ported from python/src/chatticus/control_plane.py lines 876-893.
 */
export async function createTask(
	tenantId: string,
	userId: string,
	title: string,
	options: { createdByBotId: string },
	deps: TaskDependencies,
): Promise<Task> {
	const task: Task = {
		taskId: deps.ids.next(),
		tenantId,
		userId,
		title,
		status: TaskStatus.Open,
		createdByBotId: options.createdByBotId,
		updatedByBotId: options.createdByBotId,
	};
	await deps.store.putTask(task);
	return task;
}

/**
 * Return one Task item owned by the tenant.
 *
 * Ported from python/src/chatticus/control_plane.py lines 895-905.
 *
 * @throws TaskNotFoundError If the task is unknown to this tenant.
 */
export async function taskById(tenantId: string, taskId: string, deps: { store: MessagingStore }): Promise<Task> {
	const record = await deps.store.getTask(tenantId, taskId);
	if (record === null || record.tenantId !== tenantId) {
		throw new TaskNotFoundError(`Task ${pythonRepr(taskId)} is unknown to tenant ${pythonRepr(tenantId)}.`);
	}
	return record;
}

/**
 * Return the tasks owned by one household user.
 *
 * Ported from python/src/chatticus/control_plane.py lines 907-910.
 */
export async function listTasks(tenantId: string, userId: string, deps: { store: MessagingStore }): Promise<Task[]> {
	const tasks = await deps.store.listTasks(tenantId, userId);
	return tasks.filter((task) => task.tenantId === tenantId);
}

/**
 * Mark one task completed with durable evidence.
 *
 * Ported from python/src/chatticus/control_plane.py lines 912-932.
 *
 * @throws TaskEvidenceRequiredError If the evidence is empty.
 */
export async function completeTask(
	tenantId: string,
	taskId: string,
	options: { evidence: string; updatedByBotId: string },
	deps: { store: MessagingStore },
): Promise<Task> {
	if (options.evidence.trim() === "") {
		throw new TaskEvidenceRequiredError(`Task ${pythonRepr(taskId)} cannot reach completed without evidence.`);
	}
	const record = await taskById(tenantId, taskId, deps);
	const completed: Task = {
		...record,
		status: TaskStatus.Completed,
		evidence: options.evidence,
		updatedByBotId: options.updatedByBotId,
	};
	await deps.store.putTask(completed);
	return completed;
}

/**
 * Close one task with a recorded reason.
 *
 * Ported from python/src/chatticus/control_plane.py lines 934-954.
 *
 * @throws TaskCloseReasonRequiredError If the reason is empty.
 */
export async function closeTask(
	tenantId: string,
	taskId: string,
	options: { reason: string; updatedByBotId: string },
	deps: { store: MessagingStore },
): Promise<Task> {
	if (options.reason.trim() === "") {
		throw new TaskCloseReasonRequiredError(`Task ${pythonRepr(taskId)} cannot close without a reason.`);
	}
	const record = await taskById(tenantId, taskId, deps);
	const closed: Task = {
		...record,
		status: TaskStatus.Closed,
		closeReason: options.reason,
		updatedByBotId: options.updatedByBotId,
	};
	await deps.store.putTask(closed);
	return closed;
}

/**
 * Dispatch one structured task tool call. The task tool never summons a computer and never enqueues computer work.
 *
 * Ported from python/src/chatticus/control_plane.py lines 956-1008.
 *
 * @throws BotNotFoundError If the bot is unknown to the tenant.
 * @throws TaskToolRequestError If the call lacks a title or a task id, or names an unknown action.
 */
export async function invokeTaskTool(
	tenantId: string,
	userId: string,
	botId: string,
	action: string,
	arguments_: Readonly<Record<string, string>>,
	deps: TaskDependencies,
): Promise<Task> {
	await botById(tenantId, botId, deps);
	if (action === "create") {
		const title = (arguments_["title"] ?? "").trim();
		if (title === "") {
			throw new TaskToolRequestError("Task create requires a title.");
		}
		return createTask(tenantId, userId, title, { createdByBotId: botId }, deps);
	}
	const taskId = (arguments_["task_id"] ?? "").trim();
	if (taskId === "") {
		throw new TaskToolRequestError(`Task action ${pythonRepr(action)} requires task_id.`);
	}
	if (action === "get") {
		return taskById(tenantId, taskId, deps);
	}
	if (action === "complete") {
		return completeTask(tenantId, taskId, { evidence: arguments_["evidence"] ?? "", updatedByBotId: botId }, deps);
	}
	if (action === "close") {
		return closeTask(tenantId, taskId, { reason: arguments_["reason"] ?? "", updatedByBotId: botId }, deps);
	}
	throw new TaskToolRequestError(`Unsupported task tool action ${pythonRepr(action)}.`);
}
