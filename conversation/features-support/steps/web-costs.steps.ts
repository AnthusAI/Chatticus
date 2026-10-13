import assert from "node:assert/strict";
import { After, Given, Then, When } from "@cucumber/cucumber";
import type { DataTable } from "@cucumber/cucumber";
import { CostsProcess, type CostsState, type CostsTestElement } from "../web-costs-process.ts";
import type { ChatticusWorld } from "../world.ts";

const scenarios = new WeakMap<ChatticusWorld, CostsProcess>();

function processOf(world: ChatticusWorld): CostsProcess {
	const found = scenarios.get(world);
	assert.ok(found, "No cost view scenario is running.");
	return found;
}

async function start(world: ChatticusWorld, init: Record<string, unknown>): Promise<void> {
	scenarios.get(world)?.close();
	const process = new CostsProcess();
	scenarios.set(world, process);
	await process.send({ op: "init", ...init });
}

After(function (this: ChatticusWorld) {
	scenarios.get(this)?.close();
	scenarios.delete(this);
});

function elementsWithPrefix(state: CostsState, prefix: string): CostsTestElement[] {
	return state.elements.filter((element) => element.testId.startsWith(prefix));
}

function elementNamed(state: CostsState, testId: string): CostsTestElement | undefined {
	return state.elements.find((element) => element.testId === testId);
}

function turnRow(state: CostsState, turn: string): CostsTestElement {
	const row = elementNamed(state, `turn-row-${turn}`);
	assert.ok(row, `No row for turn "${turn}". Rows: ${elementsWithPrefix(state, "turn-row-").map((entry) => entry.testId).join(", ")}`);
	return row;
}

function callCards(state: CostsState): CostsTestElement[] {
	return state.elements.filter((element) => /^call-\d+$/.test(element.testId));
}

function callCard(state: CostsState, position: number): CostsTestElement {
	const card = elementNamed(state, `call-${position}`);
	assert.ok(card, `The call list has no call ${position}. It shows: ${state.text}`);
	return card;
}

function messageElement(state: CostsState, seq: number): CostsTestElement {
	const element = elementNamed(state, `message-${seq}`);
	assert.ok(element, `The conversation preview has no message ${seq}.`);
	return element;
}

Given(
	"the cost view for {string} in {string} with these turns this month",
	async function (this: ChatticusWorld, _email: string, _organization: string, table: DataTable) {
		await start(this, { member: true, rows: table.hashes() });
	},
);

Given(
	"the cost view for {string} in {string} with no turns",
	async function (this: ChatticusWorld, _email: string, _organization: string) {
		await start(this, { member: true, rows: [] });
	},
);

Given(
	"the cost view for {string} in {string} who is not a member",
	async function (this: ChatticusWorld, _email: string, _organization: string) {
		await start(this, { member: false, rows: [] });
	},
);

Given(
	"the cost view for {string} in {string} with {int} turns of {string} this month",
	async function (this: ChatticusWorld, _email: string, _organization: string, count: number, cost: string) {
		await start(this, { member: true, bulk: { count, cost } });
	},
);

Given("the cost API fails on the next request", async function (this: ChatticusWorld) {
	await processOf(this).fake("failNext");
});

Given("the session of turn {string} cannot be read", async function (this: ChatticusWorld, turn: string) {
	await processOf(this).fake("unreadable", turn);
});

When("the member opens the Costs tab", async function (this: ChatticusWorld) {
	await processOf(this).send({ op: "open-tab" });
});

When("the member goes to the previous month", async function (this: ChatticusWorld) {
	await processOf(this).call("previousMonth");
});

When("the member goes to the next month", async function (this: ChatticusWorld) {
	await processOf(this).call("nextMonth");
});

When("the member chooses Try again", async function (this: ChatticusWorld) {
	await processOf(this).call("retry");
});

When("the member chooses Show more turns", async function (this: ChatticusWorld) {
	await processOf(this).call("loadMoreTurns");
});

When("the member chooses Download turns as CSV", async function (this: ChatticusWorld) {
	await processOf(this).call("exportCosts", "turn");
});

When("the member opens the turn {string}", async function (this: ChatticusWorld, turn: string) {
	await processOf(this).call("openTurn", turn);
});

