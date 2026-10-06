import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { Decimal } from "../../src/budget/decimal.ts";
import { getVendorLedgerEntry, recordVendorSpend, type VendorLedgerEntry } from "../../src/ledger/vendor-ledger.ts";
import { SimulatedCrash } from "../../src/turn/fault-plan.ts";
import { recordResponse } from "../api.ts";
import { ledgerDependenciesFor, modelScenarioOf, priceBookOf, runBotTurn } from "../executor-harness.ts";
import { memberPost } from "../org-user-client.ts";
import { passTimeUntilSettled } from "../turn-recovery.ts";
import type { ChatticusWorld } from "../world.ts";
import { post } from "./message.steps.ts";
import { currentTurnOf, readTurn } from "./model.steps.ts";

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

Given(
	"the model {string} answers {string}",
	function (this: ChatticusWorld, model: string, answer: string) {
		modelScenarioOf(this, model).scripted.reply(answer);
	},
);

Given(
	"the model {string} calls the note tool with {string} and then the provider rejects the request with status {int} and error code {string}",
	function (this: ChatticusWorld, model: string, note: string, status: number, code: string) {
		modelScenarioOf(this, model).scripted.toolCall("note_to_channel", { note }).providerError(status, code);
	},
);

When(
	"bot {string} runs one vendor-ledger computerless worker turn with model {string} that fails",
	async function (this: ChatticusWorld, name: string, model: string) {
		assert.equal(await runBotTurn(this, name, model), "failed");
	},
);

When(
	"the worker of bot {string} with model {string} crashes right after recording the spend of its answer",
	async function (this: ChatticusWorld, name: string, model: string) {
		this.faultPlan.arm("completion_append", "after");
		await assert.rejects(runBotTurn(this, name, model), SimulatedCrash);
		assert.deepEqual(this.faultPlan.crashedAt, { boundary: "completion_append", window: "after" });
		this.faultPlan.clear();
	},
);

When("time passes until the turn is recovered", async function (this: ChatticusWorld) {
	await passTimeUntilSettled(this, currentTurnOf(this));
});

Then("the turn has completed", async function (this: ChatticusWorld) {
	const tenantId = this.lastChannel?.tenantId ?? "anthus";
	const response = await readTurn(this, tenantId, currentTurnOf(this));
	assert.equal(response.status, 200, response.text);
	assert.equal(response.json.status, "completed");
});

Then("the model {string} was called {int} time(s)", function (this: ChatticusWorld, model: string, count: number) {
	assert.equal(modelScenarioOf(this, model).scripted.callCount, count);
});

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
