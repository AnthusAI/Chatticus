import { spawn } from "node:child_process";
import type { ChildExit, ChildSpawner, OwnerChildSubcommand, SpawnedChild } from "./supervisor-ports.ts";

/** The owner program a child runs: the Node binary, the owner bundle and the directory the child starts in. */
export type ChildProgram = {
	readonly command: string;
	readonly bundlePath: string;
	readonly cwd: string;
};

/**
 * Starts the per-turn child as a real process: its own process group, no standard input, and the supervisor's standard
 * output and error so its lines reach the container log beside the supervisor's. The environment is exactly the one given.
 */
export class ProcessChildSpawner implements ChildSpawner {
	private readonly program: ChildProgram;

	constructor(program: ChildProgram) {
		this.program = program;
	}

	spawn(subcommand: OwnerChildSubcommand, environment: Record<string, string>): SpawnedChild {
		const child = spawn(this.program.command, [this.program.bundlePath, subcommand], {
			env: environment,
			cwd: this.program.cwd,
			stdio: ["ignore", "inherit", "inherit"],
			detached: true,
		});
		const pid = child.pid;
		const exited = new Promise<ChildExit>((resolve) => {
			child.once("error", () => resolve({ code: 70, signal: null }));
			child.once("close", (code, signal) => resolve({ code, signal }));
		});
		return {
			pid: pid ?? -1,
			kill(signal) {
				if (pid === undefined) return;
				try {
					process.kill(-pid, signal);
				} catch {
					try {
						child.kill(signal);
					} catch {
						return;
					}
				}
			},
			exited,
		};
	}
}
