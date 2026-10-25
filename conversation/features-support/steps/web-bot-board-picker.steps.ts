import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import type { DataTable } from "@cucumber/cucumber";
import { KanbusBoardProcess, type KanbusBoardState } from "../web-kanbus-board-process.ts";
import { kanbusBoardProcessOf as processOf, kanbusBoardScenarios } from "../web-kanbus-board-scenarios.ts";
import type { ChatticusWorld } from "../world.ts";

function elementsNamed(state: KanbusBoardState, testId: string) {
	return state.elements.filter((element) => element.testId === testId);
}

async function ensureBoardTabOpen(world: ChatticusWorld): Promise<void> {
	const process = processOf(world);
	const state = await process.state().catch(() => null);
	if (state === null || !state.text) await process.send({ op: "open" });
}

Given("the bot {string} has a board with the card {string}", async function (this: ChatticusWorld, name: string, title: string) {
	await processOf(this).send({ op: "seed-bot-board", name, rows: [{ title }] });
});

Given("the bot {string} has a board with these cards", async function (this: ChatticusWorld, name: string, table: DataTable) {
	await processOf(this).send({ op: "seed-bot-board", name, rows: table.hashes() });
});

Given("the bot {string} has a board with no cards", async function (this: ChatticusWorld, name: string) {
	await processOf(this).send({ op: "seed-bot-board", name, rows: [] });
});

Given("the bot {string} has {int} cards on its board", async function (this: ChatticusWorld, name: string, count: number) {
	await processOf(this).send({ op: "seed-bot-board-bulk", name, count });
});

Given("the member picked the bot board {string} in an earlier visit", async function (this: ChatticusWorld, name: string) {
	await processOf(this).send({ op: "remember-selection", kind: "bot", name });
});

Given("the bot board's index has not caught up", async function (this: ChatticusWorld) {
	await processOf(this).send({ op: "index-behind", name: "Assistant", value: true });
});

Given("the bot board store is unreachable", async function (this: ChatticusWorld) {
	await processOf(this).send({ op: "service-mode", mode: "unreachable" });
});

Given("the environment has no board service", async function (this: ChatticusWorld) {
	await processOf(this).send({ op: "service-mode", mode: "not_enabled" });
});

Given("the bot {string} has no board yet", async function (this: ChatticusWorld, name: string) {
	await processOf(this).send({ op: "seed-bot-without-board", name });
});

When("the bot {string} is given a board with the card {string}", async function (this: ChatticusWorld, name: string, title: string) {
	await processOf(this).send({ op: "give-bot-board", name, rows: [{ title }] });
});

async function startOnScreen(world: ChatticusWorld, width: number, height: number): Promise<void> {
	kanbusBoardScenarios.get(world)?.close();
	const process = new KanbusBoardProcess();
	kanbusBoardScenarios.set(world, process);
	await process.send({ op: "init" });
	await process.send({ op: "set-screen", width, height });
}

Given(
	"the board view for {string} in {string} with a running computer on an iPad held sideways",
	async function (this: ChatticusWorld, _email: string, _organization: string) {
		await startOnScreen(this, 1180, 820);
	},
);

Given(
	"the board view for {string} in {string} with a running computer on an iPad held upright",
	async function (this: ChatticusWorld, _email: string, _organization: string) {
		await startOnScreen(this, 820, 1180);
	},
);

Given(
	"the board view for {string} in {string} with a running computer on a phone",
	async function (this: ChatticusWorld, _email: string, _organization: string) {
		await startOnScreen(this, 390, 844);
	},
);

Given("the board view for {string} in {string} with the computer switched off", async function (this: ChatticusWorld, _email: string, _organization: string) {
	kanbusBoardScenarios.get(this)?.close();
	const process = new KanbusBoardProcess();
	kanbusBoardScenarios.set(this, process);
	await process.send({ op: "init" });
	await process.send({ op: "set-mode", mode: "off" });
});

When("the bot board store answers again", async function (this: ChatticusWorld) {
	await processOf(this).send({ op: "service-mode", mode: "ok" });
});

When("the bot board's index catches up", async function (this: ChatticusWorld) {
	await processOf(this).send({ op: "index-behind", name: "Assistant", value: false });
});

