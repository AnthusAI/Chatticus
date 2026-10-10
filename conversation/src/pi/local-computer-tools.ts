/**
 * The computer tools of an owner that runs inside the computer: `read_workspace`, `write_workspace` and `run_terminal`
 * executed on the owner's own disk by Pi's tools (pi-durable's `read`, `write` and `bash`), under our tool names, schemas
 * and descriptions. The tool set is the one `computerToolsExtension` registers (send and purchase stay as they are there), so a
 * session moves between a Lambda owner and a computer owner with the same tools. The owner image has no browser, so `browse`
 * and `request_computer_capability` answer at once, in the same attempt, that the browser capability is not available on
 * this computer; they park nothing and start no host.
 *
 * Each call goes through the action ledger, the same records the remote path writes, so the journal, the disk-dirty flag
 * and the reconciliation of lost hosts see local calls as they see remote ones:
 *
 * - the action of the call is done: its stored answer is the result, nothing runs again;
 * - there is none: it is created and claimed by this owner, the tool runs, and the answer is recorded;
 * - it is claimed and the call was started before (this owner replayed it, or its claimer is gone): a tool that is harmless
 *   to repeat runs again; `run_terminal` does not, its action is answered as interrupted and the model is told so.
 *
 * The tools are registered `replay: "safe"`: pi-durable reruns a pending call only when both its stored and its current
 * policy are safe, so a call the previous owner left pending runs here, and this module decides what rerunning means.
 *
 * `edit_workspace` maps onto Pi's `edit` with one replacement; it needs the file to exist and the text to occur once, so
 * running it a second time after it was applied is refused by the tool and changes nothing.
 */

