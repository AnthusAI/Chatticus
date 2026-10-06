import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { ensureComputer, recordHostSnapshotPublished } from "../../src/domain/computers.ts";
import { reconcileWorkerSnapshot, selectComputerStartHost } from "../../src/domain/workers.ts";
import { LIFECYCLE_TENANT, hostExecutorFor, lifecycleOf, runHostUntilIdle, tamperPendingAction } from "../host-lifecycle-support.ts";
import { runQueuedJobs } from "../turn-recovery.ts";
import { activeTurnOf } from "../turn-grant-support.ts";
import type { ChatticusWorld } from "../world.ts";
import { parkToolCall } from "./host-executors.steps.ts";
import { readChannelMessages, readTurnEvents } from "./model.steps.ts";

const DEFAULT_HOST_WORKER_ID = "garage-mac-1";
const DECOY_PATH = "/workspace/research/decoy.txt";
const REMOTE_HOST_WORKER_ID = "fargate-1";
const LOCAL_HOST_WORKER_ID = "garage-mac-1";
const CANNOT_RUN_SHELL = "I can't run shell commands directly in the household workspace.";

const selectedHosts = new WeakMap<ChatticusWorld, string | null>();

async function completeEscalatedTurn(world: ChatticusWorld): Promise<void> {
	const host = lifecycleOf(world).lastBootedHost ?? DEFAULT_HOST_WORKER_ID;
	await runHostUntilIdle(world, host, hostExecutorFor(world, host));
	assert.equal((await runQueuedJobs(world)).at(-1), "done");
}

When(
	"a computer-capable pull worker with a workspace executor completes the escalated turn",
	async function (this: ChatticusWorld) {
		await completeEscalatedTurn(this);
	},
);

When("a computer-capable pull worker with a terminal executor completes the escalated turn", async function (this: ChatticusWorld) {
	await completeEscalatedTurn(this);
});

Given(
	"a fenced workspace read handoff with a tampered queued continuation job for {string}",
	async function (this: ChatticusWorld, path: string) {
		await parkToolCall(this, `read workspace file ${DECOY_PATH}`);
		await tamperPendingAction(this, { path });
	},
);

Given(
	"a fenced workspace write handoff with a tampered queued continuation job for {string} containing {string}",
	async function (this: ChatticusWorld, path: string, content: string) {
		await parkToolCall(this, `write workspace file ${DECOY_PATH} containing ${content}`);
		await tamperPendingAction(this, { path, content });
	},
);

Then("the turn journal contains the command output from the host", async function (this: ChatticusWorld) {
	const { tenantId, turnId } = activeTurnOf(this);
	const results = (await readTurnEvents(this, tenantId, turnId))
		.filter((event) => event.kind === "tool.result" && String(event.body).startsWith("run_terminal:exit="))
		.map((event) => String(event.body));
	assert.ok(results.length > 0, "The journal has no run_terminal result from the host.");
	assert.ok(results.at(-1)!.includes("host-marker"), results.at(-1));
});

Then("the bot does not only reply that it cannot run shell commands", async function (this: ChatticusWorld) {
	const bodies = (await readChannelMessages(this))
		.filter((message) => message.author_kind === "bot" && message.body)
		.map((message) => String(message.body).trim());
	assert.ok(bodies.length > 0, "The bot has not replied.");
	const last = bodies.at(-1)!;
	assert.notEqual(last, CANNOT_RUN_SHELL);
	assert.ok(!last.includes(CANNOT_RUN_SHELL) || last.includes("host-marker"), last);
});

Given("the household computer {string} is stopped", async function (this: ChatticusWorld, computerId: string) {
	const store = this.messagingStore();
	const computer = await ensureComputer(LIFECYCLE_TENANT, { store, ids: this.ids }, computerId);
	await store.putComputer({ ...computer, stopped: true });
});

Given("the local host last reconciled snapshot generation {int}", async function (this: ChatticusWorld, generation: number) {
	await reconcileWorkerSnapshot(LIFECYCLE_TENANT, LOCAL_HOST_WORKER_ID, generation, { store: this.messagingStore() });
});

Given("a newer snapshot generation {int} is published on the remote host", async function (this: ChatticusWorld, generation: number) {
	const store = this.messagingStore();
	for (;;) {
		const computer = await ensureComputer(LIFECYCLE_TENANT, { store, ids: this.ids });
		if (computer.snapshotGeneration >= generation) return;
		await recordHostSnapshotPublished(LIFECYCLE_TENANT, REMOTE_HOST_WORKER_ID, `snapshot-${computer.snapshotGeneration + 1}`, null, { store });
	}
});

When("the platform selects a host to start the computer", async function (this: ChatticusWorld) {
	selectedHosts.set(
		this,
		await selectComputerStartHost(LIFECYCLE_TENANT, {
			store: this.messagingStore(),
			clock: this.clock,
			ids: this.ids,
			heartbeatTimeoutSeconds: this.heartbeatTimeoutSeconds,
		}),
	);
});

When("the local host reconciles to snapshot generation {int}", async function (this: ChatticusWorld, generation: number) {
	await reconcileWorkerSnapshot(LIFECYCLE_TENANT, LOCAL_HOST_WORKER_ID, generation, { store: this.messagingStore() });
});

Then("the selected host is {string}", function (this: ChatticusWorld, workerId: string) {
	assert.equal(selectedHosts.get(this), workerId);
});
