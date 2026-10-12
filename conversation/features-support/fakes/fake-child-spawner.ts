import type { ChildExit, ChildSpawner, OwnerChildSubcommand, SpawnedChild } from "../../../computer/host/src/supervisor-ports.ts";

/** One child the fake spawner started: it exits when a scenario says so, or when it is killed. */
export class FakeChild implements SpawnedChild {
	readonly pid: number;
	readonly subcommand: OwnerChildSubcommand;
	readonly environment: Readonly<Record<string, string>>;
	readonly signalsReceived: Array<"SIGTERM" | "SIGKILL"> = [];
	readonly exited: Promise<ChildExit>;
	ignoresTerminate = false;
	hasExited = false;

	private finish: (exit: ChildExit) => void = () => undefined;

	constructor(pid: number, subcommand: OwnerChildSubcommand, environment: Record<string, string>) {
		this.pid = pid;
		this.subcommand = subcommand;
		this.environment = environment;
		this.exited = new Promise<ChildExit>((resolve) => {
			this.finish = resolve;
		});
	}

	kill(signal: "SIGTERM" | "SIGKILL"): void {
		this.signalsReceived.push(signal);
		if (signal === "SIGKILL") this.exit({ code: null, signal: "SIGKILL" });
		else if (!this.ignoresTerminate) this.exit({ code: null, signal: "SIGTERM" });
	}

	/** End the child with the given exit code, as the program would. */
	exitWithCode(code: number): void {
		this.exit({ code, signal: null });
	}

	private exit(exit: ChildExit): void {
		if (this.hasExited) return;
		this.hasExited = true;
		this.finish(exit);
	}
}

/** Starts fake children and remembers each with the environment it was given. */
export class FakeChildSpawner implements ChildSpawner {
	readonly children: FakeChild[] = [];
	ignoreTerminateFromNowOn = false;
	private nextPid = 4000;

	spawn(subcommand: OwnerChildSubcommand, environment: Record<string, string>): SpawnedChild {
		const child = new FakeChild(this.nextPid++, subcommand, { ...environment });
		child.ignoresTerminate = this.ignoreTerminateFromNowOn;
		this.children.push(child);
		return child;
	}

	get lastChild(): FakeChild {
		const child = this.children.at(-1);
		if (child === undefined) throw new Error("No child was started.");
		return child;
	}
}