When("the member goes back to the turns", async function (this: ChatticusWorld) {
	await processOf(this).call("closeDrilldown");
});

When("the member opens the {string} conversation", async function (this: ChatticusWorld, name: string) {
	await processOf(this).send({ op: "select-channel", name });
});

When("the member opens the cost of message {int}", async function (this: ChatticusWorld, seq: number) {
	await processOf(this).call("openMessage", seq);
});

When("the member chooses this conversation", async function (this: ChatticusWorld) {
	await processOf(this).call("setScope", "channel");
});

When("the member chooses the whole organization", async function (this: ChatticusWorld) {
	await processOf(this).call("setScope", "organization");
});

Then("the cost view shows the period {string}", async function (this: ChatticusWorld, period: string) {
	const state = await processOf(this).state();
	assert.equal(elementNamed(state, "cost-period")?.text, period, state.text);
});

Then("the cost headline reads {string}", async function (this: ChatticusWorld, headline: string) {
	const state = await processOf(this).state();
	const element = elementNamed(state, "cost-headline");
	assert.ok(element, `The view shows no total. It shows: ${state.text}`);
	assert.equal(element.text, headline);
});

Then("the cost view says {string}", async function (this: ChatticusWorld, text: string) {
	const state = await processOf(this).state();
	assert.ok(state.text.includes(text), `The cost view does not say "${text}". It says: ${state.text}`);
});

Then("the cost view does not say {string}", async function (this: ChatticusWorld, text: string) {
	const state = await processOf(this).state();
	assert.ok(!state.text.includes(text), `The cost view says "${text}". It says: ${state.text}`);
});

Then("the cost view shows no total", async function (this: ChatticusWorld) {
	const state = await processOf(this).state();
	assert.equal(elementNamed(state, "cost-headline"), undefined, `The view shows a total. It shows: ${state.text}`);
});

Then(
	"the cost view asked the cost API for {string} without a date range",
	async function (this: ChatticusWorld, route: string) {
		const state = await processOf(this).state();
		const asked = state.requests.filter((request) => request.route === route);
		assert.ok(asked.length > 0, `No request for ${route}.`);
		for (const request of asked) {
			assert.equal(request.query.from, undefined, JSON.stringify(request));
			assert.equal(request.query.to, undefined, JSON.stringify(request));
		}
	},
);

Then(
	"the cost view asked the cost API for {string} from {string} to {string}",
	async function (this: ChatticusWorld, route: string, from: string, to: string) {
		const state = await processOf(this).state();
		const asked = state.requests.filter((request) => request.route === route && request.query.from === from && request.query.to === to);
		assert.ok(asked.length > 0, `No request for ${route} from ${from} to ${to}: ${JSON.stringify(state.requests.map((request) => [request.route, request.query]))}`);
	},
);

Then(
	"the {string} breakdown lists {string} as {string}",
	async function (this: ChatticusWorld, kind: string, label: string, figure: string) {
		const state = await processOf(this).state();
		const row = state.elements.find((element) => element.testId === `breakdown-${kind}-row` && element.label === label);
		assert.ok(row, `The ${kind} breakdown does not list "${label}". It shows: ${state.text}`);
		assert.ok(row.text.includes(figure), `The ${kind} breakdown shows "${row.text}" for "${label}", not "${figure}".`);
	},
);

Then(
	"the {string} breakdown lists {string} before {string}",
	async function (this: ChatticusWorld, kind: string, first: string, second: string) {
		const state = await processOf(this).state();
		const labels = state.elements.filter((element) => element.testId === `breakdown-${kind}-row`).map((element) => element.label);
		const firstIndex = labels.indexOf(first);
		const secondIndex = labels.indexOf(second);
		assert.ok(firstIndex >= 0 && secondIndex >= 0, `The ${kind} breakdown lists ${labels.join(", ")}.`);
		assert.ok(firstIndex < secondIndex, `The ${kind} breakdown lists ${labels.join(", ")}.`);
	},
);

Then(
	"the recent turns start with {string} then {string}",
	async function (this: ChatticusWorld, first: string, second: string) {
		const state = await processOf(this).state();
		const order = elementsWithPrefix(state, "turn-row-").map((element) => element.testId.slice("turn-row-".length));
		assert.deepEqual(order.slice(0, 2), [first, second], `The turns are listed as ${order.join(", ")}.`);
	},
);

