import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { After, Given, Then, When } from "@cucumber/cucumber";
import { getTurn } from "../../src/domain/turns.ts";
import { STORY_BOT, STORY_TENANT, startStoryTurn, workTurn } from "../computer-scenario.ts";
import { actionStoreOf } from "../computer-support.ts";
import {
	computerOwnerScenarioOf,
	restoreOwnerEnvironment,
	secretValueOf,
	startComputerOwner,
} from "../computer-owner.ts";
import { modelScenarioOf } from "../executor-harness.ts";
import { postToBot, queuedRunsFor, RECOVERY_ROUND_SECONDS } from "../turn-recovery.ts";
import { activeTurnOf, grantPayloadOfTable, memberHeadersFor, putActiveTurnGrant } from "../turn-grant-support.ts";
import { readTurnEvents } from "./model.steps.ts";
import type { ChatticusWorld } from "../world.ts";

After(function (this: ChatticusWorld) {
	restoreOwnerEnvironment(this);
});

const pathInWorkspace = (world: ChatticusWorld, name: string): string => join(computerOwnerScenarioOf(world).workspace, name);

const splitList = (text: string): string[] =>
	text
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part !== "");

Given("the computer owner has an empty workspace directory", function (this: ChatticusWorld) {
	computerOwnerScenarioOf(this);
});

Given("the model is scripted to call {string} with:", function (this: ChatticusWorld, tool: string, argumentsText: string) {
	modelScenarioOf(this).scripted.toolCall(tool, JSON.parse(argumentsText) as Record<string, unknown>, "Working on it.");
});

Given("the model is scripted to answer {string}", function (this: ChatticusWorld, text: string) {
	modelScenarioOf(this).scripted.reply(text);
});

