/**
 * The container owner's computer tools: the same names, descriptions and schemas as conversation/src/pi/computer-tools.ts,
 * with `execute` replaced by pi-durable's built-in coding tools running on a NodeExecutionEnv. Each call goes through the
 * action ledger (look up, claim, run, complete), which is the existing guard against running one call twice.
 */
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { completeComputerAction, requestComputerAction } from "../../../conversation/src/domain/actions.ts";
import { ensureComputer } from "../../../conversation/src/domain/computers.ts";
import { getTurn } from "../../../conversation/src/domain/turns.ts";
import { type ComputerToolHandoff, computerToolsExtension, stringArguments } from "../../../conversation/src/pi/computer-tools.ts";
import type { ExecutorDeps } from "../../../conversation/src/turn/types.ts";
import { journal } from "./common.ts";

type Builtin = { execute: (args: unknown, api: unknown, context: unknown) => Promise<{ content?: Array<{ type: string; text?: string }> }> };
const builtins = new Map<string, Builtin>(((CodingTools.tools ?? []) as readonly ToolRegistration[]).map((tool) => [tool.name, tool as unknown as Builtin]));

/** Which built-in runs which of our tool names. */
const BUILTIN_FOR: Record<string, string> = { read_workspace: "read", write_workspace: "write", run_terminal: "bash" };

export type LocalToolOptions = {
	/** Directory that plays /workspace. In the container it is /workspace itself. */
	readonly root: string;
	readonly workerId: string;
	readonly owner: string;
	readonly deps: ExecutorDeps;
	readonly tenantId: string;
	readonly turnId: string;
};

/**
 * Build the override that `generated/executor-seamed.ts` reads from its dependencies.
 *
 * @param options Workspace root, worker identity and the executor dependencies.
 * @returns A function from the executor's handoff to the extensions that replace the park tools.
 */
export function localComputerToolsOverride(options: LocalToolOptions): (handoff: ComputerToolHandoff) => Extension[] {
	const { root, workerId, owner, deps, tenantId, turnId } = options;
	const rebase = (text: string): string => (root === "/workspace" ? text : text.replaceAll("/workspace", root));
	return (handoff) => {
		const parkExtension = computerToolsExtension(handoff);
		const tools = (parkExtension.tools ?? []).map((tool) => {
			const builtinName = BUILTIN_FOR[tool.name];
			if (builtinName === undefined) return tool;
			return {
				...tool,
				replay: "safe" as const,
				execute: async (args: Record<string, unknown>, api: { callId: string }, context: unknown) => {
					const call = { toolName: tool.name, arguments: stringArguments(args), callId: api.callId };
					let action = await handoff.lookup(call);
					if (action?.status === "done") {
						journal(owner, "tool.ledger.already_done", { tool: tool.name, callId: api.callId, actionId: action.actionId });
						return { content: [{ type: "text" as const, text: action.result ?? "" }] };
					}
					if (action === null) {
						const turn = await getTurn(deps.turns, tenantId, turnId);
						const computer = await ensureComputer(tenantId, { store: deps.messaging, ids: deps.turns.ids });
						action = await requestComputerAction(
							{ actions: deps.computer.actions, clock: deps.turns.clock, ids: deps.turns.ids },
							{ tenantId, computerId: computer.computerId, turnId, channelId: turn.channelId, botId: turn.botId, userId: turn.promptAuthorId, ...call },
						);
						journal(owner, "tool.ledger.created", { tool: tool.name, callId: api.callId, actionId: action.actionId });
					}
					const claimed = await deps.computer.actions.claim({
						tenantId,
						actionId: action.actionId,
						workerId,
						leaseExpiresAt: new Date(Date.now() + 60_000),
					});
					journal(owner, "tool.ledger.claimed", { tool: tool.name, actionId: action.actionId, claimed: claimed !== null, previousStatus: action.status });
					if (claimed === null && action.status !== "claimed") throw new Error(`The action ${action.actionId} could not be claimed (status ${action.status}).`);
					const mapped: Record<string, unknown> = { ...args };
					if (typeof mapped["path"] === "string") mapped["path"] = rebase(mapped["path"]);
					if (tool.name === "run_terminal") {
						const cwd = typeof mapped["cwd"] === "string" ? rebase(mapped["cwd"]) : undefined;
						mapped["command"] = `${cwd === undefined ? "" : `cd ${JSON.stringify(cwd)} && `}${rebase(String(mapped["command"]))}`;
						delete mapped["cwd"];
					}
					const env = new NodeExecutionEnv({ cwd: root });
					let captured = "";
					const scoped = new Proxy(api as object, {
						get(target, property) {
							if (property === "env") return env;
							if (property === "output") {
								return (chunk: string | Uint8Array) => {
									captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
									(target as { output(chunk: string | Uint8Array): void }).output(chunk);
								};
							}
							const value = Reflect.get(target, property, target);
							return typeof value === "function" ? value.bind(target) : value;
						},
					});
					journal(owner, "tool.run.local", { tool: tool.name, builtin: builtinName, callId: api.callId, cwd: root });
					try {
						const result = await builtins.get(builtinName)!.execute(mapped, scoped, context);
						const text = result.content === undefined ? captured : result.content.map((part) => part.text ?? "").join("");
						await completeComputerAction({ actions: deps.computer.actions, clock: deps.turns.clock }, tenantId, action.actionId, workerId, { result: text, isError: false });
						journal(owner, "tool.ledger.completed", { actionId: action.actionId, isError: false });
						return result;
					} catch (error) {
						await completeComputerAction({ actions: deps.computer.actions, clock: deps.turns.clock }, tenantId, action.actionId, workerId, {
							result: (error as Error).message,
							isError: true,
						});
						journal(owner, "tool.ledger.completed", { actionId: action.actionId, isError: true });
						throw error;
					}
				},
			} as unknown as ToolRegistration;
		});
		return [{ ...parkExtension, tools }];
	};
}
