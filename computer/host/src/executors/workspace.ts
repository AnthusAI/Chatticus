import { join } from "node:path";
import { ComputerHostDisk } from "../../../../conversation/src/snapshot/host.ts";
import { FilesystemSnapshotStore, type SnapshotObjectStore } from "../../../../conversation/src/snapshot/store.ts";
import { pythonRepr, ValueError, workspaceRelativePath } from "../workspace-paths.ts";

const DEFAULT_LIVE_ROOT = "/var/lib/chatticus/computer";

/** The host live-disk root from the environment. */
export function liveRootFromEnvironment(): string {
	return (process.env["CHATTICUS_LIVE_ROOT"] ?? DEFAULT_LIVE_ROOT).replace(/\/+$/, "");
}

/**
 * Return one host disk for workspace tool execution.
 *
 * @param liveRoot The live-disk root; the environment names it when omitted.
 * @param store The snapshot store; a store inside the live root stands in when omitted.
 */
export function workspaceHostDisk(liveRoot?: string, store?: SnapshotObjectStore): ComputerHostDisk {
	const root = liveRoot ?? liveRootFromEnvironment();
	const resolvedStore = store ?? new FilesystemSnapshotStore(join(root, ".ephemeral-snapshot"));
	return new ComputerHostDisk(root, resolvedStore);
}

/** What the workspace executor runs on: a live root and store to build a disk from, or a disk. */
export type WorkspaceActionExecutorOptions = {
	readonly liveRoot?: string;
	readonly store?: SnapshotObjectStore;
	readonly disk?: ComputerHostDisk;
};

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}

/** Run read_workspace and write_workspace on the host live disk. */
export class WorkspaceActionExecutor {
	private readonly disk: ComputerHostDisk;

	constructor(options: WorkspaceActionExecutorOptions = {}) {
		this.disk = options.disk ?? workspaceHostDisk(options.liveRoot, options.store);
	}

	/**
	 * Return the durable tool.result body for one workspace action.
	 *
	 * @param toolName `read_workspace` or `write_workspace`.
	 * @param arguments_ The call's arguments.
	 * @throws ValueError If the tool is not a workspace tool.
	 */
	async execute(toolName: string, arguments_: Readonly<Record<string, string>>): Promise<string> {
		try {
			if (toolName === "read_workspace") {
				return this.readWorkspace(arguments_);
			}
			if (toolName === "write_workspace") {
				return this.writeWorkspace(arguments_);
			}
		} catch (error) {
			if (error instanceof ValueError) {
				return `error: ${error.message}`;
			}
			throw error;
		}
		throw new ValueError(`WorkspaceActionExecutor does not support ${pythonRepr(toolName)}.`);
	}

	private readWorkspace(arguments_: Readonly<Record<string, string>>): string {
		const path = (arguments_["path"] ?? "").trim();
		if (path === "") {
			throw new ValueError("read_workspace requires path");
		}
		const relative = workspaceRelativePath(path);
		try {
			return this.disk.readWorkspaceFile(relative);
		} catch (error) {
			if (isFileSystemError(error) && error.code === "ENOENT") {
				return `not found: ${path}`;
			}
			if (isFileSystemError(error)) {
				return `error: ${error.message}`;
			}
			throw error;
		}
	}

	private writeWorkspace(arguments_: Readonly<Record<string, string>>): string {
		const path = (arguments_["path"] ?? "").trim();
		if (path === "") {
			throw new ValueError("write_workspace requires path");
		}
		const content = arguments_["content"] ?? "";
		const relative = workspaceRelativePath(path);
		this.disk.writeWorkspaceFile(relative, content);
		return `write_workspace:${path}`;
	}
}
