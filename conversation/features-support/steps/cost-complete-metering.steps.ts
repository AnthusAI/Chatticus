import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Given, Then, When } from "@cucumber/cucumber";
import { Decimal } from "../../src/budget/decimal.ts";
import { deriveCostRecords } from "../../src/ledger/call-cost.ts";
import { openOwnerSession } from "../../src/pi/session.ts";
import { promptRequestIdFor } from "../../src/turn/finalize.ts";
import { modelScenarioOf, priceBookOf } from "../executor-harness.ts";
import type { ChatticusWorld } from "../world.ts";
import { currentTurnOf } from "./model.steps.ts";
import { costRecordsOfTurnThroughFreshHandle, partitionOfTurn } from "./cost-session-records.steps.ts";

const context = BACKGROUND_CONTEXT;

const COMPACTION_SUMMARY_TEXT = "A summary of the earlier work.";

Given(
	"the model {string} summarizes the conversation for compaction using {int} uncached input, {int} cache read, {int} cache write and {int} output tokens",
	function (this: ChatticusWorld, model: string, input: number, cacheRead: number, cacheWrite: number, output: number) {
		modelScenarioOf(this, model).scripted.reply(COMPACTION_SUMMARY_TEXT, { input, cacheRead, cacheWrite, output });
	},
);

Given(
	"the model {string} is then rejected with status {int} and error code {string} after counting {int} uncached input and {int} output tokens",
	function (this: ChatticusWorld, model: string, status: number, code: string, input: number, output: number) {
		modelScenarioOf(this, model).scripted.providerErrorWithUsage(status, code, { input, output });
	},
);

Given(
	"the model {string} is cut off after {string} having counted {int} uncached input and {int} output tokens",
	function (this: ChatticusWorld, model: string, partialText: string, input: number, output: number) {
		modelScenarioOf(this, model).scripted.abortedWithUsage(partialText, { input, output });
	},
);

When("the cost records of the turn are derived again from the session", async function (this: ChatticusWorld) {
	const turnId = currentTurnOf(this);
	const { storageId, options } = await partitionOfTurn(this, turnId);
	const session = await openOwnerSession(storageId, { ...options, models: createModels(), extensions: [], context });
	try {
		const root = await session.harness.root(context, { agent: { model: { provider: "openai", modelId: "scripted-model" }, thinkingLevel: "off" } });
		const prompt = await session.harness.commit((tx) => tx.submissionByRequest(root.id, promptRequestIdFor(turnId)), context);
		assert.ok(prompt?.entry !== undefined, "The turn has no prompt entry");
		await deriveCostRecords(
			session.harness,
			session.storage,
			{ conversationId: root.id, turnId, promptEntryId: Number(prompt.entry), prices: priceBookOf(this), now: () => this.clock.now() },
			context,
		);
	} finally {
		await session.close();
	}
});

async function compactionRecordsOf(world: ChatticusWorld) {
	const records = (await costRecordsOfTurnThroughFreshHandle(world, currentTurnOf(world))).filter((record) => record.kind === "compaction");
	assert.ok(records.length > 0, "The turn has no compaction cost record");
	return records;
}

Then(
	"the compaction cost records of the turn total {int} uncached input and {int} output tokens",
	async function (this: ChatticusWorld, input: number, output: number) {
		const records = await compactionRecordsOf(this);
		assert.equal(records.reduce((total, record) => total + record.inputTokens, 0), input);
		assert.equal(records.reduce((total, record) => total + record.outputTokens, 0), output);
	},
);

Then("the compaction cost records of the turn cost {word} dollars", async function (this: ChatticusWorld, costUsd: string) {
	const records = await compactionRecordsOf(this);
	const total = records.reduce((sum, record) => sum.add(Decimal.parse(record.costUsd ?? "0")), Decimal.zero());
	assert.ok(total.equals(Decimal.parse(costUsd)), `compaction costs ${total.toString()}, expected ${costUsd}`);
	assert.ok(records.every((record) => record.round === 0 && !record.unpriced));
});
