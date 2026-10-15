import { describe, expect, it } from "vitest";
import type { LiveFileOutcome, OwnerFileRequest } from "@chatticus/host-protocol/live-files";
import { ProcessFileHelperLauncher, type FileHelperLauncher, type FileHelperRequest, type FileHelperResponse } from "../../computer/host/src/live-file-helper-launcher.ts";
import { helperRequestOf, LiveFileOperations, outcomeFromHelperResponse, realPathOfLivePath } from "../../computer/host/src/live-file-operations.ts";
import type { SupervisorClock } from "../../computer/host/src/supervisor-ports.ts";

const WORKSPACE = "/real/workspace";
const SHA = "a".repeat(64);

const readRequest = (id: string, expiresInMilliseconds: number = 8000): OwnerFileRequest => ({
	kind: "read",
	operation_id: id,
	path: `/workspace/${id}.txt`,
	expires_in_ms: expiresInMilliseconds,
	offset: 0,
	length: 100,
	mask: true,
});

const OK_READ: FileHelperResponse = {
	ok: true,
	resolvedPath: "/workspace/x.txt",
	size: 1,
	sha256: SHA,
	mode: "644",
	modifiedMs: 1_700_000_000_000,
	encoding: "utf8",
	binary: false,
	offset: 0,
	length: 1,
	content: "x",
	truncated: false,
	masked: false,
};

