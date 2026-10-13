import assert from "node:assert/strict";
import { Given, Then } from "@cucumber/cucumber";
import { modelScenarioOf } from "../executor-harness.ts";
import type { ChatticusWorld } from "../world.ts";
import { currentTurnOf } from "./model.steps.ts";
import { ledgerRow } from "./vendor-ledger.steps.ts";

type TokenCounts = { readonly input: number; readonly cacheRead: number; readonly cacheWrite: number; readonly output: number };

const usageOf = (counts: TokenCounts, servedBy?: string) => ({ ...counts, ...(servedBy === undefined ? {} : { servedBy }) });

Given(
	"the model {string} answers {string} using {int} uncached input, {int} cache read, {int} cache write and {int} output tokens",
	function (this: ChatticusWorld, model: string, text: string, input: number, cacheRead: number, cacheWrite: number, output: number) {
		modelScenarioOf(this, model).scripted.reply(text, usageOf({ input, cacheRead, cacheWrite, output }));
	},
);

Given(
	"the model {string} calls the note tool with {string} using {int} uncached input, {int} cache read, {int} cache write and {int} output tokens",
	function (this: ChatticusWorld, model: string, note: string, input: number, cacheRead: number, cacheWrite: number, output: number) {
		modelScenarioOf(this, model).scripted.toolCall("note_to_channel", { note }, "", usageOf({ input, cacheRead, cacheWrite, output }));
	},
);

Given(
	"the model {string} then answers {string} as served by {string} using {int} uncached input, {int} cache read, {int} cache write and {int} output tokens",
	function (
		this: ChatticusWorld,
		model: string,
		text: string,
		servedBy: string,
		input: number,
		cacheRead: number,
		cacheWrite: number,
		output: number,
	) {
		modelScenarioOf(this, model).scripted.reply(text, usageOf({ input, cacheRead, cacheWrite, output }, servedBy));
	},
);

Then("the vendor ledger row for the turn was priced with {string}", async function (this: ChatticusWorld, label: string) {
	const row = await ledgerRow(this, currentTurnOf(this));
	assert.ok(row.pricedWith.includes(label), `priced with ${row.pricedWith.join(", ")}, expected ${label}`);
});

Then("the vendor ledger row for the turn has price book id {string}", async function (this: ChatticusWorld, priceBookId: string) {
	assert.equal((await ledgerRow(this, currentTurnOf(this))).priceBookId, priceBookId);
});

Then("the vendor ledger row for the turn lists models {string}", async function (this: ChatticusWorld, models: string) {
	assert.equal((await ledgerRow(this, currentTurnOf(this))).models.join(", "), models);
});

Then(
	"the vendor ledger row for turn {string} has {int} unpriced call(s)",
	async function (this: ChatticusWorld, turnId: string, count: number) {
		assert.equal((await ledgerRow(this, turnId)).unpricedCalls, count);
	},
);
