import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import {
	computerScenarioOf,
	journalNow,
	recoverHandoff,
	registerHost,
	startStoryTurn,
	STORY_BOT,
	STORY_TENANT,
	workTurn,
} from "../computer-scenario.ts";
import { actionStoreOf } from "../computer-support.ts";
import { modelScenarioOf } from "../executor-harness.ts";
import { SimulatedCrash, type CrashWindow, type TurnBoundary } from "../../src/turn/fault-plan.ts";
import { activeTurnOf } from "../turn-grant-support.ts";
import { runQueuedJobs, turnNow } from "../turn-recovery.ts";
import type { ChatticusWorld } from "../world.ts";

const HOST_IDS = ["host-a", "host-b"] as const;
const WRITE_PATH = "/workspace/notes.md";

/**
 * Where a handoff boundary of the scenarios falls in the build: the tool call is committed by Pi when the model's turn
 * starts, the action is the work the computer is asked to do, and the owner lets go of the turn when it parks.
 */
const CRASH_BEFORE_ACTION: { boundary: TurnBoundary; window: CrashWindow } = { boundary: "computer_action", window: "before" };
const BOUNDARIES: Record<string, { boundary: TurnBoundary; window: CrashWindow } | "host_lost_after_run" | "host_lost_after_lease"> = {
	"before the tool call is committed": { boundary: "model_acceptance", window: "before" },
	"after the tool call is committed but before enqueue": CRASH_BEFORE_ACTION,
	"after enqueue but before relinquishing ownership": { boundary: "computer_park", window: "before" },
	"after the computer action but before its result is committed": "host_lost_after_run",
	"after the computer lease expired before reclamation": "host_lost_after_lease",
};

Given("a computerless turn is ready to request a computer tool", async function (this: ChatticusWorld) {
	modelScenarioOf(this)
		.scripted.toolCall("write_workspace", { path: WRITE_PATH, content: "draft" }, "Saving the notes.")
		.reply("Notes saved.");
	await startStoryTurn(this, "save the notes");
});

async function stopWorkerAt(world: ChatticusWorld, boundaryText: string): Promise<void> {
	const boundary = BOUNDARIES[boundaryText.trim()];
	assert.ok(boundary !== undefined, `Unknown handoff boundary ${boundaryText}`);
	if (typeof boundary === "object") {
		world.faultPlan.arm(boundary.boundary, boundary.window);
		await assert.rejects(runQueuedJobs(world), SimulatedCrash);
		assert.deepEqual(world.faultPlan.crashedAt, boundary, "The crash did not happen where it was armed");
	} else {
		assert.equal(await workTurn(world, STORY_BOT), "parked");
		const host = await registerHost(world, STORY_TENANT, HOST_IDS[0], "local");
		const action = await host.claim();
		assert.ok(action, "The host found no computer action to claim.");
		if (boundary === "host_lost_after_run") host.execute(action);
	}
	await recoverHandoff(world, HOST_IDS);
}

When("its worker stops {}", async function (this: ChatticusWorld, boundary: string) {
	await stopWorkerAt(this, boundary);
});

When("the structured handoff worker stops {}", async function (this: ChatticusWorld, boundary: string) {
	await stopWorkerAt(this, boundary);
});

When(
	"the computerless attempt records a model request and finishes the fenced handoff",
	async function (this: ChatticusWorld) {
		assert.equal(await workTurn(this, STORY_BOT), "parked");
		await recoverHandoff(this, HOST_IDS);
	},
);

async function hostRunsOf(world: ChatticusWorld) {
	return [...computerScenarioOf(world).hosts.values()].flatMap((host) => host.executions);
}

Then("the pending call is either continued exactly once or the turn ends visibly", async function (this: ChatticusWorld) {
	const runs = await hostRunsOf(this);
	assert.ok(runs.length <= 1, `The computer ran the call ${runs.length} times`);
	const results = (await journalNow(this)).filter((event) => event.kind === "tool.result");
	assert.equal(results.length, 1, `The journal has ${results.length} tool results`);
	const turn = await turnNow(this);
	assert.ok(["completed", "failed"].includes(turn.status), `The turn is ${turn.status}`);
});

