import type { ActionResultRequest, HostAction } from "@chatticus/host-protocol";
import { type SnapshotObjectStore } from "../../../conversation/src/snapshot/store.ts";
import { TerminalActionExecutor } from "./executors/terminal.ts";
import { WorkspaceActionExecutor } from "./executors/workspace.ts";
import { pythonRepr, ValueError } from "./workspace-paths.ts";

const WORKSPACE_TOOLS: ReadonlySet<string> = new Set(["read_workspace", "write_workspace"]);
const TERMINAL_TOOLS: ReadonlySet<string> = new Set(["run_terminal"]);

/** What the host dispatcher runs on: ready executors, or the live root and store to build them from. */
export type HostActionExecutorOptions = {
	readonly workspaceExecutor?: WorkspaceActionExecutor;
	readonly terminalExecutor?: TerminalActionExecutor;
	readonly liveRoot?: string;
	readonly store?: SnapshotObjectStore;
};

/** Run one committed computer tool on the summoned host. */
export class HostActionExecutor {
	private readonly workspace: WorkspaceActionExecutor;
	private readonly terminal: TerminalActionExecutor;

	constructor(options: HostActionExecutorOptions = {}) {
		this.workspace =
			options.workspaceExecutor ??
			new WorkspaceActionExecutor({
				...(options.liveRoot === undefined ? {} : { liveRoot: options.liveRoot }),
				...(options.store === undefined ? {} : { store: options.store }),
			});
		this.terminal =
			options.terminalExecutor ?? new TerminalActionExecutor(options.liveRoot === undefined ? {} : { liveRoot: options.liveRoot });
	}

	/**
	 * Return the durable tool.result body for one host action.
	 *
	 * @param toolName The tool the action runs.
	 * @param arguments_ The call's arguments.
	 * @throws ValueError If no executor of the host supports the tool.
	 */
	async execute(toolName: string, arguments_: Readonly<Record<string, string>>): Promise<string> {
		if (WORKSPACE_TOOLS.has(toolName)) {
			return this.workspace.execute(toolName, arguments_);
		}
		if (TERMINAL_TOOLS.has(toolName)) {
			return this.terminal.execute(toolName, arguments_);
		}
		throw new ValueError(`HostActionExecutor does not support ${pythonRepr(toolName)}.`);
	}
}

/**
 * Run one claimed action on the host and return the body to post as its result.
 *
 * @param action The action the host claimed.
 * @param executor The executor to run it on; one over the environment's live root when omitted.
 * @throws ValueError If the host does not support the action's tool.
 */
export async function executeAction(action: HostAction, executor: HostActionExecutor = new HostActionExecutor()): Promise<ActionResultRequest> {
	return { result: await executor.execute(action.tool_name, action.arguments) };
}
