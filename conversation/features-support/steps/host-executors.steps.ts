import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { HOST_USER_HEADER, claimActionResponseSchema, hostComputerSchema } from "@chatticus/host-protocol";
import { HostActionExecutor, executeAction } from "../../../computer/host/src/host-action-executor.ts";
import { WorkspaceActionExecutor } from "../../../computer/host/src/executors/workspace.ts";
import { ComputerHostDisk } from "../../src/snapshot/host.ts";
import { FilesystemSnapshotStore } from "../../src/snapshot/store.ts";
import { parseGrantTable } from "../../src/policy/capability-policy.ts";
import { type RecordedResponse, recordResponse } from "../api.ts";
import { kernelPolicyFor } from "../policy-control.ts";
import { runBotTurn } from "../executor-harness.ts";
import { activeTurnOf } from "../turn-grant-support.ts";
import { runQueuedJobs } from "../turn-recovery.ts";
import type { ChatticusWorld } from "../world.ts";
import { askBot } from "./model-tool-loop-sinks.steps.ts";
import { readTurnEvents } from "./model.steps.ts";

const SCENARIO_HOST_WORKER_ID = "garage-mac-1";
const SCENARIO_HOST_USER_ID = "ryan";
const SCENARIO_BOT_NAME = "Researcher";
const BLOCKED_PREFIX = "Tool call blocked:";

function hostDiskOf(world: ChatticusWorld, name: string): ComputerHostDisk {
	const known = world.computerHosts[name] as ComputerHostDisk | undefined;
	if (known !== undefined) return known;
	assert.ok(world.snapshotTmpdir, "The scenario has no snapshot directory.");
	const store = (world.snapshotStore as FilesystemSnapshotStore | null) ?? new FilesystemSnapshotStore(join(world.snapshotTmpdir, "store"));
	const disk = new ComputerHostDisk(join(world.snapshotTmpdir, "hosts", name), store);
	world.computerHosts[name] = disk;
	return disk;
}

function hostTokenOf(world: ChatticusWorld, workerId: string): string {
	const worker = world.registeredWorkers.find((candidate) => candidate.workerId === workerId);
	assert.ok(worker, `No host worker ${JSON.stringify(workerId)} is registered in this scenario.`);
	return worker.token;
}

async function hostRequest(
	world: ChatticusWorld,
	method: "GET" | "POST",
	path: string,
	body?: unknown,
	extraHeaders: Record<string, string> = {},
): Promise<RecordedResponse> {
	assert.ok(world.api, "The scenario has no HTTP front door.");
	const worker = world.registeredWorkers.find((candidate) => candidate.workerId === SCENARIO_HOST_WORKER_ID);
	assert.ok(worker, "The scenario host worker is not registered.");
	const url = `/orgs/${worker.tenantId}/host${path}`;
	const headers = { Authorization: `Bearer ${hostTokenOf(world, SCENARIO_HOST_WORKER_ID)}`, ...extraHeaders };
	const response =
		method === "GET" ? await world.api.get(url, { headers }) : await world.api.post(url, { headers, body: body ?? {} });
	return recordResponse(response);
}

async function reportCapabilityReady(world: ChatticusWorld, capability: string): Promise<void> {
	const response = await hostRequest(world, "POST", "/computer/state", { capability_ready: capability }, { [HOST_USER_HEADER]: SCENARIO_HOST_USER_ID });
	assert.equal(response.status, 200, response.text);
}

async function pullAndRun(world: ChatticusWorld, executor: HostActionExecutor): Promise<void> {
	for (;;) {
		const claimed = await hostRequest(world, "POST", "/actions/claim", {});
		assert.equal(claimed.status, 200, claimed.text);
		const action = claimActionResponseSchema.parse(claimed.json).action;
		if (action === null) break;
		let answer: { result: string } | { error: string };
		try {
			answer = await executeAction(action, executor);
		} catch (error) {
			answer = { error: (error as Error).message };
		}
		const posted = await hostRequest(world, "POST", `/actions/${action.action_id}/result`, answer);
		assert.equal(posted.status, 200, posted.text);
	}
	assert.equal((await runQueuedJobs(world)).at(-1), "done");
}

function workspaceHostExecutor(world: ChatticusWorld): HostActionExecutor {
	return new HostActionExecutor({ workspaceExecutor: new WorkspaceActionExecutor({ disk: hostDiskOf(world, SCENARIO_HOST_WORKER_ID) }) });
}

async function parkToolCall(world: ChatticusWorld, request: string): Promise<void> {
	await askBot(world, SCENARIO_BOT_NAME, request);
	const outcome = await runBotTurn(world, SCENARIO_BOT_NAME);
	assert.equal(outcome, "parked", `The turn did not park on the computer: ${outcome}`);
}

type JournaledResult = { readonly call: Record<string, any>; readonly body: string };

async function resultsOf(world: ChatticusWorld, toolName: string): Promise<JournaledResult[]> {
	const { tenantId, turnId } = activeTurnOf(world);
	const events = await readTurnEvents(world, tenantId, turnId);
	const results: JournaledResult[] = [];
	for (const call of events.filter((event) => event.kind === "tool.call" && event.body === toolName)) {
		const result = events.find((event) => event.kind === "tool.result" && event.action_id === call.action_id);
		if (result !== undefined) results.push({ call, body: String(result.body) });
	}
	return results;
}

