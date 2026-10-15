import { describe, expect, it } from "vitest";
import {
	realUserIdOfStatus,
	ShellUserProcessSweeper,
	UNPRIVILEGED_SHELL_USER_ID,
	type ProcessTable,
	type TableProcess,
} from "../../computer/host/src/unprivileged-process-sweeper.ts";

describe("realUserIdOfStatus", () => {
	it("reads the real user id, the first number of the Uid line", () => {
		expect(realUserIdOfStatus("Name:\tsleep\nUmask:\t0022\nUid:\t2000\t2001\t2000\t2000\nGid:\t2000\t2000\t2000\t2000\n")).toBe(2000);
		expect(realUserIdOfStatus("Uid:\t0\t0\t0\t0\n")).toBe(0);
	});

	it("answers null for a status without a readable Uid line", () => {
		expect(realUserIdOfStatus("Name:\tinit\n")).toBeNull();
		expect(realUserIdOfStatus("Uid:\tnobody\n")).toBeNull();
	});
});

describe("ShellUserProcessSweeper", () => {
	const tableOf = (processes: TableProcess[]): ProcessTable & { readonly killed: number[] } => {
		const killed: number[] = [];
		return {
			killed,
			async list() {
				return processes;
			},
			kill(pid) {
				killed.push(pid);
			},
		};
	};

	it("kills every process of the unprivileged shell user and no other", async () => {
		const table = tableOf([
			{ pid: 1, uid: 0 },
			{ pid: 7, uid: UNPRIVILEGED_SHELL_USER_ID },
			{ pid: 9, uid: 1000 },
			{ pid: 12, uid: UNPRIVILEGED_SHELL_USER_ID },
		]);
		expect(await new ShellUserProcessSweeper(table).sweep()).toBe(2);
		expect(table.killed).toEqual([7, 12]);
	});

	it("kills nothing when the shell user runs nothing", async () => {
		const table = tableOf([{ pid: 1, uid: 0 }]);
		expect(await new ShellUserProcessSweeper(table).sweep()).toBe(0);
		expect(table.killed).toEqual([]);
	});

	it("uses the uid the image gives the shell user", () => {
		expect(UNPRIVILEGED_SHELL_USER_ID).toBe(2000);
	});
});
