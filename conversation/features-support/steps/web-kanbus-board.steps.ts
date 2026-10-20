import assert from "node:assert/strict";
import { After, Given, Then, When } from "@cucumber/cucumber";
import type { DataTable } from "@cucumber/cucumber";
import { KanbusBoardProcess, type KanbusBoardState } from "../web-kanbus-board-process.ts";
import type { ChatticusWorld } from "../world.ts";

const scenarios = new WeakMap<ChatticusWorld, KanbusBoardProcess>();

function processOf(world: ChatticusWorld): KanbusBoardProcess {
	const found = scenarios.get(world);
	assert.ok(found, "No board scenario is running.");
	return found;
}

After(function (this: ChatticusWorld) {
	scenarios.get(this)?.close();
	scenarios.delete(this);
});

function elementNamed(state: KanbusBoardState, testId: string) {
	return state.elements.find((element) => element.testId === testId);
}

function contentRequestCount(state: KanbusBoardState): number {
	return state.requests.filter((request) => request.route === "/content").length;
}

function columnCardIds(state: KanbusBoardState, status: string): string[] {
	assert.ok(elementNamed(state, `kanbus-column-${status}`), `The board has no column "${status}". It shows: ${state.text}`);
	return state.elements.filter((element) => element.testId === `kanbus-card-id-${status}`).map((element) => element.text);
}

Given(
	"the board view for {string} in {string} with a running computer",
	async function (this: ChatticusWorld, _email: string, _organization: string) {
		scenarios.get(this)?.close();
		const process = new KanbusBoardProcess();
		scenarios.set(this, process);
		await process.send({ op: "init" });
	},
);

Given(
	"the workspace folder {string} holds a Kanbus project with these issues",
	async function (this: ChatticusWorld, folder: string, table: DataTable) {
		await processOf(this).send({ op: "seed-issues", project: folder, rows: table.hashes() });
	},
);

Given("the workspace folder {string} holds {int} Kanbus issues", async function (this: ChatticusWorld, folder: string, count: number) {
	await processOf(this).send({ op: "seed-many-issues", project: folder, count });
});

Given(
	"the workspace holds the file {string} containing {string}",
	async function (this: ChatticusWorld, name: string, content: string) {
		await processOf(this).send({ op: "seed-text-file", path: `/workspace/${name}`, content });
	},
);

Given("the computer answers every file request that it is busy", async function (this: ChatticusWorld) {
	await processOf(this).send({ op: "fail-every-request", value: true });
});

When("the computer answers file requests normally again", async function (this: ChatticusWorld) {
	await processOf(this).send({ op: "fail-every-request", value: false });
});

When("the member opens the Board tab", async function (this: ChatticusWorld) {
	const process = processOf(this);
	await process.send({ op: "forget-requests" });
	await process.send({ op: "open" });
});

When("the member refreshes the board", async function (this: ChatticusWorld) {
	const process = processOf(this);
	await process.send({ op: "forget-requests" });
	await process.send({ op: "refresh" });
});

When("the board's computer is switched off", async function (this: ChatticusWorld) {
	await processOf(this).send({ op: "set-mode", mode: "off" });
});

When(
	"the bot moves issue {string} of {string} to the status {string}",
	async function (this: ChatticusWorld, id: string, folder: string, status: string) {
		await processOf(this).send({ op: "change-issue", project: folder, id, row: { id, title: id, status, priority: "2" } });
	},
);

Then("the board is named {string}", async function (this: ChatticusWorld, name: string) {
	const state = await processOf(this).state();
	assert.equal(elementNamed(state, "kanbus-board-name")?.text, name, `The board shows: ${state.text}`);
});

Then("the board says {string}", async function (this: ChatticusWorld, text: string) {
	const state = await processOf(this).state();
	assert.ok(state.text.includes(text), `The board does not say "${text}". It shows: ${state.text}`);
});

Then("the board column {string} lists {string}", async function (this: ChatticusWorld, status: string, expected: string) {
	const state = await processOf(this).state();
	assert.deepEqual(columnCardIds(state, status), expected.split(",").map((id) => id.trim()), `The board shows: ${state.text}`);
});

Then("the board column {string} has a count of {int}", async function (this: ChatticusWorld, status: string, count: number) {
	const state = await processOf(this).state();
	assert.equal(elementNamed(state, `kanbus-column-count-${status}`)?.text, String(count));
});

Then("the card {string} shows {string}", async function (this: ChatticusWorld, id: string, text: string) {
	const state = await processOf(this).state();
	const card = elementNamed(state, `kanbus-card-${id}`);
	assert.ok(card, `The board has no card "${id}". It shows: ${state.text}`);
	assert.ok(card.text.includes(text), `The card "${id}" does not show "${text}". It shows: ${card.text}`);
});

Then("the board read {int} issue file(s)( again)", async function (this: ChatticusWorld, count: number) {
	const state = await processOf(this).state();
	assert.equal(contentRequestCount(state), count);
});