Then("only one attempt can control the computer", function (this: ChatticusWorld) {
	const winners = computerScenarioOf(this).claimWinners;
	assert.ok(winners.length <= 1, `Hosts ${winners} each held the action`);
});

Then("an orphaned computer claim expires", async function (this: ChatticusWorld) {
	const open = await actionStoreOf(this).listOpen(STORY_TENANT);
	assert.deepEqual(open.filter((action) => action.status === "claimed"), [], "A claim was left to expire");
	const { tenantId, turnId } = activeTurnOf(this);
	const actions = await actionStoreOf(this).listForTurn(tenantId, turnId);
	assert.ok(actions.every((action) => action.status === "done"), JSON.stringify(actions));
});

Then(
	"the turn journal has typed model.request, tool.call, tool.result, and attempt events",
	async function (this: ChatticusWorld) {
		const kinds = new Set((await journalNow(this)).map((event) => event.kind));
		for (const kind of ["model.request", "tool.call", "tool.result", "attempt.claimed", "turn.waiting", "turn.completed"]) {
			assert.ok(kinds.has(kind), `The journal has no ${kind}: ${[...kinds]}`);
		}
	},
);

Then("those events are not stored only as token chunks", async function (this: ChatticusWorld) {
	const events = await journalNow(this);
	const typed = events.filter((event) => event.kind === "tool.call" || event.kind === "tool.result");
	assert.ok(typed.length >= 2);
	assert.ok(typed.every((event) => typeof event.action_id === "string" && event.action_id !== ""));
	assert.ok(events.some((event) => event.kind !== "turn.token"));
});

Then("the executed tool action id matches the committed call", async function (this: ChatticusWorld) {
	const { tenantId, turnId } = activeTurnOf(this);
	const runs = await hostRunsOf(this);
	assert.equal(runs.length, 1);
	const action = await actionStoreOf(this).get(tenantId, runs[0]!.actionId);
	assert.equal(action?.turnId, turnId);
	const call = (await journalNow(this)).find((event) => event.kind === "tool.call");
	assert.equal(action?.callId, call?.action_id);
	assert.equal(call?.body, runs[0]!.toolName);
});

Then("no unresolved tool calls remain", async function (this: ChatticusWorld) {
	const events = await journalNow(this);
	const resolved = new Set(events.filter((event) => event.kind === "tool.result").map((event) => event.action_id));
	for (const call of events.filter((event) => event.kind === "tool.call")) {
		assert.ok(resolved.has(call.action_id), `Call ${call.action_id} has no result`);
	}
	const { tenantId, turnId } = activeTurnOf(this);
	const actions = await actionStoreOf(this).listForTurn(tenantId, turnId);
	assert.ok(actions.every((action) => action.status === "done"));
});

Then("only unresolved tool calls are executed", async function (this: ChatticusWorld) {
	const { tenantId, turnId } = activeTurnOf(this);
	const runs = await hostRunsOf(this);
	const actions = await actionStoreOf(this).listForTurn(tenantId, turnId);
	const ids = runs.map((run) => run.actionId);
	assert.equal(new Set(ids).size, ids.length, "An action ran twice");
	assert.ok(ids.every((id) => actions.some((action) => action.actionId === id)), "The host ran something that is not this turn's action");
});

Then("the computer was reclaimed by a later attempt", async function (this: ChatticusWorld) {
	const turn = await turnNow(this);
	assert.ok(turn.attempt >= 2, `The turn is on attempt ${turn.attempt}`);
	const { tenantId, turnId } = activeTurnOf(this);
	const [action] = await actionStoreOf(this).listForTurn(tenantId, turnId);
	assert.equal(action?.status, "done");
	assert.ok((await journalNow(this)).filter((event) => event.kind === "attempt.claimed").length >= 2);
});

Then("the same action id is not executed twice", async function (this: ChatticusWorld) {
	const ids = (await hostRunsOf(this)).map((run) => run.actionId);
	assert.equal(new Set(ids).size, ids.length);
	assert.ok(ids.length <= 1);
});
