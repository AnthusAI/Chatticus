import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { invokeTaskTool, TASK_TOOL_ACTIONS, type TaskDependencies } from "../domain/tasks.ts";

/** The name the model calls the task tool by. */
export const TASK_TOOL_NAME = "task";

/** Who a turn's task tool acts for. */
export type TaskToolScope = {
	readonly tenantId: string;
	/** The household user whose tasks the bot manages: the human in the turn's channel. */
	readonly userId: string;
	readonly botId: string;
};

/**
 * The task tool as a pi-durable extension: create, read, complete or close a durable household task without summoning
 * the computer. Ported from python/src/chatticus/thin_task.py lines 168-217. A refused call (missing evidence, a task of
 * another organization, a malformed call) throws, which pi-durable hands the model as an error result.
 * The tool is replay-unsafe: a create that was interrupted must not run twice, so recovery reports it interrupted instead.
 *
 * @param scope Tenant, user and bot the calls act for.
 * @param deps Store and identifiers.
 * @returns The extensions to install into a registry.
 */
export function taskToolExtensions(scope: TaskToolScope, deps: TaskDependencies): Extension[] {
	const taskTool = defineTool({
		name: TASK_TOOL_NAME,
		description:
			"Create, read, complete, or close a durable household task. Use for job tracking without summoning the computer.",
		parameters: Type.Object({
			action: Type.Union(TASK_TOOL_ACTIONS.map((action) => Type.Literal(action))),
			title: Type.Optional(Type.String({ description: "Required for create." })),
			task_id: Type.Optional(Type.String({ description: "Required for get, complete, and close." })),
			evidence: Type.Optional(Type.String({ description: "Required for complete." })),
			reason: Type.Optional(Type.String({ description: "Required for close." })),
		}),
		replay: "unsafe",
		execute: async (args) => {
			const { action, ...rest } = args;
			const stringArguments: Record<string, string> = {};
			for (const [name, value] of Object.entries(rest)) {
				if (typeof value === "string") stringArguments[name] = value;
			}
			const task = await invokeTaskTool(scope.tenantId, scope.userId, scope.botId, action, stringArguments, deps);
			return { content: [{ type: "text", text: JSON.stringify(task) }] };
		},
	}) as unknown as ToolRegistration;
	return [defineExtension({ name: "chatticus-task", tools: [taskTool] })];
}
