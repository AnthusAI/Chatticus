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
 * The three file tools never open a path in the owner process. The owner runs as root with the organization's scoped
 * credentials, and the model's shell may plant symbolic links in the workspace, so the tools run on an
 * `UnprivilegedExecutionEnv`: each file operation is carried out by a helper started through the shell launcher, as the
 * shell's own user, and can reach only what the shell can reach. `run_terminal` does not open its working directory either:
 * the shell, as its user, changes into it. The lexical check of `resolveWorkspacePath` stays as the first line.
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
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { scrubbedShellEnvironment } from "./shell-environment.ts";
import { SOURCE_FILE_HELPER_COMMAND, UnprivilegedExecutionEnv } from "./unprivileged-execution-env.ts";
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

/** The tools whose second run after an interruption is harmless: a read, a whole-file overwrite, and an edit that applies once. */
const REPEATABLE_TOOLS: ReadonlySet<string> = new Set(["read_workspace", "write_workspace", "edit_workspace", BROWSE_ACTION_KIND, REQUEST_COMPUTER_CAPABILITY_ACTION_KIND]);

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
 * The execution environment of an owner: file operations carried out by the helper through the launcher, commands started
 * through the launcher.
 *
 * @param workspaceRoot The real workspace directory.
 * @param shellPath The unprivileged launcher; the default shell when absent.
 * @param fileHelperCommand The program and arguments that run the file helper; the helper source next to this module when absent.
 * @returns The environment.
 */
export function createOwnerExecutionEnv(workspaceRoot: string, shellPath?: string, fileHelperCommand?: readonly string[]): UnprivilegedExecutionEnv {
	return new UnprivilegedExecutionEnv({
		cwd: workspaceRoot,
		launcherPath: shellPath ?? "/bin/bash",
		helperCommand: fileHelperCommand ?? SOURCE_FILE_HELPER_COMMAND,
		helperEnvironment: scrubbedShellEnvironment(workspaceRoot),
	});
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

const shellQuoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

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
	/**
	 * The program and arguments, by absolute path, that run the file helper through the launcher. The helper source file
	 * next to this module when absent; the image's owner passes its bundled helper.
	 */
	readonly fileHelperCommand?: readonly string[];
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

const textOf = (result: ToolExecutionResult): string =>
	(result.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");

const requiredString = (args: Record<string, unknown>, name: string): string => {
	const value = args[name];
	if (typeof value !== "string") throw new Error(`The argument ${JSON.stringify(name)} must be a string.`);
	return value;
};

/** What a tool answered: the text for the model, whether it is an error, and the result to return when the call is recorded. */
export type WorkspaceToolOutcome = { readonly text: string; readonly isError: boolean; readonly result: ToolExecutionResult | null };

/** A tool of the owner, run with its arguments, the call's api and its context. */
export type WorkspaceToolRunner = (args: Record<string, unknown>, api: ToolExecutionApi, context: Context) => Promise<WorkspaceToolOutcome>;

/**
 * The `read_workspace`, `write_workspace` and `edit_workspace` runners: Pi's `read`, `write` and `edit` on the given
 * environment, with the model's path mapped into the real workspace and the real workspace path hidden in what they answer.
 * The environment decides who touches the files; the owner passes the unprivileged one.
 *
 * @param env The environment the file operations run on.
 * @param workspaceRoot The real workspace directory.
 * @param virtualRoot The path the model sees it at.
 * @returns The three runners by tool name.
 */
export function workspaceFileToolRunners(env: ToolExecutionApi["env"], workspaceRoot: string, virtualRoot: string): Record<"read_workspace" | "write_workspace" | "edit_workspace", WorkspaceToolRunner> {
	const readTool = createReadTool() as unknown as ToolRegistration;
	const writeTool = createWriteTool() as unknown as ToolRegistration;
	const editTool = createEditTool() as unknown as ToolRegistration;
	const virtualize = (text: string): string => (workspaceRoot === virtualRoot ? text : text.replaceAll(workspaceRoot, virtualRoot));
	const realPath = (path: string): string => resolveWorkspacePath(workspaceRoot, virtualRoot, path);
	const runBuiltin = async (tool: ToolRegistration, args: Record<string, unknown>, api: ToolExecutionApi, context: Context): Promise<WorkspaceToolOutcome> => {
		const result = await tool.execute(args as never, { ...api, env }, context);
		const text = virtualize(textOf(result));
		if (result.isError === true) {
			const diagnostics = (result.diagnostics ?? []).map((diagnostic) => diagnostic.message).join("\n");
			return { text: text !== "" ? text : diagnostics, isError: true, result: null };
		}
		return { text, isError: false, result: { ...result, content: [{ type: "text", text }] } };
	};
	return {
		read_workspace: (args, api, context) => runBuiltin(readTool, { path: realPath(requiredString(args, "path")) }, api, context),
		write_workspace: (args, api, context) =>
			runBuiltin(writeTool, { path: realPath(requiredString(args, "path")), content: requiredString(args, "content") }, api, context),
		edit_workspace: (args, api, context) =>
			runBuiltin(
				editTool,
				{ path: realPath(requiredString(args, "path")), edits: [{ oldText: requiredString(args, "old_text"), newText: requiredString(args, "new_text") }] },
				api,
				context,
			),
	};
}

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
	const env = createOwnerExecutionEnv(options.workspaceRoot, options.shellPath, options.fileHelperCommand);
	const virtualize = (text: string): string => (options.workspaceRoot === virtualRoot ? text : text.replaceAll(options.workspaceRoot, virtualRoot));
	const realPath = (path: string): string => resolveWorkspacePath(options.workspaceRoot, virtualRoot, path);
	const fileRunners = workspaceFileToolRunners(env, options.workspaceRoot, virtualRoot);

	const runTerminal = async (args: Record<string, unknown>, api: ToolExecutionApi, context: Context): Promise<WorkspaceToolOutcome> => {
		const cwdArgument = typeof args["cwd"] === "string" && args["cwd"].trim() !== "" ? args["cwd"] : virtualRoot;
		const cwd = realPath(cwdArgument);
		const tail = new OutputTail();
		const bash = createScrubbedBashTool(options.workspaceRoot, options.workspaceRoot);
		const command = requiredString(args, "command");
		const startedIn = cwd === options.workspaceRoot ? command : `cd -- ${shellQuoted(cwd)} || exit 1\n${command}`;
		const capturing: ToolExecutionApi = {
			...api,
			env,
			output: (chunk) => {
				tail.append(chunk);
				api.output(chunk);
			},
		};
		try {
			await bash.execute({ command: startedIn, timeout: TERMINAL_TIMEOUT_SECONDS } as never, capturing, context);
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

	const runWithoutBrowser = async (): Promise<WorkspaceToolOutcome> => ({ text: BROWSER_UNAVAILABLE_TEXT, isError: false, result: null });

	const runners: Record<string, (args: Record<string, unknown>, api: ToolExecutionApi, context: Context) => Promise<WorkspaceToolOutcome>> = {
		...fileRunners,
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
				let outcome: WorkspaceToolOutcome;
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
