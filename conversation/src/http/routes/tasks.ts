import type { Context } from "hono";
import { BotNotFoundError } from "../../domain/bots.ts";
import { invokeTaskTool, listTasks, TaskNotFoundError, taskById, TaskToolRequestError } from "../../domain/tasks.ts";
import type { Task } from "../../domain/tasks.ts";
import type { MessagingStore } from "../../store/messaging-store.ts";
import type { IdSource } from "../app.ts";
import { isRefusal, pathParameter, resolveUserPrincipal, type UserPrincipalDependencies } from "../user-principal.ts";

/** Everything the task routes depend on. */
export interface TaskRouteDependencies extends UserPrincipalDependencies {
	store: MessagingStore;
	ids: IdSource;
}

/** One task as the HTTP API renders it. */
export interface TaskPayload {
	task_id: string;
	tenant_id: string;
	user_id: string;
	title: string;
	status: string;
	evidence: string | null;
	close_reason: string | null;
	created_by_bot_id: string | null;
	updated_by_bot_id: string | null;
}

/** Render a task for the HTTP API. */
export function taskPayload(task: Task): TaskPayload {
	return {
		task_id: task.taskId,
		tenant_id: task.tenantId,
		user_id: task.userId,
		title: task.title,
		status: task.status,
		evidence: task.evidence ?? null,
		close_reason: task.closeReason ?? null,
		created_by_bot_id: task.createdByBotId ?? null,
		updated_by_bot_id: task.updatedByBotId ?? null,
	};
}

type TaskRequestBody = { bot_id: string; arguments: Record<string, string> };

function parseTaskRequestBody(raw: unknown, argumentNames: readonly string[]): TaskRequestBody | null {
	if (typeof raw !== "object" || raw === null) {
		return null;
	}
	const body = raw as Record<string, unknown>;
	if (typeof body.bot_id !== "string") {
		return null;
	}
	const arguments_: Record<string, string> = {};
	for (const name of argumentNames) {
		const value = body[name];
		if (value !== undefined && value !== null) {
			if (typeof value !== "string") {
				return null;
			}
			arguments_[name] = value;
		}
	}
	return { bot_id: body.bot_id, arguments: arguments_ };
}

async function runTaskTool(
	c: Context,
	deps: TaskRouteDependencies,
	userId: string,
	action: string,
	body: TaskRequestBody,
): Promise<Response> {
	try {
		const task = await invokeTaskTool(pathParameter(c, "tenant_id"), userId, body.bot_id, action, body.arguments, deps);
		return c.json(taskPayload(task), 200);
	} catch (error) {
		if (error instanceof BotNotFoundError) {
			return c.json({ detail: "bot not found" }, 404);
		}
		if (error instanceof TaskToolRequestError) {
			return c.json({ detail: error.message }, 422);
		}
		throw error;
	}
}

/** GET /orgs/{tenant_id}/users/{user_id}/tasks: the tasks one household user owns. */
export async function listUserTasksHandler(c: Context, deps: TaskRouteDependencies): Promise<Response> {
	const principal = await resolveUserPrincipal(c, deps);
	if (isRefusal(principal)) {
		return principal;
	}
	const tasks = await listTasks(pathParameter(c, "tenant_id"), pathParameter(c, "user_id"), deps);
	return c.json({ tasks: tasks.map(taskPayload) }, 200);
}

/** POST /orgs/{tenant_id}/users/{user_id}/tasks: a bot opens a task for the user, with the bot as provenance. */
export async function createUserTaskHandler(c: Context, deps: TaskRouteDependencies): Promise<Response> {
	const principal = await resolveUserPrincipal(c, deps);
	if (isRefusal(principal)) {
		return principal;
	}
	const body = parseTaskRequestBody(await c.req.json().catch(() => null), ["title"]);
	if (body === null) {
		return c.json({ detail: "bot_id and title are required" }, 422);
	}
	return runTaskTool(c, deps, pathParameter(c, "user_id"), "create", body);
}

/** GET /orgs/{tenant_id}/tasks/{task_id}: one task by identifier. */
export async function getTaskHandler(c: Context, deps: TaskRouteDependencies): Promise<Response> {
	const principal = await resolveUserPrincipal(c, deps);
	if (isRefusal(principal)) {
		return principal;
	}
	try {
		return c.json(taskPayload(await taskById(pathParameter(c, "tenant_id"), pathParameter(c, "task_id"), deps)), 200);
	} catch (error) {
		if (error instanceof TaskNotFoundError) {
			return c.json({ detail: "task not found" }, 404);
		}
		throw error;
	}
}

/**
 * PATCH /orgs/{tenant_id}/tasks/{task_id}: a bot completes the task with evidence or closes it with a reason. The task
 * keeps the owner it was created for.
 */
export async function patchTaskHandler(c: Context, deps: TaskRouteDependencies): Promise<Response> {
	const principal = await resolveUserPrincipal(c, deps);
	if (isRefusal(principal)) {
		return principal;
	}
	const raw = await c.req.json().catch(() => null);
	const action = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).action : undefined;
	const body = parseTaskRequestBody(raw, ["evidence", "reason"]);
	if (body === null || (action !== "complete" && action !== "close")) {
		return c.json({ detail: "bot_id and an action of complete or close are required" }, 422);
	}
	const taskId = pathParameter(c, "task_id");
	return runTaskTool(c, deps, "", action, { ...body, arguments: { ...body.arguments, task_id: taskId } });
}
