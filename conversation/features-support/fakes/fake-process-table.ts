import type { ProcessTable, TableProcess } from "../../../computer/host/src/unprivileged-process-sweeper.ts";

/** A process table a scenario fills: the supervisor's own processes and whatever the model's commands left running. */
export class FakeProcessTable implements ProcessTable {
	readonly killed: Array<TableProcess & { readonly name: string }> = [];
	listings = 0;
	private readonly processes: Array<TableProcess & { readonly name: string }> = [
		{ pid: 1, uid: 0, name: "init" },
		{ pid: 2, uid: 0, name: "supervisor" },
	];

	add(name: string, uid: number): void {
		this.processes.push({ pid: 100 + this.processes.length, uid, name });
	}

	async list(): Promise<readonly TableProcess[]> {
		this.listings += 1;
		return this.processes.map(({ pid, uid }) => ({ pid, uid }));
	}

	kill(pid: number): void {
		const index = this.processes.findIndex((entry) => entry.pid === pid);
		if (index < 0) return;
		this.killed.push(...this.processes.splice(index, 1));
	}

	hasRunning(name: string): boolean {
		return this.processes.some((entry) => entry.name === name);
	}
}