Given(
	"the workspace has a file {string} containing {string}",
	function (this: ChatticusWorld, name: string, content: string) {
		const path = pathInWorkspace(this, name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	},
);

Given("the owner process holds the secret environment variables {string}", function (this: ChatticusWorld, names: string) {
	const scenario = computerOwnerScenarioOf(this);
	for (const name of splitList(names)) {
		scenario.savedEnvironment.set(name, process.env[name]);
		process.env[name] = secretValueOf(name);
	}
});

When("the member asks {string}", async function (this: ChatticusWorld, message: string) {
	computerOwnerScenarioOf(this).turnIds.push(await startStoryTurn(this, message));
});

When("the member sends {string} in the same channel", async function (this: ChatticusWorld, message: string) {
	this.lastTurnId = await postToBot(this, STORY_BOT, message);
	computerOwnerScenarioOf(this).turnIds.push(this.lastTurnId);
});

When("the member allows the turn tools {string} under {string}", async function (this: ChatticusWorld, tools: string, scope: string) {
	const headers = await memberHeadersFor(this, STORY_TENANT, "ryan");
	const response = await putActiveTurnGrant(
		this,
		headers,
		grantPayloadOfTable({ tools, origins: "", recipients: "", file_scopes: scope, egress_classes: "approved_origin_fetch", ingest_classes: "" }),
	);
	assert.equal(response.status, 200, response.text);
});

When("a Lambda-style owner works the turn until it parks", async function (this: ChatticusWorld) {
	const outcome = await workTurn(this, STORY_BOT);
	computerOwnerScenarioOf(this).lambdaOutcome = outcome;
	assert.equal(outcome, "parked");
});

When("a Lambda-style owner works the turn to its end", async function (this: ChatticusWorld) {
	const outcome = await workTurn(this, STORY_BOT);
	computerOwnerScenarioOf(this).lambdaOutcome = outcome;
	assert.equal(outcome, "done");
});

When("computer owner {string} takes over the turn", async function (this: ChatticusWorld, label: string) {
	await (await startComputerOwner(this, label)).ended;
});

When(
	"computer owner {string} takes over the turn and is held after its tool ran",
	async function (this: ChatticusWorld, label: string) {
		const { ended, held } = await startComputerOwner(this, label, { hold: true });
		assert.ok(held);
		const early = ended.then((outcome) => {
			throw new Error(`The owner ${label} ended ${outcome} before its tool ran.`);
		});
		await Promise.race([held.reached, early]);
	},
);

When(
	"computer owners {string} and {string} take over the turn at the same moment",
	async function (this: ChatticusWorld, left: string, right: string) {
		const owners = await Promise.all([startComputerOwner(this, left), startComputerOwner(this, right)]);
		await Promise.all(owners.map((owner) => owner.ended));
	},
);

When("computer owner {string} takes over a turn that does not exist", async function (this: ChatticusWorld, label: string) {
	const job = { ...activeTurnJobOrBot(this), turnId: "no-such-turn" };
	await (await startComputerOwner(this, label, { hold: false, job })).ended;
});

function activeTurnJobOrBot(world: ChatticusWorld): { tenantId: string; turnId: string; botId: string } {
	const bot = world.botsByName?.get(STORY_BOT);
	if (bot === undefined) return { tenantId: STORY_TENANT, turnId: "no-such-turn", botId: "no-such-bot" };
	return { tenantId: STORY_TENANT, turnId: "no-such-turn", botId: bot.botId };
}

When("held computer owner {string} is released", async function (this: ChatticusWorld, label: string) {
	const held = computerOwnerScenarioOf(this).held.get(label);
	assert.ok(held, `No computer owner ${label} is held.`);
	held.release();
	await held.ended;
});

When("the clock moves past the turn lease", function (this: ChatticusWorld) {
	this.clock.advanceSeconds(RECOVERY_ROUND_SECONDS);
});

Then("the takeover of {string} ended {string}", function (this: ChatticusWorld, label: string, outcome: string) {
	assert.equal(computerOwnerScenarioOf(this).outcomes.get(label), outcome);
});

Then(
	"exactly one of the takeovers ended {string} and the other ended {string}",
	function (this: ChatticusWorld, winning: string, losing: string) {
		const outcomes = [...computerOwnerScenarioOf(this).outcomes.values()].sort();
		assert.deepEqual(outcomes, [winning, losing].sort());
	},
);

Then("the workspace file {string} contains {string}", function (this: ChatticusWorld, name: string, content: string) {
	assert.equal(readFileSync(pathInWorkspace(this, name), "utf8"), content);
});

Then("the workspace has no file {string}", function (this: ChatticusWorld, name: string) {
	assert.equal(existsSync(pathInWorkspace(this, name)), false, `The workspace has ${name}.`);
});

Then("the workspace file {string} has exactly {int} line(s)", function (this: ChatticusWorld, name: string, count: number) {
	const lines = readFileSync(pathInWorkspace(this, name), "utf8").split("\n").filter((line) => line !== "");
	assert.equal(lines.length, count, JSON.stringify(lines));
});

async function actionsOfActiveTurn(world: ChatticusWorld) {
	const { tenantId, turnId } = activeTurnOf(world);
	return actionStoreOf(world).listForTurn(tenantId, turnId);
}

Then("the computer action was claimed by {string}", async function (this: ChatticusWorld, workerId: string) {
	const actions = await actionsOfActiveTurn(this);
	assert.equal(actions.length, 1, JSON.stringify(actions));
	assert.equal(actions[0]!.claimedBy ?? null, workerId, JSON.stringify(actions[0]));
});

Then("the computer action ended in an error containing {string}", async function (this: ChatticusWorld, text: string) {
	const actions = await actionsOfActiveTurn(this);
	assert.equal(actions.length, 1, JSON.stringify(actions));
	assert.equal(actions[0]!.status, "done");
	assert.equal(actions[0]!.resultIsError, true);
	assert.ok(String(actions[0]!.result).includes(text), String(actions[0]!.result));
});

Then("the turn has no computer action", async function (this: ChatticusWorld) {
	assert.deepEqual(await actionsOfActiveTurn(this), []);
});

Then("no run job is queued for the turn", function (this: ChatticusWorld) {
	const { turnId } = activeTurnOf(this);
	assert.deepEqual(queuedRunsFor(this, turnId), []);
});

Then("the turn took exactly {int} attempts", async function (this: ChatticusWorld, attempts: number) {
	const { tenantId, turnId } = activeTurnOf(this);
	assert.equal((await getTurn(this.turnDependencies(), tenantId, turnId)).attempt, attempts);
});

Then("the model was asked {int} time(s)", function (this: ChatticusWorld, count: number) {
	assert.equal(modelScenarioOf(this).scripted.callCount, count);
});

Then("the storage fence of the second turn is higher than that of the first turn", async function (this: ChatticusWorld) {
	const [first, second] = computerOwnerScenarioOf(this).turnIds;
	assert.ok(first !== undefined && second !== undefined, "The scenario did not run two turns.");
	const firstFence = (await getTurn(this.turnDependencies(), STORY_TENANT, first)).storageFence;
	const secondFence = (await getTurn(this.turnDependencies(), STORY_TENANT, second)).storageFence;
	assert.ok(firstFence !== null && secondFence !== null, "A turn recorded no storage fence.");
	assert.ok(secondFence > firstFence, `Fences ${firstFence} and ${secondFence}`);
});

async function toolResultsOf(world: ChatticusWorld, turnId: string): Promise<string[]> {
	return (await readTurnEvents(world, STORY_TENANT, turnId)).filter((event) => event.kind === "tool.result").map((event) => String(event.body));
}

Then("the tool results of the first and second turn are identical", async function (this: ChatticusWorld) {
	const [first, second] = computerOwnerScenarioOf(this).turnIds;
	assert.ok(first !== undefined && second !== undefined, "The scenario did not run two turns.");
	const firstResults = await toolResultsOf(this, first);
	assert.equal(firstResults.length, 1, JSON.stringify(firstResults));
	assert.deepEqual(await toolResultsOf(this, second), firstResults);
});

Then("the tool result of the second turn contains {string}", async function (this: ChatticusWorld, prefix: string) {
	const second = computerOwnerScenarioOf(this).turnIds[1];
	assert.ok(second !== undefined, "The scenario did not run two turns.");
	const [result] = await toolResultsOf(this, second);
	assert.ok(result?.includes(prefix), String(result));
});

async function diskDirtyNow(world: ChatticusWorld): Promise<boolean> {
	const computer = await world.messagingStore().getComputer(STORY_TENANT);
	assert.ok(computer, "The organization has no computer record.");
	return computer.diskDirty;
}

Then("the computer's disk is marked dirty", async function (this: ChatticusWorld) {
	assert.equal(await diskDirtyNow(this), true);
});

Then("the computer's disk is not dirty", async function (this: ChatticusWorld) {
	assert.equal(await diskDirtyNow(this), false);
});

const lastRequestOf = (world: ChatticusWorld): string => {
	const requests = modelScenarioOf(world).scripted.requests;
	assert.ok(requests.length >= 2, `The model was asked ${requests.length} times`);
	return requests[requests.length - 1]!;
};

Then("the model's next request does not contain the value of {string}", function (this: ChatticusWorld, name: string) {
	assert.ok(!lastRequestOf(this).includes(secretValueOf(name)), `The model saw the value of ${name}`);
});

Then("the model's next request does not contain the name {string}", function (this: ChatticusWorld, name: string) {
	assert.ok(!lastRequestOf(this).includes(name), `The model saw the name ${name}`);
});