async function lastResultOf(world: ChatticusWorld, toolName: string): Promise<string> {
	const results = await resultsOf(world, toolName);
	assert.ok(results.length > 0, `The journal has no ${toolName} tool result.`);
	return results.at(-1)!.body;
}

Given("a filesystem snapshot store bound to the host worker", function (this: ChatticusWorld) {
	assert.ok(this.snapshotTmpdir, "The scenario has no snapshot directory.");
	mkdirSync(this.snapshotTmpdir, { recursive: true });
	this.snapshotStore = new FilesystemSnapshotStore(join(this.snapshotTmpdir, "store"));
	this.computerHosts = {};
});

Given(
	"the scenario host {string} seeds workspace file {string} containing {string}",
	function (this: ChatticusWorld, name: string, path: string, content: string) {
		hostDiskOf(this, name).writeWorkspaceFile(path, content);
	},
);

Given(
	"a fenced workspace read handoff with a queued continuation job for {string}",
	async function (this: ChatticusWorld, path: string) {
		await parkToolCall(this, `read workspace file ${path}`);
	},
);

Given(
	"a fenced workspace write handoff with a queued continuation job for {string} containing {string}",
	async function (this: ChatticusWorld, path: string, content: string) {
		await parkToolCall(this, `write workspace file ${path} containing ${content}`);
	},
);

Given("a bot with a terminal grant on the household computer", function (this: ChatticusWorld) {
	kernelPolicyFor(this).setGrant(
		parseGrantTable({
			tools: "run_terminal, read_workspace",
			origins: "",
			recipients: "",
			file_scopes: "/workspace",
			egress_classes: "",
		}),
	);
});

When(
	"a human asks the bot to run command {string} using cwd {string} in cwd {string}",
	async function (this: ChatticusWorld, command: string, cwd: string, repeatedCwd: string) {
		assert.equal(repeatedCwd, cwd, "The step names two different working directories.");
		await askBot(this, SCENARIO_BOT_NAME, `run command ${command} using cwd ${cwd}`);
	},
);

Given(
	"a fenced run_terminal handoff with a queued continuation job for command {string} using cwd {string}",
	async function (this: ChatticusWorld, command: string, cwd: string) {
		await parkToolCall(this, `run command ${command} using cwd ${cwd}`);
	},
);

When("the computer host has booted through the workspace gate", async function (this: ChatticusWorld) {
	const running = await hostRequest(this, "POST", "/computer/state", { stopped: false });
	assert.equal(running.status, 200, running.text);
	for (const capability of ["model", "workspace"]) {
		await reportCapabilityReady(this, capability);
	}
	hostDiskOf(this, SCENARIO_HOST_WORKER_ID);
});

When(
	"a computer-capable pull worker with a workspace executor pulls that continuation job",
	async function (this: ChatticusWorld) {
		await pullAndRun(this, workspaceHostExecutor(this));
	},
);

When(
	"a computer-capable pull worker with a terminal executor pulls that continuation job",
	async function (this: ChatticusWorld) {
		await pullAndRun(this, new HostActionExecutor({ liveRoot: hostDiskOf(this, SCENARIO_HOST_WORKER_ID).liveRoot }));
	},
);

Then(
	"the turn journal records a successful read_workspace tool result with content {string}",
	async function (this: ChatticusWorld, content: string) {
		const body = await lastResultOf(this, "read_workspace");
		assert.ok(!body.startsWith(BLOCKED_PREFIX), `The read_workspace result is a denial: ${body}`);
		assert.ok(body.includes(content), `The read_workspace result is ${JSON.stringify(body)}`);
	},
);

Then("the turn journal records a successful write_workspace tool result", async function (this: ChatticusWorld) {
	const body = await lastResultOf(this, "write_workspace");
	assert.ok(body.startsWith("write_workspace:"), `The write_workspace result is ${JSON.stringify(body)}`);
});

Then(
	"the turn journal records a read_workspace tool result containing {string}",
	async function (this: ChatticusWorld, snippet: string) {
		const body = await lastResultOf(this, "read_workspace");
		assert.ok(body.includes(snippet), `The read_workspace result is ${JSON.stringify(body)}`);
	},
);

Then(
	"the turn journal records a successful run_terminal tool result containing {string}",
	async function (this: ChatticusWorld, snippet: string) {
		const body = await lastResultOf(this, "run_terminal");
		assert.ok(body.startsWith("run_terminal:"), `The run_terminal result is ${JSON.stringify(body)}`);
		assert.ok(body.includes(snippet), `The run_terminal result is ${JSON.stringify(body)}`);
	},
);

Then(
	"the turn journal records a run_terminal tool result containing {string}",
	async function (this: ChatticusWorld, snippet: string) {
		const body = await lastResultOf(this, "run_terminal");
		assert.ok(body.includes(snippet), `The run_terminal result is ${JSON.stringify(body)}`);
	},
);

Then("browser readiness is not recorded until the browser gate clears", async function (this: ChatticusWorld) {
	const before = await hostRequest(this, "GET", "/computer");
	assert.equal(before.status, 200, before.text);
	assert.equal(hostComputerSchema.parse(before.json).browser_ready, false);
	await reportCapabilityReady(this, "browser");
	const after = await hostRequest(this, "GET", "/computer");
	assert.equal(after.status, 200, after.text);
	assert.equal(hostComputerSchema.parse(after.json).browser_ready, true);
});