class ManualClock implements SupervisorClock {
	now = 0;
	nowMilliseconds(): number {
		return this.now;
	}
	async sleep(): Promise<void> {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

class GatedLauncher implements FileHelperLauncher {
	readonly started: string[] = [];
	private readonly gates = new Map<string, (response: FileHelperResponse) => void>();
	run(request: FileHelperRequest): Promise<FileHelperResponse> {
		this.started.push(request.path);
		return new Promise((resolve) => this.gates.set(request.path, resolve));
	}
	release(name: string, response: FileHelperResponse = OK_READ): void {
		this.gates.get(`${WORKSPACE}/${name}.txt`)!("ok" in response ? response : OK_READ);
		this.gates.delete(`${WORKSPACE}/${name}.txt`);
	}
}

const settle = async (): Promise<void> => {
	for (let turn = 0; turn < 5; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

function build(overrides: { memory?: number | undefined; postFailures?: number } = {}) {
	const clock = new ManualClock();
	const launcher = new GatedLauncher();
	const posted: Array<{ id: string; outcome: LiveFileOutcome }> = [];
	const logs: string[] = [];
	let postFailures = overrides.postFailures ?? 0;
	const operations = new LiveFileOperations({
		launcher,
		clock,
		log: (event, fields) => logs.push(`${event} ${JSON.stringify(fields ?? {})}`),
		workspaceRoot: WORKSPACE,
		memoryUsedPercent: () => overrides.memory,
		onFinished: () => undefined,
		postResult: async (id, outcome) => {
			if (postFailures > 0) {
				postFailures -= 1;
				throw Object.assign(new Error("down"), { status: 503 });
			}
			posted.push({ id, outcome });
			return "recorded";
		},
	});
	return { clock, launcher, posted, logs, operations };
}

describe("the file runner's queue", () => {
	it("runs two helpers at a time and queues the rest, in order", async () => {
		const { launcher, operations } = build();
		operations.accept([readRequest("a"), readRequest("b"), readRequest("c")]);
		await settle();
		expect(launcher.started).toEqual([`${WORKSPACE}/a.txt`, `${WORKSPACE}/b.txt`]);
		launcher.release("a");
		await settle();
		expect(launcher.started).toHaveLength(3);
	});

	it("answers owner_busy when more than eight wait and when the container is short of memory", async () => {
		const full = build();
		full.operations.accept(Array.from({ length: 4 }, (_, index) => readRequest(`q${index}`)));
		full.operations.accept(Array.from({ length: 4 }, (_, index) => readRequest(`r${index}`)));
		full.operations.accept(Array.from({ length: 4 }, (_, index) => readRequest(`s${index}`)));
		full.operations.accept([readRequest("overflow")]);
		await settle();
		const overflow = full.posted.find((entry) => entry.id === "overflow");
		expect(overflow?.outcome).toMatchObject({ status: "error", code: "owner_busy" });
		const short = build({ memory: 90 });
		short.operations.accept([readRequest("m")]);
		await settle();
		expect(short.posted[0]?.outcome).toMatchObject({ status: "error", code: "owner_busy" });
		expect(short.launcher.started).toEqual([]);
	});

	it("ignores a request id it already knows, but posts again a finished answer whose post failed", async () => {
		const { launcher, operations, posted, clock } = build({ postFailures: 3 });
		operations.accept([readRequest("a")]);
		await settle();
		launcher.release("a");
		await settle();
		expect(posted).toEqual([]);
		operations.accept([readRequest("a")]);
		await settle();
		expect(posted).toHaveLength(1);
		operations.accept([readRequest("a")]);
		await settle();
		expect(posted).toHaveLength(1);
		expect(launcher.started).toHaveLength(1);
		clock.now += 61_000;
		operations.accept([readRequest("a")]);
		await settle();
		expect(launcher.started).toHaveLength(2);
	});

	it("answers expired, without starting a helper, when a request waited past its time", async () => {
		const { launcher, operations, posted, clock } = build();
		operations.accept([readRequest("a"), readRequest("b"), readRequest("late", 1000)]);
		await settle();
		clock.now += 2000;
		launcher.release("a");
		await settle();
		expect(posted.find((entry) => entry.id === "late")?.outcome).toMatchObject({ status: "error", code: "expired" });
		expect(launcher.started).not.toContain(`${WORKSPACE}/late.txt`);
	});

	it("holds the queue while paused and waits for the helpers that run", async () => {
		const { launcher, operations } = build();
		operations.accept([readRequest("a")]);
		await settle();
		let paused = false;
		const pausing = operations.pause().then(() => {
			paused = true;
		});
		await settle();
		expect(paused).toBe(false);
		operations.accept([readRequest("b")]);
		await settle();
		expect(launcher.started).toHaveLength(1);
		launcher.release("a");
		await pausing;
		expect(launcher.started).toHaveLength(1);
		operations.resume();
		await settle();
		expect(launcher.started).toHaveLength(2);
	});

	it("turns a helper answer that does not match the protocol into helper_failed", () => {
		const outcome = outcomeFromHelperResponse(readRequest("a"), { ok: true, resolvedPath: "/workspace/a.txt", size: 1 });
		expect(outcome).toMatchObject({ status: "error", code: "helper_failed" });
		expect(outcomeFromHelperResponse(readRequest("a"), { ok: false, code: "EWEIRD", message: "m" })).toMatchObject({ status: "error", code: "io_error" });
	});
});

describe("the request mapping", () => {
	it("maps a logical path under the real workspace without touching the disk", () => {
		expect(realPathOfLivePath(WORKSPACE, "/workspace")).toBe(WORKSPACE);
		expect(realPathOfLivePath(WORKSPACE, "/workspace/a/./b")).toBe(`${WORKSPACE}/a/b`);
	});

	it("refuses .git and bounds every request, and maps delete and move to the helper operations", () => {
		const base = { operation_id: "x", expires_in_ms: 1000 };
		expect(helperRequestOf({ ...base, kind: "delete", path: "/workspace/t", recursive: true, precondition: { type: "if_match", sha256: SHA } }, WORKSPACE)).toMatchObject({
			operation: "rmtree",
			sha256: SHA,
			refuseGitSegments: true,
			allowedRoots: [WORKSPACE],
		});
		expect(helperRequestOf({ ...base, kind: "delete", path: "/workspace/f", recursive: false, precondition: { type: "if_match", sha256: SHA } }, WORKSPACE)).toMatchObject({ operation: "unlink", sha256: SHA });
		expect(helperRequestOf({ ...base, kind: "move", path: "/workspace/a", to: "/workspace/b", precondition: { type: "if_match", sha256: SHA } }, WORKSPACE)).toMatchObject({
			operation: "rename",
			to: `${WORKSPACE}/b`,
		});
		expect(helperRequestOf(readRequest("r"), WORKSPACE)).toMatchObject({ range: { maxFileBytes: 8388608, mask: true } });
	});
});

describe("the process launcher", () => {
	const launcher = (command: string[], limit?: number) =>
		new ProcessFileHelperLauncher({
			launcherPath: "/bin/sh",
			helperCommand: command,
			workingDirectory: "/",
			environment: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
			...(limit === undefined ? {} : { standardOutputLimitBytes: limit }),
		});
	const request: FileHelperRequest = { operation: "stat", path: "/", allowedRoots: ["/"] };

	it("kills a helper that does not answer and says helper_timeout", async () => {
		const started = Date.now();
		const response = await launcher(["sleep", "30"]).run(request, 300);
		expect(response).toMatchObject({ ok: false, code: "helper_timeout" });
		expect(Date.now() - started).toBeLessThan(3000);
	});

	it("says helper_failed for an answer that is not JSON and for an answer over the output limit", async () => {
		expect(await launcher(["echo", "not json"]).run(request, 3000)).toMatchObject({ ok: false, code: "helper_failed" });
		expect(await launcher(["yes"], 1000).run(request, 3000)).toMatchObject({ ok: false, code: "helper_failed" });
	});

	it("reads a JSON answer from the helper's standard output", async () => {
		expect(await launcher(["echo", '{"ok":true}']).run(request, 3000)).toEqual({ ok: true });
	});
});