import { join, posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { ComputerAction, ComputerActionStore } from "../domain/actions.ts";
import {
	ACTION_LEASE_SECONDS,
	answerComputerActionOnOwnAccount,
	completeComputerAction,
	requestComputerAction,
} from "../domain/actions.ts";
import { BROWSER_UNAVAILABLE_TEXT, ensureComputer, recordComputerToolAnswered } from "../domain/computers.ts";
import { BROWSE_ACTION_KIND, REQUEST_COMPUTER_CAPABILITY_ACTION_KIND } from "@chatticus/host-protocol";
import type { Turn } from "../domain/turns.ts";
import type { LogEmitter } from "../observability/log-line.ts";
import type { Clock, IdSource } from "../http/app.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import type { Extension, ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { type ComputerToolCall, type ComputerToolHandoff, computerToolsExtension, computerWorkPausedText, stringArguments } from "./computer-tools.ts";

/** The path the model sees as the root of the workspace; the gate's default grant covers it. */
export const WORKSPACE_VIRTUAL_ROOT = "/workspace";

/** The most characters of a command's output the model is given; the tail is kept, because that is where failures are. */
export const MAXIMUM_TERMINAL_OUTPUT_CHARACTERS = 30_000;

/** Seconds a command may run before it is stopped. */
export const TERMINAL_TIMEOUT_SECONDS = 600;

/** What the model reads when a command was started and nothing recorded how it ended. */
export const INTERRUPTED_TERMINAL_RESULT =
	"interrupted: the command was started and its owner stopped before it reported, so it may have partly run. It was not run again.";

/** What the model reads when another computer worker holds the call. */
export const HELD_BY_ANOTHER_WORKER_RESULT = "The computer action of this call is held by another worker, so it was not run here.";

const FALLBACK_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** The tools whose second run after an interruption is harmless: a read, a whole-file overwrite, and an edit that applies once. */
const REPEATABLE_TOOLS: ReadonlySet<string> = new Set(["read_workspace", "write_workspace", "edit_workspace", BROWSE_ACTION_KIND, REQUEST_COMPUTER_CAPABILITY_ACTION_KIND]);

/**
 * The environment a model-chosen command gets: a search path, a home inside the workspace, a locale and a terminal type.
 * Nothing else of the owner's environment (its model key, its cloud credentials) is passed on.
 *
 * @param home The command's home directory.
 * @param source The environment the search path is taken from.
 * @returns The four variables.
 */
export function scrubbedShellEnvironment(home: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const path = source["PATH"];
	return { PATH: path === undefined || path === "" ? FALLBACK_PATH : path, HOME: home, LANG: "C.UTF-8", TERM: "dumb" };
}

/**
 * Map a path the model named to the same place under the real workspace directory.
 *
 * @param root The real directory that plays the workspace.
 * @param virtualRoot The path the model sees it at.
 * @param path A path the model named, absolute or relative to the workspace.
 * @returns The real path.
 * @throws Error If the path leaves the workspace.
 */
export function resolveWorkspacePath(root: string, virtualRoot: string, path: string): string {
	const virtual = posix.resolve(virtualRoot, path);
	if (virtual !== virtualRoot && !virtual.startsWith(`${virtualRoot}/`)) {
		throw new Error(`The path ${JSON.stringify(path)} is outside the workspace.`);
	}
	return join(root, virtual.slice(virtualRoot.length));
}

/**
 * The last characters of a command's output, with a note when the start was dropped.
 *
 * @param text The whole output.
 * @param total How many characters the whole output had before any were dropped while it streamed.
 * @returns At most the limit of characters, and a first line saying so when some were left out.
 */
export function boundedTerminalOutput(text: string, total: number = text.length): string {
	if (total <= MAXIMUM_TERMINAL_OUTPUT_CHARACTERS) return text;
	return `[output truncated: showing the last ${MAXIMUM_TERMINAL_OUTPUT_CHARACTERS} of ${total} characters]\n${text.slice(-MAXIMUM_TERMINAL_OUTPUT_CHARACTERS)}`;
}

/**
 * Pi's `bash` tool set to run its command in `cwd` with the scrubbed environment and none of the owner's.
 *
 * @param workspaceRoot The real workspace directory, which is the command's home.
 * @param cwd The real directory the command starts in.
 * @returns The tool.
 */
export function createScrubbedBashTool(workspaceRoot: string, cwd: string): ToolRegistration {
	return createBashTool({
		prepare: (execution) => {
			execution.cwd = cwd;
			execution.env = scrubbedShellEnvironment(workspaceRoot);
			execution.inheritEnv = false;
		},
	}) as unknown as ToolRegistration;
}

class OutputTail {
	private kept = "";
	total = 0;

	append(chunk: string | Uint8Array): void {
		const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		this.total += text.length;
		this.kept = (this.kept + text).slice(-MAXIMUM_TERMINAL_OUTPUT_CHARACTERS);
	}

	text(): string {
		return boundedTerminalOutput(this.kept, this.total);
	}
}

/** Where the local tools run and what they record their calls with. */
export type LocalComputerToolsOptions = {
	/** The real directory that plays the workspace; the container's own `/workspace` in production. */
	readonly workspaceRoot: string;
	/** The path the model sees the workspace at; `/workspace` unless a test roots it elsewhere. */
	readonly workspacePath?: string;
	/** Identifies this owner on the actions it claims. */
	readonly workerId: string;
	/**
	 * The program the model's commands are started through, called as `<shellPath> -c <command>`; the owner's own default
	 * shell when absent. A computer that must keep commands away from the owner's credentials sets a launcher that
	 * switches to an unprivileged user before it runs the command.
	 */
	readonly shellPath?: string;
	/** The turn the tools run for; its actions belong to it. */
	readonly turn: Pick<Turn, "tenantId" | "turnId" | "channelId" | "botId" | "promptAuthorId">;
	readonly actions: ComputerActionStore;
	readonly messaging: MessagingStore;
	readonly clock: Clock;
	readonly ids: IdSource;
	/** Called after a tool ran and before its answer is recorded; a scenario holds the owner here to stand for a crash. */
	readonly beforeRecording?: (call: ComputerToolCall) => Promise<void>;
	/** Receives `tool_started` and `tool_finished` for each tool that runs here: the tool's name, how it ended and how long it took, never its arguments or output. */
	readonly log?: LogEmitter;
};

type Outcome = { readonly text: string; readonly isError: boolean; readonly result: ToolExecutionResult | null };

const textOf = (result: ToolExecutionResult): string =>
	(result.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");

const requiredString = (args: Record<string, unknown>, name: string): string => {
	const value = args[name];
	if (typeof value !== "string") throw new Error(`The argument ${JSON.stringify(name)} must be a string.`);
	return value;
};

/**
 * The computer tools of the session with every tool but send and purchase answered on this computer.
 *
 * @param handoff The owner's side of the handoff; every tool uses its lookup of an action and its spend ceiling
 * refusal.
 * @param options Workspace, identity and the stores the ledger lives in.
 * @returns The extension holding the tools.
 */
export function localComputerToolsExtension(handoff: ComputerToolHandoff, options: LocalComputerToolsOptions): Extension {
	const virtualRoot = options.workspacePath ?? WORKSPACE_VIRTUAL_ROOT;
	const env = new NodeExecutionEnv({ cwd: options.workspaceRoot, ...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }) });
	const readTool = createReadTool() as unknown as ToolRegistration;
	const writeTool = createWriteTool() as unknown as ToolRegistration;
	const editTool = createEditTool() as unknown as ToolRegistration;
	const virtualize = (text: string): string => (options.workspaceRoot === virtualRoot ? text : text.replaceAll(options.workspaceRoot, virtualRoot));
	const realPath = (path: string): string => resolveWorkspacePath(options.workspaceRoot, virtualRoot, path);

	const runBuiltin = async (tool: ToolRegistration, args: Record<string, unknown>, api: ToolExecutionApi, context: Context): Promise<Outcome> => {
		const result = await tool.execute(args as never, { ...api, env }, context);
		const text = virtualize(textOf(result));
		if (result.isError === true) {
			const diagnostics = (result.diagnostics ?? []).map((diagnostic) => diagnostic.message).join("\n");
			return { text: text !== "" ? text : diagnostics, isError: true, result: null };
		}
		return { text, isError: false, result: { ...result, content: [{ type: "text", text }] } };
	};

	const runTerminal = async (args: Record<string, unknown>, api: ToolExecutionApi, context: Context): Promise<Outcome> => {
		const cwdArgument = typeof args["cwd"] === "string" && args["cwd"].trim() !== "" ? args["cwd"] : virtualRoot;
		const cwd = realPath(cwdArgument);
		const tail = new OutputTail();
		const bash = createScrubbedBashTool(options.workspaceRoot, cwd);
		const capturing: ToolExecutionApi = {
			...api,
			env,
			output: (chunk) => {
				tail.append(chunk);
				api.output(chunk);
			},
		};
		try {
			await bash.execute({ command: requiredString(args, "command"), timeout: TERMINAL_TIMEOUT_SECONDS } as never, capturing, context);
		} catch (error) {
			if (context.abortSignal?.aborted) throw error;
			const output = virtualize(tail.text());
			const reason = error instanceof Error ? error.message : String(error);
			return { text: output === "" ? reason : `${output}\n\n${reason}`, isError: true, result: null };
		}
		const output = virtualize(tail.text());
		const text = output === "" ? "(no output)" : output;
		return { text, isError: false, result: { content: [{ type: "text", text }] } };
	};

	const runWithoutBrowser = async (): Promise<Outcome> => ({ text: BROWSER_UNAVAILABLE_TEXT, isError: false, result: null });

	const runners: Record<string, (args: Record<string, unknown>, api: ToolExecutionApi, context: Context) => Promise<Outcome>> = {
		read_workspace: (args, api, context) => {
			const next: Record<string, unknown> = { path: realPath(requiredString(args, "path")) };
			return runBuiltin(readTool, next, api, context);
		},
		write_workspace: (args, api, context) => {
			const next: Record<string, unknown> = { path: realPath(requiredString(args, "path")), content: requiredString(args, "content") };
			return runBuiltin(writeTool, next, api, context);
		},
		edit_workspace: (args, api, context) => {
			const next: Record<string, unknown> = {
				path: realPath(requiredString(args, "path")),
				edits: [{ oldText: requiredString(args, "old_text"), newText: requiredString(args, "new_text") }],
			};
			return runBuiltin(editTool, next, api, context);
		},
		run_terminal: runTerminal,
		[BROWSE_ACTION_KIND]: runWithoutBrowser,
		[REQUEST_COMPUTER_CAPABILITY_ACTION_KIND]: runWithoutBrowser,
	};

	const answerOf = (action: ComputerAction): ToolExecutionResult => {
		const text = action.result ?? "";
		if (action.resultIsError) throw new Error(text);
		return { content: [{ type: "text", text }] };
	};

	const leaseFromNow = (): Date => new Date(options.clock.now().getTime() + ACTION_LEASE_SECONDS * 1000);
	const { tenantId } = options.turn;

	const startedBefore = (action: ComputerAction): boolean =>
		action.claimedBy === options.workerId ||
		action.leaseExpiresAt === null ||
		action.leaseExpiresAt.getTime() <= options.clock.now().getTime();

	type Acquired = { readonly kind: "answered"; readonly action: ComputerAction } | { readonly kind: "run"; readonly action: ComputerAction };

	const claimForRun = async (action: ComputerAction): Promise<Acquired> => {
		const claimed = await options.actions.claim({ tenantId, actionId: action.actionId, workerId: options.workerId, leaseExpiresAt: leaseFromNow() });
		if (claimed !== null) return { kind: "run", action: claimed };
		const current = await options.actions.get(tenantId, action.actionId);
		if (current?.status === "done") return { kind: "answered", action: current };
		throw new Error(HELD_BY_ANOTHER_WORKER_RESULT);
	};

	const acquire = async (call: ComputerToolCall, existing: ComputerAction | null): Promise<Acquired | { readonly kind: "refused"; readonly text: string }> => {
		let action = existing;
		if (action === null) {
			const reason = await handoff.refusal(call);
			if (reason !== null) return { kind: "refused", text: computerWorkPausedText(reason) };
			const computer = await ensureComputer(tenantId, { store: options.messaging, ids: options.ids });
			action = await requestComputerAction(
				{ actions: options.actions, clock: options.clock, ids: options.ids },
				{
					tenantId,
					computerId: computer.computerId,
					turnId: options.turn.turnId,
					channelId: options.turn.channelId,
					botId: options.turn.botId,
					userId: options.turn.promptAuthorId,
					callId: call.callId,
					toolName: call.toolName,
					arguments: call.arguments,
				},
			);
		}
		if (action.status === "done") return { kind: "answered", action };
		if (action.status === "requested") return claimForRun(action);
		if (!startedBefore(action)) throw new Error(HELD_BY_ANOTHER_WORKER_RESULT);
		if (!REPEATABLE_TOOLS.has(call.toolName)) {
			const answered = await answerComputerActionOnOwnAccount(
				{ actions: options.actions, clock: options.clock },
				action,
				{ result: INTERRUPTED_TERMINAL_RESULT, isError: true },
			);
			if (answered !== null) await recordComputerToolAnswered(tenantId, call.toolName, { store: options.messaging });
			const stored = answered ?? (await options.actions.get(tenantId, action.actionId)) ?? action;
			return { kind: "answered", action: stored };
		}
		if (action.claimedBy === options.workerId) {
			const renewed = await options.actions.renew({ tenantId, actionId: action.actionId, workerId: options.workerId, leaseExpiresAt: leaseFromNow() });
			if (renewed !== null) return { kind: "run", action: renewed };
			throw new Error(HELD_BY_ANOTHER_WORKER_RESULT);
		}
		const released = await options.actions.release(tenantId, action.actionId);
		if (released === null) {
			const current = await options.actions.get(tenantId, action.actionId);
			if (current?.status === "done") return { kind: "answered", action: current };
			throw new Error(HELD_BY_ANOTHER_WORKER_RESULT);
		}
		return claimForRun(released);
	};

	const base = computerToolsExtension(handoff);
	const tools = (base.tools ?? []).map((tool): ToolRegistration => {
		const runner = runners[tool.name];
		if (runner === undefined) return tool;
		return {
			...tool,
			replay: "safe",
			execute: async (args: never, api: ToolExecutionApi, toolContext: Context): Promise<ToolExecutionResult> => {
				const call: ComputerToolCall = { toolName: tool.name, arguments: stringArguments(args), callId: api.callId };
				const acquired = await acquire(call, await handoff.lookup(call));
				if (acquired.kind === "refused") return { content: [{ type: "text", text: acquired.text }] };
				if (acquired.kind === "answered") return answerOf(acquired.action);
				const { action } = acquired;
				const renewal = setInterval(
					() =>
						void options.actions
							.renew({ tenantId, actionId: action.actionId, workerId: options.workerId, leaseExpiresAt: leaseFromNow() })
							.catch(() => undefined),
					(ACTION_LEASE_SECONDS * 1000) / 3,
				);
				let outcome: Outcome;
				const startedAt = Date.now();
				options.log?.("tool_started", { tool: call.toolName, action_id: action.actionId });
				try {
					try {
						outcome = await runner(args as Record<string, unknown>, api, toolContext);
					} catch (error) {
						if (toolContext.abortSignal?.aborted) throw error;
						outcome = { text: error instanceof Error ? error.message : String(error), isError: true, result: null };
					}
				} finally {
					clearInterval(renewal);
				}
				options.log?.("tool_finished", {
					tool: call.toolName,
					action_id: action.actionId,
					status: outcome.isError ? "error" : "ok",
					duration_ms: Date.now() - startedAt,
				});
				await options.beforeRecording?.(call);
				const { action: stored, recorded } = await completeComputerAction(
					{ actions: options.actions, clock: options.clock },
					tenantId,
					action.actionId,
					options.workerId,
					{ result: outcome.text, isError: outcome.isError },
				);
				if (recorded) await recordComputerToolAnswered(tenantId, call.toolName, { store: options.messaging });
				if (recorded && outcome.result !== null) return outcome.result;
				return answerOf(stored);
			},
		} as unknown as ToolRegistration;
	});
	return { ...base, tools };
}
