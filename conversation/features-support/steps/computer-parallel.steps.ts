import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { computerScenarioOf, hostNamed, journalNow, workTurn } from "../computer-scenario.ts";
import { actionStoreOf } from "../computer-support.ts";
import { modelScenarioOf } from "../executor-harness.ts";
import { activeTurnOf } from "../turn-grant-support.ts";
import type { ChatticusWorld } from "../world.ts";

Given(
	"the model is scripted to read these workspace files in one message and then answer {string}:",
	function (this: ChatticusWorld, answer: string, table: { raw(): string[][] }) {
		const calls = table.raw().map(([path]) => ({ name: "read_workspace", args: { path: path! } }));
		modelScenarioOf(this).scripted.toolCalls(calls, "Reading all of them at once.").reply(answer);
	},
);

When(
	"host worker {string} answers every computer action, then bot {string} works its turn",
	async function (this: ChatticusWorld, workerId: string, botName: string) {
		const host = hostNamed(this, workerId);
		let answered = 0;
		while ((await host.runNextAction()) !== null) answered += 1;
		assert.ok(answered > 0, "The turn parked and the host found no action to answer.");
		await workTurn(this, botName);
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
