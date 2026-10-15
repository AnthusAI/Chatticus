import assert from "node:assert/strict";
import { Given, Then } from "@cucumber/cucumber";
import { STORY_TENANT } from "../computer-scenario.ts";
import { computerOwnerScenarioOf, secretValueOf } from "../computer-owner.ts";
import { modelScenarioOf } from "../executor-harness.ts";
import { readTurnEvents } from "./model.steps.ts";
import type { ChatticusWorld } from "../world.ts";

type JournalEvent = Record<string, any>;

const reasoningOf = new WeakMap<ChatticusWorld, string>();

const journalOf = async (world: ChatticusWorld): Promise<JournalEvent[]> => {
	const turnId = computerOwnerScenarioOf(world).turnIds.at(-1);
	assert.ok(turnId !== undefined, "The scenario started no turn.");
	return readTurnEvents(world, STORY_TENANT, turnId);
};

const callOf = async (world: ChatticusWorld, tool: string): Promise<JournalEvent> => {
	const call = (await journalOf(world)).find((event) => event.kind === "tool.call" && event.tool === tool);
	assert.ok(call, `The journal has no tool.call for ${tool}.`);
	return call;
};

const resultOf = async (world: ChatticusWorld, tool: string): Promise<JournalEvent> => {
	const result = (await journalOf(world)).find((event) => event.kind === "tool.result" && event.tool === tool);
	assert.ok(result, `The journal has no tool.result for ${tool}.`);
	return result;
};

const pieceOf = (index: number, size: number): string => String.fromCharCode(97 + (index % 26)).repeat(size);

Given(
	"the model is scripted to call {string} with a command of {int} characters",
	function (this: ChatticusWorld, tool: string, length: number) {
		const command = `echo ${"a".repeat(length - 5)}`;
		modelScenarioOf(this).scripted.toolCall(tool, { command, cwd: "/workspace" }, "Working on it.");
	},
);

Given(
	"the model is scripted to call {string} with the secret value of {string} in an echo command",
	function (this: ChatticusWorld, tool: string, name: string) {
		modelScenarioOf(this).scripted.toolCall(tool, { command: `echo ${secretValueOf(name)}`, cwd: "/workspace" }, "Working on it.");
	},
);

Given(
	"the model reasons in {int} pieces of {int} characters before answering {string}",
	function (this: ChatticusWorld, pieces: number, size: number, answer: string) {
		const texts = Array.from({ length: pieces }, (_unused, index) => pieceOf(index, size));
		reasoningOf.set(this, texts.join(""));
		modelScenarioOf(this).scripted.reply(answer).thinking(...texts);
	},
);

Then(
	"the journal has a tool call {string} summarized {string}",
	async function (this: ChatticusWorld, tool: string, summary: string) {
		const call = await callOf(this, tool);
		assert.equal(call.summary, summary);
		assert.equal(typeof call.call_id, "string");
		assert.notEqual(call.call_id, "");
	},
);

Then(
	"the arguments of the tool call {string} are:",
	async function (this: ChatticusWorld, tool: string, expected: string) {
		assert.deepEqual((await callOf(this, tool)).arguments, JSON.parse(expected));
	},
);

Then("the arguments of the tool call {string} contain {string}", async function (this: ChatticusWorld, tool: string, text: string) {
	const serialized = JSON.stringify((await callOf(this, tool)).arguments);
	assert.ok(serialized.includes(text), serialized);
});

Then("the tool call {string} says its arguments were not truncated", async function (this: ChatticusWorld, tool: string) {
	assert.strictEqual((await callOf(this, tool)).arguments_truncated, false);
});

Then("the tool call {string} says its arguments were truncated", async function (this: ChatticusWorld, tool: string) {
	assert.strictEqual((await callOf(this, tool)).arguments_truncated, true);
});

Then(
	"the command argument of the tool call {string} is {int} characters long",
	async function (this: ChatticusWorld, tool: string, length: number) {
		assert.equal(String((await callOf(this, tool)).arguments.command).length, length);
	},
);

Then(
	"the summary of the tool call {string} is at most {int} characters long",
	async function (this: ChatticusWorld, tool: string, length: number) {
		const summary = String((await callOf(this, tool)).summary);
		assert.ok(summary.length <= length, `${summary.length} characters: ${summary}`);
	},
);

Then(
	"the tool result of {string} is ok and summarized {string}",
	async function (this: ChatticusWorld, tool: string, summary: string) {
		const result = await resultOf(this, tool);
		assert.strictEqual(result.ok, true);
		assert.equal(result.summary, summary);
	},
);

Then(
	"the tool result of {string} is not ok and summarized {string}",
	async function (this: ChatticusWorld, tool: string, summary: string) {
		const result = await resultOf(this, tool);
		assert.strictEqual(result.ok, false);
		assert.equal(result.summary, summary);
	},
);

Then("the tool result output of {string} contains {string}", async function (this: ChatticusWorld, tool: string, text: string) {
	const output = String((await resultOf(this, tool)).output);
	assert.ok(output.includes(text), output);
});

