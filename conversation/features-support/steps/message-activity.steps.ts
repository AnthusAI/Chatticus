import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { STORY_TENANT } from "../computer-scenario.ts";
import { computerOwnerScenarioOf, secretValueOf, startComputerOwner } from "../computer-owner.ts";
import { modelScenarioOf } from "../executor-harness.ts";
import { readTurnEvents } from "./model.steps.ts";
import { listedMessagesOf } from "./message-listing-reads.steps.ts";
import type { ChatticusWorld } from "../world.ts";

type Listed = Record<string, any>;

const botMessageOf = (world: ChatticusWorld): Listed => {
	const bots = listedMessagesOf(world).filter((message) => message.author_kind === "bot");
	assert.equal(bots.length, 1, `Expected one listed bot message, found ${bots.length}.`);
	return bots[0]!;
};

const activityOf = (world: ChatticusWorld): Listed[] => {
	const activity = botMessageOf(world).activity;
	assert.ok(Array.isArray(activity), "The listed bot message has no activity.");
	return activity;
};

const itemOf = (world: ChatticusWorld, position: number): Listed => {
	const item = activityOf(world)[position - 1];
	assert.ok(item, `The listed bot message has no activity item ${position}.`);
	return item;
};

Given(
	"the model is scripted to write {string} with {int} characters of content",
	function (this: ChatticusWorld, path: string, length: number) {
		modelScenarioOf(this).scripted.toolCall("write_workspace", { path, content: "z".repeat(length) }, "Working on it.");
	},
);

Given("the model is scripted to call {string} {int} times in one step", function (this: ChatticusWorld, tool: string, count: number) {
	const calls = Array.from({ length: count }, (_unused, index) => ({ name: tool, args: { command: `echo call-${index + 1}`, cwd: "/workspace" } }));
	modelScenarioOf(this).scripted.toolCalls(calls, "Working on it.");
});

When("computer owner {string} takes over a long turn", { timeout: 180_000 }, async function (this: ChatticusWorld, label: string) {
	await (await startComputerOwner(this, label)).ended;
});

Then("the listed bot message reads {string}", function (this: ChatticusWorld, body: string) {
	assert.equal(botMessageOf(this).body, body);
});

Then("the listed bot message has {int} activity items", function (this: ChatticusWorld, count: number) {
	assert.equal(activityOf(this).length, count);
});

Then("the listed bot message has no activity field", function (this: ChatticusWorld) {
	assert.ok(!("activity" in botMessageOf(this)), JSON.stringify(botMessageOf(this)));
});

Then("the listed human message has no activity field", function (this: ChatticusWorld) {
	const humans = listedMessagesOf(this).filter((message) => message.author_kind === "human");
	assert.ok(humans.length > 0, "The list has no human message.");
	for (const human of humans) assert.ok(!("activity" in human), JSON.stringify(human));
});

Then(
	"activity item {int} is the tool {string} summarized {string}",
	function (this: ChatticusWorld, position: number, tool: string, summary: string) {
		const item = itemOf(this, position);
		assert.equal(item.tool, tool);
		assert.equal(item.summary, summary);
		assert.equal(typeof item.call_id, "string");
		assert.notEqual(item.call_id, "");
	},
);

Then("the arguments of activity item {int} are:", function (this: ChatticusWorld, position: number, expected: string) {
	assert.deepEqual(itemOf(this, position).arguments, JSON.parse(expected));
});

Then("the arguments of activity item {int} contain {string}", function (this: ChatticusWorld, position: number, text: string) {
	const serialized = JSON.stringify(itemOf(this, position).arguments);
	assert.ok(serialized.includes(text), serialized);
});

Then("activity item {int} says its arguments were not truncated", function (this: ChatticusWorld, position: number) {
	assert.strictEqual(itemOf(this, position).arguments_truncated, false);
});

Then("activity item {int} says its arguments were truncated", function (this: ChatticusWorld, position: number) {
	assert.strictEqual(itemOf(this, position).arguments_truncated, true);
});

Then("activity item {int} is ok with the result summary {string}", function (this: ChatticusWorld, position: number, summary: string) {
	const item = itemOf(this, position);
	assert.strictEqual(item.ok, true);
	assert.equal(item.result_summary, summary);
});

Then("activity item {int} is not ok with the result summary {string}", function (this: ChatticusWorld, position: number, summary: string) {
	const item = itemOf(this, position);
	assert.strictEqual(item.ok, false);
	assert.equal(item.result_summary, summary);
});

Then("the output of activity item {int} contains {string}", function (this: ChatticusWorld, position: number, text: string) {
	const output = String(itemOf(this, position).output);
	assert.ok(output.includes(text), output);
});

Then("activity item {int} says its output was not truncated", function (this: ChatticusWorld, position: number) {
	assert.strictEqual(itemOf(this, position).output_truncated, false);
});

Then("activity item {int} says its output was truncated", function (this: ChatticusWorld, position: number) {
	assert.strictEqual(itemOf(this, position).output_truncated, true);
});

Then(
	"the output of activity item {int} keeps {int} characters at each end around an omission marker",
	function (this: ChatticusWorld, position: number, kept: number) {
		const output = String(itemOf(this, position).output);
		const marker = /\n\.\.\.\[(\d+) characters omitted\]\.\.\.\n/.exec(output);
		assert.ok(marker, "The output has no omission marker.");
		assert.equal(marker.index, kept);
		assert.equal(output.length - marker.index - marker[0].length, kept);
		assert.equal(Number(marker[1]), 5000 - 2 * kept);
	},
);

Then("activity item {int} has no duration", function (this: ChatticusWorld, position: number) {
	assert.strictEqual(itemOf(this, position).duration_ms, null);
});

Then(
	"activity item {int} has a path, {int} bytes and a preview of {int} characters but no content",
	function (this: ChatticusWorld, position: number, bytes: number, previewLength: number) {
		const given = itemOf(this, position).arguments;
		assert.equal(typeof given.path, "string");
		assert.equal(given.bytes, bytes);
		assert.equal(String(given.preview).length, previewLength);
		assert.ok(!("content" in given), JSON.stringify(given));
	},
);

Then("the message list does not contain the value of {string}", function (this: ChatticusWorld, name: string) {
	assert.ok(!JSON.stringify(listedMessagesOf(this)).includes(secretValueOf(name)), "The message list holds the secret value.");
});

Then("every activity item of the listed bot message equals the live events of the same call", async function (this: ChatticusWorld) {
	const turnId = computerOwnerScenarioOf(this).turnIds.at(-1);
	assert.ok(turnId !== undefined, "The scenario started no turn.");
	const events = await readTurnEvents(this, STORY_TENANT, turnId);
	const items = activityOf(this);
	const calls = events.filter((event) => event.kind === "tool.call");
	assert.ok(calls.length >= 2, `The journal has ${calls.length} tool calls.`);
	assert.equal(items.length, calls.length);
	for (const [index, call] of calls.entries()) {
		const result = events.find((event) => event.kind === "tool.result" && event.call_id === call.call_id);
		assert.ok(result, `The journal has no tool.result for ${call.call_id}.`);
		const item = items[index]!;
		assert.equal(item.call_id, call.call_id);
		assert.equal(item.tool, call.tool);
		assert.equal(item.summary, call.summary);
		assert.deepEqual(item.arguments, call.arguments);
		assert.equal(item.arguments_truncated, call.arguments_truncated);
		assert.equal(item.ok, result.ok);
		assert.equal(item.result_summary, result.summary);
		assert.equal(item.output, result.output);
		assert.equal(item.output_truncated, result.output_truncated);
	}
});
