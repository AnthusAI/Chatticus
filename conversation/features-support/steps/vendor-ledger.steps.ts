import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { Decimal } from "../../src/budget/decimal.ts";
import { getVendorLedgerEntry, recordVendorSpend, type VendorLedgerEntry } from "../../src/ledger/vendor-ledger.ts";
import { recordResponse } from "../api.ts";
import { ledgerDependenciesFor, priceBookOf, runBotTurn } from "../executor-harness.ts";
import { memberPost } from "../org-user-client.ts";
import type { ChatticusWorld } from "../world.ts";
import { post } from "./message.steps.ts";
import { currentTurnOf } from "./model.steps.ts";

const FAKE_COMPLETION_INPUT_TOKENS = 10;
const FAKE_COMPLETION_OUTPUT_TOKENS = 5;

async function ledgerRow(world: ChatticusWorld, turnId: string): Promise<VendorLedgerEntry> {
	const tenantId = world.lastChannel?.tenantId ?? "anthus";
	const row = await getVendorLedgerEntry(ledgerDependenciesFor(world), tenantId, turnId);
	assert.ok(row, `No vendor ledger row exists for turn ${turnId}`);
	return row;
}

const decimalOf = (text: string): Decimal => Decimal.parse(text);

function assertDecimal(actual: Decimal | null, expected: string, what: string): void {
	assert.ok(actual, `${what} is null`);
	assert.ok(actual.equals(decimalOf(expected)), `${what} is ${actual.toString()}, expected ${expected}`);
}

Given(
	"vendor price for model {string} is {word} input and {word} output per million tokens",
	function (this: ChatticusWorld, model: string, input: string, output: string) {
		priceBookOf(this).register("openai", model, {
			inputPerMillionUsd: decimalOf(input),
			outputPerMillionUsd: decimalOf(output),
		});
	},
);

When("bot {string} is asked {string}", async function (this: ChatticusWorld, name: string, body: string) {
	const bot = this.botsByName?.get(name);
	assert.ok(bot, `Bot ${name} not found`);
	const userId = this.botCreatorUserIds.get(name);
	assert.ok(userId, `No user created bot ${name}`);
	const opened = await recordResponse(
		await memberPost(this, `/orgs/${bot.tenantId}/channels`, { user_id: userId, bot_ids: [bot.botId], kind: "direct", name: null }),
	);
	assert.equal(opened.status, 200, opened.text);
	this.lastChannel = { channelId: opened.json.channel_id, tenantId: bot.tenantId };
	const posted = await post(this, { authorKind: "human", authorId: userId, body, addressedToBotId: bot.botId, tenantId: bot.tenantId });
	assert.equal(posted.status, 200, posted.text);
});

When(
	"bot {string} runs one vendor-ledger computerless worker turn with model {string}",
	async function (this: ChatticusWorld, name: string, model: string) {
		assert.equal(await runBotTurn(this, name, model), "done");
	},
);

When(
	"vendor spend is recorded for the turn with model {string} and billed_via {string}",
	async function (this: ChatticusWorld, model: string, billedVia: string) {
		const tenantId = this.lastChannel?.tenantId ?? "anthus";
		await recordVendorSpend(
			ledgerDependenciesFor(this),
			tenantId,
			currentTurnOf(this),
			{ vendor: "openai", model, inputTokens: FAKE_COMPLETION_INPUT_TOKENS, outputTokens: FAKE_COMPLETION_OUTPUT_TOKENS },
			billedVia,
		);
	},
);

When(
	"vendor spend is recorded for turn {string} with model {string} and tokens {int} in {int} out",
	async function (this: ChatticusWorld, turnId: string, model: string, inputTokens: number, outputTokens: number) {
		const tenantId = this.lastChannel?.tenantId ?? "anthus";
		await recordVendorSpend(ledgerDependenciesFor(this), tenantId, turnId, { vendor: "openai", model, inputTokens, outputTokens }, "vendor");
	},
);

type RowCheck = { readonly text: string; readonly takesValue: boolean; readonly check: (row: VendorLedgerEntry, value: any) => void };

const rowChecks: readonly RowCheck[] = [
	{ text: "billed_via {string}", takesValue: true, check: (row, value) => assert.equal(row.billedVia, value) },
	{ text: "input tokens {int}", takesValue: true, check: (row, value) => assert.equal(row.inputTokens, value) },
	{ text: "output tokens {int}", takesValue: true, check: (row, value) => assert.equal(row.outputTokens, value) },
	{
		text: "frozen input price {word} per million",
		takesValue: true,
		check: (row, value) => assertDecimal(row.inputPricePerMillionUsd, value, "the frozen input price"),
	},
	{
		text: "frozen output price {word} per million",
		takesValue: true,
		check: (row, value) => assertDecimal(row.outputPricePerMillionUsd, value, "the frozen output price"),
	},
	{ text: "cost_usd {word}", takesValue: true, check: (row, value) => assertDecimal(row.costUsd, value, "cost_usd") },
	{ text: "null cost_usd", takesValue: false, check: (row) => assert.equal(row.costUsd, null) },
	{
		text: "null frozen prices",
		takesValue: false,
		check: (row) => {
			assert.equal(row.inputPricePerMillionUsd, null);
			assert.equal(row.outputPricePerMillionUsd, null);
		},
	},
];

for (const { text, takesValue, check } of rowChecks) {
	const current = `the vendor ledger row for the turn has ${text}`;
	const named = `the vendor ledger row for turn {string} has ${text}`;
	if (takesValue) {
		Then(current, async function (this: ChatticusWorld, value: unknown) {
			check(await ledgerRow(this, currentTurnOf(this)), value);
		});
		Then(named, async function (this: ChatticusWorld, turnId: string, value: unknown) {
			check(await ledgerRow(this, turnId), value);
		});
	} else {
		Then(current, async function (this: ChatticusWorld) {
			check(await ledgerRow(this, currentTurnOf(this)), undefined);
		});
		Then(named, async function (this: ChatticusWorld, turnId: string) {
			check(await ledgerRow(this, turnId), undefined);
		});
	}
}