Then("the tool result of {string} has a duration in milliseconds", async function (this: ChatticusWorld, tool: string) {
	const duration = (await resultOf(this, tool)).duration_ms;
	assert.equal(typeof duration, "number");
	assert.ok(duration >= 0, String(duration));
});

Then("the tool call and the tool result of {string} share one call id", async function (this: ChatticusWorld, tool: string) {
	assert.equal((await callOf(this, tool)).call_id, (await resultOf(this, tool)).call_id);
});

Then("the tool result of {string} is marked as truncated", async function (this: ChatticusWorld, tool: string) {
	assert.strictEqual((await resultOf(this, tool)).output_truncated, true);
});

Then(
	"the tool result output of {string} keeps {int} characters at each end around an omission marker",
	async function (this: ChatticusWorld, tool: string, kept: number) {
		const output = String((await resultOf(this, tool)).output);
		const marker = /\n\.\.\.\[(\d+) characters omitted\]\.\.\.\n/.exec(output);
		assert.ok(marker, "The output has no omission marker.");
		assert.equal(marker.index, kept);
		assert.equal(output.length - marker.index - marker[0].length, kept);
		assert.equal(Number(marker[1]), 5000 - 2 * kept);
	},
);

Then(
	"no event of the journal contains the value of {string}",
	async function (this: ChatticusWorld, name: string) {
		const serialized = JSON.stringify(await journalOf(this));
		assert.ok(!serialized.includes(secretValueOf(name)), "The journal holds the secret value.");
	},
);

Then("every call id of the journal has exactly one tool.call and one tool.result", async function (this: ChatticusWorld) {
	const events = await journalOf(this);
	const calls = events.filter((event) => event.kind === "tool.call").map((event) => event.call_id);
	const results = events.filter((event) => event.kind === "tool.result").map((event) => event.call_id);
	assert.ok(calls.length > 0, "The journal has no tool.call.");
	assert.equal(new Set(calls).size, calls.length, `Duplicate tool.call events: ${calls.join(",")}`);
	assert.equal(new Set(results).size, results.length, `Duplicate tool.result events: ${results.join(",")}`);
	assert.deepEqual([...calls].sort(), [...results].sort());
});

const thinkingEvents = async (world: ChatticusWorld): Promise<JournalEvent[]> =>
	(await journalOf(world)).filter((event) => event.kind === "turn.thinking");

Then("the journal has fewer than {int} turn.thinking events", async function (this: ChatticusWorld, count: number) {
	const events = await thinkingEvents(this);
	assert.ok(events.length >= 1, "The journal has no turn.thinking event.");
	assert.ok(events.length < count, `${events.length} turn.thinking events.`);
});

Then(
	"the turn.thinking events join to the first {int} characters of the reasoning",
	async function (this: ChatticusWorld, length: number) {
		const reasoning = reasoningOf.get(this);
		assert.ok(reasoning !== undefined, "The scenario scripted no reasoning.");
		const joined = (await thinkingEvents(this)).map((event) => String(event.text)).join("");
		assert.equal(joined, reasoning.slice(0, length));
	},
);

Then("the turn.thinking events come before the first turn.token", async function (this: ChatticusWorld) {
	const kinds = (await journalOf(this)).map((event) => event.kind);
	const lastThinking = kinds.lastIndexOf("turn.thinking");
	const firstToken = kinds.indexOf("turn.token");
	assert.ok(lastThinking >= 0 && firstToken > lastThinking, kinds.join(","));
});

Then("the journal has no turn.thinking events", async function (this: ChatticusWorld) {
	assert.deepEqual(await thinkingEvents(this), []);
});

Then("the journal kinds contain in order {string}", async function (this: ChatticusWorld, list: string) {
	const wanted = list.split(",").map((kind) => kind.trim());
	const kinds = (await journalOf(this)).map((event) => event.kind as string);
	let from = 0;
	for (const kind of wanted) {
		const at = kinds.indexOf(kind, from);
		assert.ok(at >= 0, `${kind} does not follow ${wanted.slice(0, wanted.indexOf(kind)).join(", ")} in ${kinds.join(",")}`);
		from = at + 1;
	}
});

Then("the journal event {string} says {string}", async function (this: ChatticusWorld, kind: string, detail: string) {
	const event = (await journalOf(this)).find((candidate) => candidate.kind === kind);
	assert.ok(event, `The journal has no ${kind}.`);
	assert.equal(event.detail, detail);
});

Then("the journal has exactly one computer.starting and one computer.ready event", async function (this: ChatticusWorld) {
	const kinds = (await journalOf(this)).map((event) => event.kind);
	assert.equal(kinds.filter((kind) => kind === "computer.starting").length, 1);
	assert.equal(kinds.filter((kind) => kind === "computer.ready").length, 1);
});

Then("the journal has no computer.starting or computer.ready events", async function (this: ChatticusWorld) {
	const kinds = (await journalOf(this)).map((event) => event.kind);
	assert.ok(!kinds.includes("computer.starting") && !kinds.includes("computer.ready"), kinds.join(","));
});