When("the member opens the board picker", async function (this: ChatticusWorld) {
	const process = processOf(this);
	await process.send({ op: "open" });
	await process.send({ op: "open-picker" });
});

When("the member closes and opens the board picker", async function (this: ChatticusWorld) {
	const process = processOf(this);
	await process.send({ op: "close-picker" });
	await process.send({ op: "open-picker" });
});

When("the bot {string} is created with an empty board", async function (this: ChatticusWorld, name: string) {
	await processOf(this).send({ op: "seed-bot-board", name, rows: [] });
});

When("the bot {string} saves the card {string}", async function (this: ChatticusWorld, name: string, title: string) {
	await processOf(this).send({ op: "add-bot-card", name, cardId: `${name.slice(0, 2).toLowerCase()}-2`, title });
});

When("the member picks the bot board {string}", async function (this: ChatticusWorld, name: string) {
	await ensureBoardTabOpen(this);
	await processOf(this).send({ op: "pick", kind: "bot", name });
});

When("the member picks the project board {string}", async function (this: ChatticusWorld, name: string) {
	await ensureBoardTabOpen(this);
	await processOf(this).send({ op: "pick", kind: "project", name });
});

Then("the picker has the section {string} listing {string}", async function (this: ChatticusWorld, section: string, names: string) {
	const state = await processOf(this).state();
	const testId = section === "Project boards" ? "board-picker-project-entry" : "board-picker-bot-entry";
	assert.ok(state.text.includes(section), `The picker has no section "${section}". The board shows: ${state.text}`);
	assert.deepEqual(
		elementsNamed(state, testId).map((entry) => entry.text),
		names.split(",").map((name) => name.trim()),
		`The board shows: ${state.text}`,
	);
});

Then(
	"the picker has the section {string} listing {string} and {string}",
	async function (this: ChatticusWorld, section: string, first: string, second: string) {
		const state = await processOf(this).state();
		const testId = section === "Project boards" ? "board-picker-project-entry" : "board-picker-bot-entry";
		assert.deepEqual(elementsNamed(state, testId).map((entry) => entry.text), [first, second], `The board shows: ${state.text}`);
	},
);

Then("the picker has the section {string} saying {string}", async function (this: ChatticusWorld, section: string, message: string) {
	const state = await processOf(this).state();
	const testId = section === "Project boards" ? "board-picker-project-message" : "board-picker-bot-message";
	assert.equal(elementsNamed(state, testId)[0]?.text, message, `The board shows: ${state.text}`);
	const entryId = section === "Project boards" ? "board-picker-project-entry" : "board-picker-bot-entry";
	assert.equal(elementsNamed(state, entryId).length, 0, "The section lists boards although it has none");
});

Then("the board does not say {string}", async function (this: ChatticusWorld, text: string) {
	const state = await processOf(this).state();
	assert.ok(!state.text.includes(text), `The board says "${text}". It shows: ${state.text}`);
});

Then("the board shows no error", async function (this: ChatticusWorld) {
	const state = await processOf(this).state();
	assert.ok(!state.html.includes('role="alert"'), `The board shows an error. It shows: ${state.text}`);
});

Then("the board offers to refresh", async function (this: ChatticusWorld) {
	const state = await processOf(this).state();
	assert.ok(state.html.includes('aria-label="Refresh the board"'), "The board has no refresh button");
});

Then("the board offers to try again", async function (this: ChatticusWorld) {
	const state = await processOf(this).state();
	assert.ok(state.html.includes('aria-label="Try again"'), "The board has no try again button");
});

Then("both boards were drawn by IssueCollection from the Kanbus UI package", async function (this: ChatticusWorld) {
	const state = await processOf(this).state();
	const kinds = state.drawings.map((drawing) => drawing.kind);
	assert.deepEqual(kinds, ["project", "bot"]);
	for (const drawing of state.drawings) {
		assert.ok(drawing.wrapperClass.includes("chatticus-kanbus-board"), `The ${drawing.kind} board was not drawn inside the Kanbus wrapper`);
		assert.ok(drawing.columnClass.includes("kb-column"), `The ${drawing.kind} board has no Kanbus column`);
		assert.ok(drawing.cardClass.includes("issue-card"), `The ${drawing.kind} board has no Kanbus card`);
	}
});

