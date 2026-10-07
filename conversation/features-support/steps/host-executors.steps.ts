import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { HOST_USER_HEADER, hostComputerSchema } from "@chatticus/host-protocol";
import { HostActionExecutor } from "../../../computer/host/src/host-action-executor.ts";
import { WorkspaceActionExecutor } from "../../../computer/host/src/executors/workspace.ts";
import { FilesystemSnapshotStore } from "../../src/snapshot/store.ts";
import { parseGrantTable } from "../../src/policy/capability-policy.ts";
import { type RecordedResponse, recordResponse } from "../api.ts";
import { kernelPolicyFor } from "../policy-control.ts";
import { runBotTurn } from "../executor-harness.ts";
import { activeTurnOf } from "../turn-grant-support.ts";
import { runQueuedJobs } from "../turn-recovery.ts";
import { bootDriverFor, hostDiskOf, runHostUntilIdle } from "../host-lifecycle-support.ts";
import type { ChatticusWorld } from "../world.ts";
import { askBot } from "./model-tool-loop-sinks.steps.ts";
import { CountingSnapshotStore } from "./snapshot.steps.ts";
import { readTurnEvents } from "./model.steps.ts";

const SCENARIO_HOST_WORKER_ID = "garage-mac-1";
const SCENARIO_HOST_USER_ID = "ryan";
const SCENARIO_BOT_NAME = "Researcher";
const BLOCKED_PREFIX = "Tool call blocked:";
const HOST_DENIAL_MARKER = "denied:";

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
	await runHostUntilIdle(world, SCENARIO_HOST_WORKER_ID, executor);
	assert.equal((await runQueuedJobs(world)).at(-1), "done");
}

function workspaceHostExecutor(world: ChatticusWorld): HostActionExecutor {
	return new HostActionExecutor({ workspaceExecutor: new WorkspaceActionExecutor({ disk: hostDiskOf(world, SCENARIO_HOST_WORKER_ID) }) });
}

export async function parkToolCall(world: ChatticusWorld, request: string): Promise<void> {
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
	this.snapshotStore = new CountingSnapshotStore(new FilesystemSnapshotStore(join(this.snapshotTmpdir, "store")));
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

Given(
	"a fenced workspace edit handoff with a queued continuation job for {string} replacing {string} with {string}",
	async function (this: ChatticusWorld, path: string, oldText: string, newText: string) {
		await parkToolCall(this, `edit workspace file ${path} replacing ${oldText} with ${newText}`);
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
	hostDiskOf(this, SCENARIO_HOST_WORKER_ID);
	await bootDriverFor(this, SCENARIO_HOST_WORKER_ID, null).bootThroughWorkspace();
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

async function assertSuccessfulRead(world: ChatticusWorld, content: string): Promise<void> {
	const body = await lastResultOf(world, "read_workspace");
	assert.ok(!body.startsWith(BLOCKED_PREFIX) && !body.includes(HOST_DENIAL_MARKER), `The read_workspace result is a denial: ${body}`);
	assert.ok(body.includes(content), `The read_workspace result is ${JSON.stringify(body)}`);
}

Then(
	"the turn journal records a successful read_workspace tool result with content {string}",
	async function (this: ChatticusWorld, content: string) {
		await assertSuccessfulRead(this, content);
	},
);

Then(
	"the active turn journal records a successful read_workspace tool result with content {string}",
	async function (this: ChatticusWorld, content: string) {
		await assertSuccessfulRead(this, content);
	},
);

Then("the turn journal records a successful write_workspace tool result", async function (this: ChatticusWorld) {
	const body = await lastResultOf(this, "write_workspace");
	assert.ok(body.startsWith("write_workspace:"), `The write_workspace result is ${JSON.stringify(body)}`);
});

Then("the turn journal records a successful edit_workspace tool result", async function (this: ChatticusWorld) {
	const body = await lastResultOf(this, "edit_workspace");
	assert.ok(body.startsWith("edit_workspace:"), `The edit_workspace result is ${JSON.stringify(body)}`);
});

Then(
	"the turn journal records an edit_workspace tool result containing {string}",
	async function (this: ChatticusWorld, snippet: string) {
		const body = await lastResultOf(this, "edit_workspace");
		assert.ok(body.includes(snippet), `The edit_workspace result is ${JSON.stringify(body)}`);
	},
);

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
