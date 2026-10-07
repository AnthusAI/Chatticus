import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { computerScenarioOf, hostNamed, journalNow, workTurn } from "../computer-scenario.ts";
import { actionStoreOf } from "../computer-support.ts";
import { modelScenarioOf } from "../executor-harness.ts";
import { activeTurnOf } from "../turn-grant-support.ts";
import type { ChatticusWorld } from "../world.ts";

const MAXIMUM_ROUNDS = 12;

Given(
	"the model is scripted to read these workspace files in one message and then answer {string}:",
	function (this: ChatticusWorld, answer: string, table: { raw(): string[][] }) {
		const calls = table.raw().map(([path]) => ({ name: "read_workspace", args: { path: path! } }));
		modelScenarioOf(this).scripted.toolCalls(calls, "Reading all of them at once.").reply(answer);
	},
);

When(
	"bot {string} works its turn while host worker {string} answers every computer action until the turn ends",
	async function (this: ChatticusWorld, botName: string, workerId: string) {
		const host = hostNamed(this, workerId);
		for (let round = 0; round < MAXIMUM_ROUNDS; round += 1) {
			if ((await workTurn(this, botName)) !== "parked") return;
			let answered = 0;
			while ((await host.runNextAction()) !== null) answered += 1;
			assert.ok(answered > 0, "The turn parked and the host found no action to answer.");
		}
		assert.fail(`The turn was still parked after ${MAXIMUM_ROUNDS} rounds.`);
	},
);

Then("the host executed {string} {int} times", function (this: ChatticusWorld, toolName: string, count: number) {
	const runs = [...computerScenarioOf(this).hosts.values()].flatMap((host) =>
		host.executions.filter((execution) => execution.toolName === toolName),
	);
	assert.equal(runs.length, count, `The host ran ${toolName} ${runs.length} times`);
});

Then("the turn has {int} computer actions and all are done", async function (this: ChatticusWorld, count: number) {
	const { tenantId, turnId } = activeTurnOf(this);
	const actions = await actionStoreOf(this).listForTurn(tenantId, turnId);
	assert.equal(actions.length, count, JSON.stringify(actions));
	assert.ok(
		actions.every((action) => action.status === "done"),
		JSON.stringify(actions),
	);
});

Then("the last request to the model contains {string}", function (this: ChatticusWorld, text: string) {
	const requests = modelScenarioOf(this).scripted.requests;
	assert.ok(requests[requests.length - 1]!.includes(text), `The last request did not contain ${JSON.stringify(text)}`);
});

Then("the turn journal records a tool result containing {string}", async function (this: ChatticusWorld, text: string) {
	const results = (await journalNow(this)).filter((event) => event.kind === "tool.result");
	assert.ok(
		results.some((event) => String(event.body).includes(text)),
		`No tool result contains ${JSON.stringify(text)}: ${JSON.stringify(results)}`,
	);
});

Then("the turn journal records {int} tool results", async function (this: ChatticusWorld, count: number) {
	const results = (await journalNow(this)).filter((event) => event.kind === "tool.result");
	assert.equal(results.length, count, JSON.stringify(results));
});
