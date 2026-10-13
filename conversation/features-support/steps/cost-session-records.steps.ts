import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { GetItemCommand } from "@aws-sdk/client-dynamodb";
import { AssistantEntry, type ConversationId, createSession, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { Given, Then, When } from "@cucumber/cucumber";
import { Decimal } from "../../src/budget/decimal.ts";
import { deriveCostRecordsFromEntries, type ModelCallCost, readCallCostRecords } from "../../src/ledger/call-cost.ts";
import { costTurnIndexKey } from "../../src/ledger/turn-cost.ts";
import { getVendorLedgerEntry } from "../../src/ledger/vendor-ledger.ts";
import { openOwnerSession, openOwnerStorage } from "../../src/pi/session.ts";
import { IndexedStorage } from "../../src/storage/indexed-storage.ts";
import { storageIdFor } from "../../src/storage/storage-support.ts";
import { SimulatedCrash } from "../../src/turn/fault-plan.ts";
import { ledgerDependenciesFor, modelScenarioOf, priceBookOf, runBotTurn } from "../executor-harness.ts";
import { gatewayScenarioOf } from "../model-gateway-support.ts";
import { ensurePiStorage } from "../pi-storage.ts";
import type { ChatticusWorld } from "../world.ts";
import { currentTurnOf } from "./model.steps.ts";

const context = BACKGROUND_CONTEXT;

const tenantOf = (world: ChatticusWorld): string => world.lastChannel?.tenantId ?? "anthus";

async function partitionOfTurn(world: ChatticusWorld, turnId: string) {
	const tenantId = tenantOf(world);
	const turn = await world.turnDependencies().store.getTurn(tenantId, turnId);
	assert.ok(turn, `Turn ${turnId} does not exist`);
	const piStorage = await ensurePiStorage(world);
	return {
		turn,
		piStorage,
		storageId: storageIdFor(tenantId, turn.botId, turn.channelId),
		options: { client: world.messagingTable.client, s3: piStorage.s3, tableName: piStorage.tableName, bucket: piStorage.bucket },
	};
}

/** The cost records of the turn's session read through a plain reader with no owner and no fence, which replays nothing. */
export async function costRecordsOfTurnThroughFreshHandle(world: ChatticusWorld, turnId: string): Promise<ModelCallCost[]> {
	const { storageId, options } = await partitionOfTurn(world, turnId);
	const storage = await IndexedStorage.open({ ...options, storageId });
	try {
		const records = await readCallCostRecords(createSession(storage), storage, ROOT_CONVERSATION_ID, context);
		return records.filter((record) => record.turnId === turnId);
	} finally {
		await storage.close(context);
	}
}

const remembered = new WeakMap<ChatticusWorld, Map<string, ModelCallCost[]>>();

const rememberedOf = (world: ChatticusWorld): Map<string, ModelCallCost[]> => {
	let found = remembered.get(world);
	if (found === undefined) {
		found = new Map();
		remembered.set(world, found);
	}
	return found;
};

const recordsRememberedAs = (world: ChatticusWorld, label: string): ModelCallCost[] => {
	const found = rememberedOf(world).get(label);
	assert.ok(found, `No cost records are remembered as ${label}`);
	return found;
};

Then("the session of the turn holds {int} cost record(s)", async function (this: ChatticusWorld, count: number) {
	assert.equal((await costRecordsOfTurnThroughFreshHandle(this, currentTurnOf(this))).length, count);
});

Then("the session of the turn holds {int} cost record(s) read through a fresh handle", async function (this: ChatticusWorld, count: number) {
	assert.equal((await costRecordsOfTurnThroughFreshHandle(this, currentTurnOf(this))).length, count);
});

type RecordCheck = (record: ModelCallCost) => void;

async function recordNumber(world: ChatticusWorld, number: number): Promise<ModelCallCost> {
	const records = await costRecordsOfTurnThroughFreshHandle(world, currentTurnOf(world));
	const record = records[number - 1];
	assert.ok(record, `The session holds ${records.length} cost records, not ${number}`);
	return record;
}

async function checkRecord(world: ChatticusWorld, number: number, check: RecordCheck): Promise<void> {
	check(await recordNumber(world, number));
}

Then(
	"cost record {int} of the turn is round {int} on model {string} with {int} uncached input, {int} cache read, {int} cache write and {int} output tokens",
	async function (
		this: ChatticusWorld,
		number: number,
		round: number,
		model: string,
		input: number,
		cacheRead: number,
		cacheWrite: number,
		output: number,
	) {
		await checkRecord(this, number, (record) => {
			assert.equal(record.round, round);
			assert.equal(record.model, model);
			assert.equal(record.inputTokens, input);
			assert.equal(record.cacheReadTokens, cacheRead);
			assert.equal(record.cacheWriteTokens, cacheWrite);
			assert.equal(record.outputTokens, output);
			assert.equal(record.contextTokens, input + cacheRead + cacheWrite);
		});
	},
);

Then(
	"cost record {int} of the turn costs {word} dollars under price book {string}",
	async function (this: ChatticusWorld, number: number, costUsd: string, priceBookId: string) {
		await checkRecord(this, number, (record) => {
			assert.ok(record.costUsd !== null && Decimal.parse(record.costUsd).equals(Decimal.parse(costUsd)), `cost is ${record.costUsd}, expected ${costUsd}`);
			assert.equal(record.priceBookId, priceBookId);
			assert.equal(record.unpriced, false);
		});
	},
);

Then("cost record {int} of the turn belongs to the turn", async function (this: ChatticusWorld, number: number) {
	await checkRecord(this, number, (record) => assert.equal(record.turnId, currentTurnOf(this)));
});

Then("the cost records of the turn have distinct keys per entry", async function (this: ChatticusWorld) {
	const records = await costRecordsOfTurnThroughFreshHandle(this, currentTurnOf(this));
	assert.equal(new Set(records.map((record) => record.entryId)).size, records.length);
});

When("the cost records of the turn are remembered as {string}", async function (this: ChatticusWorld, label: string) {
	rememberedOf(this).set(label, await costRecordsOfTurnThroughFreshHandle(this, currentTurnOf(this)));
});

const comparable = (record: ModelCallCost) => {
	const { conversationId: _conversation, entryId: _entry, turnId: _turn, recordedAt: _recordedAt, responseId: _response, providerCostEstimateUsd: _estimate, ...rest } = record;
	return rest;
};

Then(
	"the cost records remembered as {string} equal those remembered as {string} apart from identifiers and time",
	function (this: ChatticusWorld, left: string, right: string) {
		const leftRecords = recordsRememberedAs(this, left);
		const rightRecords = recordsRememberedAs(this, right);
		assert.ok(leftRecords.length > 0, `${left} holds no records`);
		assert.deepEqual(leftRecords.map(comparable), rightRecords.map(comparable));
	},
);

Then(
	"the cost records remembered as {string} equal those remembered as {string} exactly",
	function (this: ChatticusWorld, left: string, right: string) {
		assert.ok(recordsRememberedAs(this, left).length > 0, `${left} holds no records`);
		assert.deepEqual(recordsRememberedAs(this, left), recordsRememberedAs(this, right));
	},
);

When("a new owner of the session of the turn reads the cost records", async function (this: ChatticusWorld) {
	const turnId = currentTurnOf(this);
	const { storageId, options } = await partitionOfTurn(this, turnId);
	const owner = await openOwnerStorage(storageId, options);
	try {
		const records = await readCallCostRecords(createSession(owner.storage), owner.storage, ROOT_CONVERSATION_ID, context);
		rememberedOf(this).set("new owner", records.filter((record) => record.turnId === turnId));
	} finally {
		await owner.storage.close(context);
	}
});

type ForkScenario = { forkId: ConversationId; derived: number };
const forks = new WeakMap<ChatticusWorld, ForkScenario>();

When("the conversation of the session of the turn is forked at its last entry", async function (this: ChatticusWorld) {
	const turnId = currentTurnOf(this);
	const { storageId, options } = await partitionOfTurn(this, turnId);
	const session = await openOwnerSession(storageId, { ...options, models: createModels(), extensions: [], context });
	try {
		const root = await session.harness.root(context, { agent: { model: { provider: "openai", modelId: "scripted-model" }, thinkingLevel: "off" } });
		const last = (await root.entries({}, 50, undefined, context)).items[0];
		assert.ok(last, "The conversation has no entry to fork at");
		const fork = await root.fork(last.id, { ownership: { kind: "ownerless" } }, context);
		const prompt = await session.harness.commit((tx) => tx.submissionByRequest(root.id, `turn:${turnId}`), context);
		assert.ok(prompt?.entry !== undefined, "The turn has no prompt entry");
		const derived = await deriveCostRecordsFromEntries(
			session.harness,
			session.storage,
			{ conversationId: fork.id, turnId, promptEntryId: Number(prompt.entry), prices: priceBookOf(this), now: () => this.clock.now() },
			context,
		);
		const inherited = await session.storage.scanEntries({ conversationId: fork.id }, 100, undefined, context);
		assert.ok(
			inherited.items.some((entry) => entry.kind === AssistantEntry.kind && entry.conversationId === root.id),
			"The fork does not see the parent's entries, so the filter is not exercised",
		);
		forks.set(this, { forkId: fork.id, derived });
	} finally {
		await session.close();
	}
});

Then("deriving cost records on the fork writes {int} record(s)", function (this: ChatticusWorld, count: number) {
	const fork = forks.get(this);
	assert.ok(fork, "No fork was made");
	assert.equal(fork.derived, count);
});

Then("the fork holds {int} cost record(s)", async function (this: ChatticusWorld, count: number) {
	const fork = forks.get(this);
	assert.ok(fork, "No fork was made");
	const { storageId, options } = await partitionOfTurn(this, currentTurnOf(this));
	const storage = await IndexedStorage.open({ ...options, storageId });
	try {
		assert.equal((await readCallCostRecords(createSession(storage), storage, fork.forkId, context)).length, count);
	} finally {
		await storage.close(context);
	}
});

Then("the cost summed from the session records of the turn equals the cost on its ledger row", async function (this: ChatticusWorld) {
	const turnId = currentTurnOf(this);
	const records = await costRecordsOfTurnThroughFreshHandle(this, turnId);
	const summed = records.reduce((total, record) => total.add(Decimal.parse(record.costUsd ?? "0")), Decimal.zero());
	const row = await getVendorLedgerEntry(ledgerDependenciesFor(this), tenantOf(this), turnId);
	assert.ok(row?.costUsd, "The ledger row has no cost");
	assert.ok(row.costUsd.equals(summed), `ledger ${row.costUsd.toString()} differs from records ${summed.toString()}`);
	assert.equal(row.inputTokens, records.reduce((total, record) => total + record.contextTokens, 0));
	assert.equal(row.outputTokens, records.reduce((total, record) => total + record.outputTokens, 0));
});

Then("the turn index item of the turn names its bot, channel, prompt and owner kind {string}", async function (this: ChatticusWorld, ownerKind: string) {
	const turnId = currentTurnOf(this);
	const { turn } = await partitionOfTurn(this, turnId);
	const records = await costRecordsOfTurnThroughFreshHandle(this, turnId);
	const month = records[0]!.recordedAt.slice(0, 7);
	const key = costTurnIndexKey(turn.tenantId, month, turnId);
	const result = await this.messagingTable.client.send(
		new GetItemCommand({ TableName: this.messagingTable.tableName, Key: { pk: { S: key.pk }, sk: { S: key.sk } }, ConsistentRead: true }),
	);
	const item = result.Item;
	assert.ok(item, `No turn index item exists at ${key.pk} / ${key.sk}`);
	assert.equal(item.bot_id?.S, turn.botId);
	assert.equal(item.channel_id?.S, turn.channelId);
	assert.equal(item.prompt_author_id?.S, turn.promptAuthorId ?? undefined);
	assert.equal(item.prompt_message_seq?.N, turn.promptMessageSeq === null ? undefined : String(turn.promptMessageSeq));
	assert.equal(item.owner_kind?.S, ownerKind);
	assert.equal(item.record_count?.N, String(records.length));
	assert.equal(item.status?.S, "completed");
	assert.ok(item.message_seq?.N, "The completed turn's index item names the reply's message sequence");
});

Then("the gateway observations of the turn equal the tokens of its session cost records", async function (this: ChatticusWorld) {
	const turnId = currentTurnOf(this);
	const records = await costRecordsOfTurnThroughFreshHandle(this, turnId);
	const observed = gatewayScenarioOf(this).logEvents.filter((event) => event.event === "usage_observed" && event.turnId === turnId);
	assert.ok(observed.length > 0, "The gateway observed no usage for the turn");
	assert.equal(observed.length, records.length, "The gateway saw a different number of calls than the session recorded");
	assert.equal(
		observed.reduce((total, event) => total + (event.inputTokens ?? 0), 0),
		records.reduce((total, record) => total + record.contextTokens, 0),
	);
	assert.equal(
		observed.reduce((total, event) => total + (event.outputTokens ?? 0), 0),
		records.reduce((total, record) => total + record.outputTokens, 0),
	);
});

Given("the model holds its second request", function (this: ChatticusWorld) {
	const scenario = modelScenarioOf(this);
	scenario.scripted.slow().release();
	scenario.hold = scenario.scripted.slow();
});

When("the model is waiting on its second request", async function (this: ChatticusWorld) {
	const hold = modelScenarioOf(this).hold;
	assert.ok(hold, "The model holds no request");
	await hold.reached;
});

When(
	"the worker of bot {string} with model {string} crashes after the model answered and before recording its cost",
	async function (this: ChatticusWorld, name: string, model: string) {
		this.faultPlan.arm("completion_append", "before");
		await assert.rejects(runBotTurn(this, name, model), SimulatedCrash);
		assert.deepEqual(this.faultPlan.crashedAt, { boundary: "completion_append", window: "before" });
		this.faultPlan.clear();
	},
);