Then("both boards use the same card and column markup", async function (this: ChatticusWorld) {
	const state = await processOf(this).state();
	const [project, bot] = state.drawings;
	assert.equal(project.wrapperClass, bot.wrapperClass);
	assert.equal(project.columnClass, bot.columnClass);
});

Then("the computer was not asked for anything to show the board", async function (this: ChatticusWorld) {
	const state = await processOf(this).state();
	assert.deepEqual(state.computerRequestsSincePick, []);
});

Then("the panel sent only reads to the bot board routes", async function (this: ChatticusWorld) {
	const state = await processOf(this).state();
	assert.ok(state.botBoardRequests.length > 0, "The panel sent no request to the bot board routes");
	assert.deepEqual(state.botBoardRequests.filter((request) => request.method !== "GET"), []);
});

When("the member closes the board picker", async function (this: ChatticusWorld) {
	await processOf(this).send({ op: "close-picker" });
});

function noteOfEntry(state: KanbusBoardState, name: string): string | null {
	const row = elementsNamed(state, "board-picker-bot-row").find((candidate) => candidate.text === name || candidate.text.startsWith(`${name} `));
	assert.ok(row, `The picker has no entry "${name}". The board shows: ${state.text}`);
	const note = row.text.slice(name.length).trim();
	return note === "" ? null : note;
}

Then("the picker entry {string} says {string}", async function (this: ChatticusWorld, name: string, note: string) {
	const state = await processOf(this).state();
	assert.equal(noteOfEntry(state, name), note, `The board shows: ${state.text}`);
});

Then("the picker entry {string} says nothing about a missing board", async function (this: ChatticusWorld, name: string) {
	const state = await processOf(this).state();
	assert.equal(noteOfEntry(state, name), null, `The board shows: ${state.text}`);
});

Then("the entry {string} is marked as the board on show", async function (this: ChatticusWorld, name: string) {
	const state = await processOf(this).state();
	assert.ok(state.html.includes(`aria-pressed="true" aria-label="Bot board: ${name}`), `No entry "${name}" is marked. The board shows: ${state.text}`);
});

Then("the list of boards is shown beside the board", async function (this: ChatticusWorld) {
	const state = await processOf(this).state();
	assert.equal(elementsNamed(state, "board-picker-side").length, 1, `The list is not beside the board. The board shows: ${state.text}`);
	assert.ok(elementsNamed(state, "kanbus-board").length + elementsNamed(state, "kanbus-board-state").length > 0, "No board is shown");
});

Then("the list of boards is not a bottom sheet", async function (this: ChatticusWorld) {
	const state = await processOf(this).state();
	assert.equal(elementsNamed(state, "board-picker-sheet").length, 0);
});

Then("the list of boards is shown in a bottom sheet", async function (this: ChatticusWorld) {
	const state = await processOf(this).state();
	assert.equal(elementsNamed(state, "board-picker-sheet").length, 1, `No bottom sheet is open. The board shows: ${state.text}`);
	assert.ok(state.html.includes('role="dialog"'), "The bottom sheet is not a dialog");
	assert.equal(elementsNamed(state, "board-picker-side").length, 0, "The list is also beside the board");
});

Then("the bottom sheet can be closed without picking a board", async function (this: ChatticusWorld) {
	const state = await processOf(this).state();
	assert.equal(elementsNamed(state, "board-picker-sheet-close").length, 1, "The sheet has no way to close it");
});

Then("the list of boards is not shown", async function (this: ChatticusWorld) {
	const state = await processOf(this).state();
	assert.equal(elementsNamed(state, "board-picker").length, 0, `The list is shown. The board shows: ${state.text}`);
});

Then("the Boards button is offered", async function (this: ChatticusWorld) {
	const state = await processOf(this).state();
	assert.equal(elementsNamed(state, "board-picker-toggle").length, 1, "The Boards button is missing");
});

Then("the Boards button is not offered", async function (this: ChatticusWorld) {
	const state = await processOf(this).state();
	assert.equal(elementsNamed(state, "board-picker-toggle").length, 0, "The Boards button is offered");
});
