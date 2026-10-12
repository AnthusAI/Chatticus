import { readdir, readFile } from "node:fs/promises";
import type { UnprivilegedProcessSweeper } from "./supervisor-ports.ts";

/** The user id the image gives the unprivileged shell user the model's commands run as. */
export const UNPRIVILEGED_SHELL_USER_ID = 2000;

/** One process as the table lists it. */
export type TableProcess = { readonly pid: number; readonly uid: number };

/** The process table and the way to kill a process in it. */
export interface ProcessTable {
	list(): Promise<readonly TableProcess[]>;
	kill(pid: number): void;
}

/**
 * Read the real user id from the text of `/proc/<pid>/status`.
 *
 * @param status The file's text.
 * @returns The real uid, or null when the file has no readable `Uid:` line.
 */
export function realUserIdOfStatus(status: string): number | null {
	const match = /^Uid:\s+(\d+)/m.exec(status);
	return match === null ? null : Number.parseInt(match[1]!, 10);
}

/**
 * The process table of this machine, read from `/proc`. A process that ends between the listing and the read is skipped.
 *
 * @param procRoot The `/proc` directory.
 * @returns The table.
 */
export function procProcessTable(procRoot: string = "/proc"): ProcessTable {
	return {
		async list() {
			const processes: TableProcess[] = [];
			for (const entry of await readdir(procRoot)) {
				if (!/^\d+$/.test(entry)) continue;
				try {
					const uid = realUserIdOfStatus(await readFile(`${procRoot}/${entry}/status`, "utf8"));
					if (uid !== null) processes.push({ pid: Number.parseInt(entry, 10), uid });
				} catch {
					continue;
				}
			}
			return processes;
		},
		kill(pid) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				return;
			}
		},
	};
}

/**
 * Kills every process of the unprivileged shell user and no other. Run after each turn, because a command that backgrounds
 * itself must not outlive its turn in a container that now lives for most of an hour.
 */
export class ShellUserProcessSweeper implements UnprivilegedProcessSweeper {
	private readonly table: ProcessTable;
	private readonly userId: number;

	constructor(table: ProcessTable, userId: number = UNPRIVILEGED_SHELL_USER_ID) {
		this.table = table;
		this.userId = userId;
	}

	async sweep(): Promise<number> {
		const targets = (await this.table.list()).filter((entry) => entry.uid === this.userId);
		for (const target of targets) this.table.kill(target.pid);
		return targets.length;
	}
}
