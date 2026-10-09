import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { LIFECYCLE_TENANT, hostExecutorFor, lifecycleOf, runHostUntilIdle, tamperPendingAction } from "../host-lifecycle-support.ts";
import { modelScenarioOf } from "../executor-harness.ts";
import { runQueuedJobs } from "../turn-recovery.ts";
import { activeTurnOf } from "../turn-grant-support.ts";
import type { ChatticusWorld } from "../world.ts";
import { parkToolCall } from "./host-executors.steps.ts";
import { readChannelMessages, readTurnEvents } from "./model.steps.ts";

const DEFAULT_HOST_WORKER_ID = "garage-mac-1";
const PARKED_TERMINAL_CWD = "/workspace/research";
const DECOY_PATH = "/workspace/research/decoy.txt";
const CANNOT_RUN_SHELL = "I can't run shell commands directly in the household workspace.";


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

Given(
	"a fenced workspace edit handoff with a tampered queued continuation job for {string} replacing {string} with {string}",
	async function (this: ChatticusWorld, path: string, oldText: string, newText: string) {
		await parkToolCall(this, `edit workspace file ${DECOY_PATH} replacing ${oldText} with ${newText}`);
		await tamperPendingAction(this, { path });
	},
);

Given(
	"a fenced run_terminal handoff with a tampered queued continuation job for command {string} using cwd {string}",
	async function (this: ChatticusWorld, command: string, cwd: string) {
		await parkToolCall(this, `run command ${command} using cwd ${PARKED_TERMINAL_CWD}`);
		await tamperPendingAction(this, { command, cwd });
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
	const requests = modelScenarioOf(this).scripted.requests;
	assert.ok(requests.length >= 2, "The model was not given the command result to answer from.");
	const answeredFrom = requests.at(-1)!;
	assert.ok(answeredFrom.includes("host-marker"), "The model's last request does not carry the host's command output.");
	assert.ok(!answeredFrom.includes(CANNOT_RUN_SHELL), "The model was told it cannot run shell commands.");
	const last = bodies.at(-1)!;
	assert.notEqual(last, CANNOT_RUN_SHELL);
	assert.ok(!last.includes(CANNOT_RUN_SHELL) || last.includes("host-marker"), last);
});