Then("the turn row {string} says {string}", async function (this: ChatticusWorld, turn: string, text: string) {
	const row = turnRow(await processOf(this).state(), turn);
	assert.ok(row.text.includes(text), `Turn "${turn}" shows "${row.text}", not "${text}".`);
});

Then("the turn row {string} does not say {string}", async function (this: ChatticusWorld, turn: string, text: string) {
	const row = turnRow(await processOf(this).state(), turn);
	assert.ok(!row.text.includes(text), `Turn "${turn}" shows "${row.text}".`);
});

Then("the recent turns list shows {int} turn(s)", async function (this: ChatticusWorld, count: number) {
	const state = await processOf(this).state();
	assert.equal(elementsWithPrefix(state, "turn-row-").length, count, state.text);
});

Then("the cost view offers no Show more turns", async function (this: ChatticusWorld) {
	const state = await processOf(this).state();
	assert.ok(!state.text.includes("Show more"), state.text);
});

Then("the cost API was asked for turns with the cursor it issued", async function (this: ChatticusWorld) {
	const state = await processOf(this).state();
	const paged = state.requests.filter((request) => request.route === "/costs/turns" && request.query.cursor !== undefined);
	assert.ok(paged.length > 0, "No turns request carried a cursor.");
});

Then(
	"the cost API was asked to export {string} at the {string} grain with the member's token",
	async function (this: ChatticusWorld, format: string, grain: string) {
		const state = await processOf(this).state();
		assert.deepEqual(state.exportRequest, { format, grain });
		const request = state.requests.find((entry) => entry.route === "/costs/export");
		assert.ok(request, "No export request.");
		assert.equal(request.headers.authorization, "Bearer harness-token");
	},
);

Then("the member is handed the file {string}", async function (this: ChatticusWorld, filename: string) {
	const state = await processOf(this).state();
	assert.equal(state.delivered.at(-1)?.filename, filename, JSON.stringify(state.delivered));
	assert.ok((state.delivered.at(-1)?.text ?? "").includes("id,row_kind"), "The file has no header row.");
});

Then("the call list shows {int} call(s)", async function (this: ChatticusWorld, count: number) {
	const state = await processOf(this).state();
	assert.equal(callCards(state).length, count, state.text);
});

Then("call {int} of the turn shows {string}", async function (this: ChatticusWorld, position: number, text: string) {
	const card = callCard(await processOf(this).state(), position);
	assert.ok(card.text.includes(text), `Call ${position} shows "${card.text}", not "${text}".`);
});

Then("call {int} of the turn does not show {string}", async function (this: ChatticusWorld, position: number, text: string) {
	const card = callCard(await processOf(this).state(), position);
	assert.ok(!card.text.includes(text), `Call ${position} shows "${card.text}".`);
});

Then("the conversation cost chip shows {string}", async function (this: ChatticusWorld, text: string) {
	const state = await processOf(this).state();
	const chip = elementNamed(state, "channel-cost-chip");
	assert.ok(chip, "The conversation shows no cost chip.");
	assert.ok(chip.text.includes(text), `The chip shows "${chip.text}", not "${text}".`);
});

Then("the cost API was asked for the cost of the channel {string}", async function (this: ChatticusWorld, name: string) {
	const state = await processOf(this).state();
	const route = `/channels/channel-${name.toLowerCase()}/cost`;
	assert.ok(state.requests.some((request) => request.route === route), `No request for ${route}.`);
});

Then("the cost API was asked for the cost of the turn {string}", async function (this: ChatticusWorld, turn: string) {
	const state = await processOf(this).state();
	assert.ok(state.requests.some((request) => request.route === `/turns/${turn}/cost`), `No request for turn ${turn}.`);
});

Then("message {int} shows the cost marker {string}", async function (this: ChatticusWorld, seq: number, text: string) {
	const element = messageElement(await processOf(this).state(), seq);
	assert.ok(element.text.includes(text), `Message ${seq} shows "${element.text}", not "${text}".`);
});

Then("message {int} shows no cost marker", async function (this: ChatticusWorld, seq: number) {
	const element = messageElement(await processOf(this).state(), seq);
	assert.equal(element.text, "", `Message ${seq} shows "${element.text}".`);
});
