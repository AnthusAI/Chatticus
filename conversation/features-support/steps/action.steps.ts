import assert from "node:assert/strict";
import { Then } from "@cucumber/cucumber";
import { actionStoreOf } from "../computer-support.ts";
import { journalNow, scenarioTenantId, turnPayloadNow } from "../computer-scenario.ts";
import { modelScenarioOf } from "../executor-harness.ts";
import { activeTurnOf } from "../turn-grant-support.ts";
import { turnNow } from "../turn-recovery.ts";
import type { ChatticusWorld } from "../world.ts";

Then("the turn names the pending computer tool {string}", async function (this: ChatticusWorld, toolName: string) {
	const turn = await turnPayloadNow(this);
	assert.ok(turn.pending_computer_tool, "The turn names no pending computer tool.");
	assert.equal(turn.pending_computer_tool.tool_name, toolName);
	const actions = await actionStoreOf(this).listForTurn(...Object.values(activeTurnOf(this)) as [string, string]);
	assert.equal(turn.pending_computer_tool.action_id, actions.find((action) => action.toolName === toolName)?.actionId);
});

Then("the computer has one open action for {string}", async function (this: ChatticusWorld, toolName: string) {
	const open = await actionStoreOf(this).listOpen(scenarioTenantId(this));
	assert.equal(open.length, 1, JSON.stringify(open));
	assert.equal(open[0]!.toolName, toolName);
	assert.equal(open[0]!.status, "requested");
});

Then("no turn owner holds the turn", async function (this: ChatticusWorld) {
	const turn = await turnNow(this);
	assert.equal(turn.attemptId, null);
	assert.equal(turn.claimedBy, null);
	assert.equal(turn.leaseExpiresAt, null);
	assert.equal(turn.status, "active");
});

Then("the turn journal shows the tool call before the waiting event", async function (this: ChatticusWorld) {
	const events = await journalNow(this);
	const call = events.findIndex((event) => event.kind === "tool.call");
	const waiting = events.findIndex((event) => event.kind === "turn.waiting");
	assert.ok(call >= 0, "The journal has no tool.call");
	assert.ok(waiting > call, `turn.waiting (${waiting}) does not follow tool.call (${call})`);
	assert.equal(events.filter((event) => event.kind === "tool.call").length, 1);
	const pending = events[waiting]!.pending_computer_tool;
	assert.ok(pending, "turn.waiting names no pending computer tool");
	const actions = await actionStoreOf(this).listForTurn(...Object.values(activeTurnOf(this)) as [string, string]);
	assert.equal(actions[0]!.callId, events[call]!.action_id, "The action is not keyed by the journaled call id");
	assert.equal(pending.action_id, actions[0]!.actionId);
});

Then("the turn is completed", async function (this: ChatticusWorld) {
	const turn = await turnPayloadNow(this);
	assert.equal(turn.status, "completed", JSON.stringify(turn));
});

Then("the turn journal records one tool result containing {string}", async function (this: ChatticusWorld, text: string) {
	const results = (await journalNow(this)).filter((event) => event.kind === "tool.result");
	assert.equal(results.length, 1, JSON.stringify(results));
	assert.ok(String(results[0]!.body).includes(text), String(results[0]!.body));
});

Then("the model saw {string} in its next request", function (this: ChatticusWorld, text: string) {
	const requests = modelScenarioOf(this).scripted.requests;
	assert.ok(requests.length >= 2, `The model was asked ${requests.length} times`);
	assert.ok(requests[requests.length - 1]!.includes(text), `The last request did not contain ${JSON.stringify(text)}`);
});

Then("the turn has one computer action and it is done", async function (this: ChatticusWorld) {
	const { tenantId, turnId } = activeTurnOf(this);
	const actions = await actionStoreOf(this).listForTurn(tenantId, turnId);
	assert.equal(actions.length, 1, JSON.stringify(actions));
	assert.equal(actions[0]!.status, "done");
});

Then("the turn has one computer action and it is not done", async function (this: ChatticusWorld) {
	const { tenantId, turnId } = activeTurnOf(this);
	const actions = await actionStoreOf(this).listForTurn(tenantId, turnId);
	assert.equal(actions.length, 1, JSON.stringify(actions));
	assert.notEqual(actions[0]!.status, "done");
});
