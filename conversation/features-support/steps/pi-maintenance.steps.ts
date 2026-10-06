import assert from "node:assert/strict";
import { Agent } from "node:http";
import {
	DeleteItemCommand,
	DynamoDBClient,
	TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { After, Given, Then, When } from "@cucumber/cucumber";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, EntryId, StorageWrite } from "@earendil-works/pi-durable";
import { chatticusExtensions } from "../../src/pi/extension.ts";
import { type OwnerSession, openOwnerSession, openOwnerStorage } from "../../src/pi/session.ts";
import { type SweepResult, sweepAllStorages, sweepOrphans, type SweeperDependencies } from "../../src/pi/sweeper.ts";
import { IndexedStorage, type SnapshotPolicy } from "../../src/storage/indexed-storage.ts";
import {
	commitKey,
	commitPrefix,
	snapshotPrefix,
	storageIdFor,
} from "../../src/storage/storage-support.ts";
import { FakeClock } from "../clock.ts";
import { ensurePiStorage } from "../pi-storage.ts";
import type { ChatticusWorld } from "../world.ts";

const DEFAULT_SESSION = "ada";
const DEFAULT_CHANNEL = "general";
const MINUTE_SECONDS = 60;
const DAY_SECONDS = 86_400;
const HISTORY_STEP_TIMEOUT_MILLISECONDS = 120_000;

type DynamoMode = "pass" | "crash" | "hold";

/** A DynamoDB client whose index transaction can be made to crash or to wait, to stage commits that stop half way. */
type StagedDynamo = {
	client: DynamoDBClient;
	mode: DynamoMode;
	release(): void;
};

type SessionState = {
	owners: Map<number, { storage: IndexedStorage; fence: number }>;
	conversationId: ConversationId | undefined;
	notes: number;
};

type ColdRead = { reads: number; messages: string[]; raw: string };

type Maintenance = {
	dynamo: DynamoDBClient;
	clock: FakeClock;
	graceMilliseconds: number;
	staged: StagedDynamo;
	s3: S3Client;
	getReads: { keys: string[] };
	sessions: Map<string, SessionState>;
	held: Promise<unknown> | undefined;
	lastSweep: (SweepResult & { storages?: number }) | undefined;
	faux: FauxProviderHandle | undefined;
	coldReads: ColdRead[];
	coldOwner: OwnerSession | undefined;
	coldAnswer: string | undefined;
};

const scenarios = new WeakMap<ChatticusWorld, Maintenance>();

const scenarioOf = (world: ChatticusWorld): Maintenance => {
	const scenario = scenarios.get(world);
	assert.ok(scenario, "the Pi session store has not been created in this scenario");
	return scenario;
};

const storageIdOf = (world: ChatticusWorld, session: string): string => storageIdFor(world.tenantId, session, DEFAULT_CHANNEL);

function stagedDynamo(real: DynamoDBClient): StagedDynamo {
	let releaseGate: () => void = () => undefined;
	const state: StagedDynamo = {
		client: real,
		mode: "pass",
		release: () => releaseGate(),
	};

	const proxy = new Proxy(real, {
		get(target, property) {
			if (property === "send") {
				return async (command: unknown) => {
					if (command instanceof TransactWriteItemsCommand) {
						if (state.mode === "crash") {
							throw Object.assign(new Error("simulated crash before the index transaction"), { name: "SimulatedCrash" });
						}
						if (state.mode === "hold") {
							await new Promise<void>((resolve) => {
								releaseGate = resolve;
							});
						}
					}
					return (target.send as (command: unknown) => Promise<unknown>).call(target, command);
				};
			}
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	state.client = proxy;
	return state;
}

function countingS3(real: S3Client, getReads: { keys: string[] }): S3Client {
	return new Proxy(real, {
		get(target, property) {
			if (property === "send") {
				return (command: unknown) => {
					if (command instanceof GetObjectCommand) getReads.keys.push(command.input.Key ?? "");
					return (target.send as (command: unknown) => Promise<unknown>).call(target, command);
				};
			}
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

async function listKeys(s3: S3Client, bucket: string, prefix: string): Promise<string[]> {
	const keys: string[] = [];
	let continuation: string | undefined;
	do {
		const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuation }));
		for (const object of page.Contents ?? []) keys.push(object.Key!);
		continuation = page.NextContinuationToken;
	} while (continuation !== undefined);
	return keys;
}

const sessionOf = (scenario: Maintenance, session: string): SessionState => {
	let state = scenario.sessions.get(session);
	if (state === undefined) {
		state = { owners: new Map(), conversationId: undefined, notes: 0 };
		scenario.sessions.set(session, state);
	}
	return state;
};

async function ensureOwner(
	world: ChatticusWorld,
	session: string,
	ownerNumber: number,
): Promise<{ storage: IndexedStorage; fence: number }> {
	const scenario = scenarioOf(world);
	const state = sessionOf(scenario, session);
	const existing = state.owners.get(ownerNumber);
	if (existing !== undefined) return existing;
	const piStorage = await ensurePiStorage(world);
	const owner = await openOwnerStorage(storageIdOf(world, session), {
		client: scenario.staged.client,
		s3: scenario.s3,
		tableName: piStorage.tableName,
		bucket: piStorage.bucket,
	});
	assert.equal(owner.fence, ownerNumber, `owner ${ownerNumber} was allocated fence ${owner.fence}`);
	state.owners.set(ownerNumber, owner);
	return owner;
}

async function commitNote(world: ChatticusWorld, session: string, ownerNumber: number): Promise<void> {
	const scenario = scenarioOf(world);
	const state = sessionOf(scenario, session);
	const { storage } = await ensureOwner(world, session, ownerNumber);
	const writes = await noteWrites(storage, state);
	await storage.commit(writes, BACKGROUND_CONTEXT);
	state.notes += 1;
}

async function noteWrites(storage: IndexedStorage, state: SessionState): Promise<StorageWrite[]> {
	const writes: StorageWrite[] = [];
	if (state.conversationId === undefined) {
		const conversationId = await storage.mintId<ConversationId>();
		state.conversationId = conversationId;
		writes.push({ type: "conversation", value: { id: conversationId } });
	}
	const entryId = await storage.mintId<EntryId>();
	writes.push({
		type: "entry",
		value: { id: entryId, conversationId: state.conversationId, kind: "note", data: { text: `note ${state.notes + 1}` } },
	});
	return writes;
}

async function readNotes(world: ChatticusWorld, session: string): Promise<string[]> {
	const scenario = scenarioOf(world);
	const piStorage = await ensurePiStorage(world);
	const state = sessionOf(scenario, session);
	assert.ok(state.conversationId !== undefined, `the session ${session} has no conversation`);
	const reader = await IndexedStorage.open({
		client: scenario.staged.client,
		s3: scenario.s3,
		tableName: piStorage.tableName,
		bucket: piStorage.bucket,
		storageId: storageIdOf(world, session),
	});
	const page = await reader.scanEntries({ conversationId: state.conversationId }, 1000, undefined, BACKGROUND_CONTEXT);
	return page.items.map((entry) => (entry.data as { text: string }).text).reverse();
}

async function sweeperDependencies(world: ChatticusWorld): Promise<SweeperDependencies> {
	const scenario = scenarioOf(world);
	const piStorage = await ensurePiStorage(world);
	return {
		client: scenario.staged.client,
		s3: scenario.s3,
		tableName: piStorage.tableName,
		bucket: piStorage.bucket,
		clock: scenario.clock,
		graceMilliseconds: scenario.graceMilliseconds,
	};
}

Given("a fresh Pi session store", async function (this: ChatticusWorld) {
	const piStorage = await ensurePiStorage(this);
	const getReads = { keys: [] as string[] };
	const dynamo = new DynamoDBClient({
		endpoint: process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5555",
		region: "us-east-1",
		credentials: { accessKeyId: "test", secretAccessKey: "test" },
		maxAttempts: 1,
		requestHandler: { httpAgent: new Agent({ keepAlive: true, maxSockets: 32 }) },
	});
	scenarios.set(this, {
		dynamo,
		clock: new FakeClock(new Date()),
		graceMilliseconds: 10 * MINUTE_SECONDS * 1000,
		staged: stagedDynamo(dynamo),
		s3: countingS3(piStorage.s3, getReads),
		getReads,
		sessions: new Map(),
		held: undefined,
		lastSweep: undefined,
		faux: undefined,
		coldReads: [],
		coldOwner: undefined,
		coldAnswer: undefined,
	});
});

Given("the sweeper leaves objects alone for {int} minutes", function (this: ChatticusWorld, minutes: number) {
	scenarioOf(this).graceMilliseconds = minutes * MINUTE_SECONDS * 1000;
});

Given(
	"owner {int} of the session {string} has committed {int} note(s)",
	async function (this: ChatticusWorld, ownerNumber: number, session: string, count: number) {
		for (let index = 0; index < count; index++) await commitNote(this, session, ownerNumber);
	},
);

Given(
	"owner {int} of the session {string} crashes after writing the object of its next commit and before the index transaction",
	async function (this: ChatticusWorld, ownerNumber: number, session: string) {
		const scenario = scenarioOf(this);
		const state = sessionOf(scenario, session);
		const { storage } = await ensureOwner(this, session, ownerNumber);
		const writes = await noteWrites(storage, state);
		scenario.staged.mode = "crash";
		try {
			await assert.rejects(storage.commit(writes, BACKGROUND_CONTEXT), (error: Error) => error.name === "SimulatedCrash");
		} finally {
			scenario.staged.mode = "pass";
		}
	},
);

Given("owner {int} takes over the session {string}", async function (this: ChatticusWorld, ownerNumber: number, session: string) {
	await ensureOwner(this, session, ownerNumber);
});

Given(
	"a stray commit object is written at sequence {int} under fence {int} in the session {string}",
	async function (this: ChatticusWorld, seq: number, fence: number, session: string) {
		const scenario = scenarioOf(this);
		const piStorage = await ensurePiStorage(this);
		await scenario.s3.send(
			new PutObjectCommand({
				Bucket: piStorage.bucket,
				Key: commitKey(storageIdOf(this, session), seq, fence),
				Body: JSON.stringify({ seq, fence, token: "stray", writes: [] }),
				ContentType: "application/json",
			}),
		);
	},
);

Given(
	"owner {int} of the session {string} has started its next commit with the index transaction held back",
	async function (this: ChatticusWorld, ownerNumber: number, session: string) {
		const scenario = scenarioOf(this);
		const piStorage = await ensurePiStorage(this);
		const state = sessionOf(scenario, session);
		const { storage } = await ensureOwner(this, session, ownerNumber);
		const writes = await noteWrites(storage, state);
		const expectedKey = commitKey(storageIdOf(this, session), state.notes + 1, ownerNumber);
		scenario.staged.mode = "hold";
		scenario.held = storage.commit(writes, BACKGROUND_CONTEXT);
		scenario.held.catch(() => undefined);
		const deadline = Date.now() + 10_000;
		while (!(await listKeys(scenario.s3, piStorage.bucket, commitPrefix(storageIdOf(this, session)))).includes(expectedKey)) {
			assert.ok(Date.now() < deadline, "the held commit never wrote its object");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	},
);

When("{int} minutes pass", function (this: ChatticusWorld, minutes: number) {
	scenarioOf(this).clock.advanceSeconds(minutes * MINUTE_SECONDS);
});

When("{int} days pass", function (this: ChatticusWorld, days: number) {
	scenarioOf(this).clock.advanceSeconds(days * DAY_SECONDS);
});

When("the sweeper sweeps the session {string}", async function (this: ChatticusWorld, session: string) {
	scenarioOf(this).lastSweep = await sweepOrphans(await sweeperDependencies(this), storageIdOf(this, session));
});

When("the sweeper sweeps the session", async function (this: ChatticusWorld) {
	scenarioOf(this).lastSweep = await sweepOrphans(await sweeperDependencies(this), storageIdOf(this, DEFAULT_SESSION));
});

When("the sweeper sweeps every session", async function (this: ChatticusWorld) {
	scenarioOf(this).lastSweep = await sweepAllStorages(await sweeperDependencies(this));
});

When("the held index transaction is released", function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	scenario.staged.mode = "pass";
	scenario.staged.release();
});

Then("the held commit completes", async function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	assert.ok(scenario.held, "no commit was held");
	await scenario.held;
	sessionOf(scenario, DEFAULT_SESSION).notes += 1;
});

Then("the sweeper deleted {int} object(s)", function (this: ChatticusWorld, expected: number) {
	assert.equal(scenarioOf(this).lastSweep?.deleted, expected);
});

Then("the sweeper deleted {int} objects across {int} sessions", function (this: ChatticusWorld, expected: number, storages: number) {
	const sweep = scenarioOf(this).lastSweep;
	assert.equal(sweep?.deleted, expected);
	assert.equal(sweep?.storages, storages);
});

const commitObjectExists = async (world: ChatticusWorld, seq: number, ownerNumber: number, session: string): Promise<boolean> => {
	const piStorage = await ensurePiStorage(world);
	const keys = await listKeys(scenarioOf(world).s3, piStorage.bucket, commitPrefix(storageIdOf(world, session)));
	return keys.includes(commitKey(storageIdOf(world, session), seq, ownerNumber));
};

Then(
	"the commit object of sequence {int} written by owner {int} of the session {string} no longer exists",
	async function (this: ChatticusWorld, seq: number, ownerNumber: number, session: string) {
		assert.equal(await commitObjectExists(this, seq, ownerNumber, session), false);
	},
);

Then(
	"the commit object of sequence {int} written by owner {int} of the session {string} still exists",
	async function (this: ChatticusWorld, seq: number, ownerNumber: number, session: string) {
		assert.equal(await commitObjectExists(this, seq, ownerNumber, session), true);
	},
);

Then("the session {string} still has {int} commit objects", async function (this: ChatticusWorld, session: string, expected: number) {
	const piStorage = await ensurePiStorage(this);
	const keys = await listKeys(scenarioOf(this).s3, piStorage.bucket, commitPrefix(storageIdOf(this, session)));
	assert.equal(keys.length, expected);
});

Then(
	"a cold reader reads the notes {string} and {string} in the session {string}",
	async function (this: ChatticusWorld, first: string, second: string, session: string) {
		assert.deepEqual(await readNotes(this, session), [first, second]);
	},
);

Then("a cold reader reads {int} note(s) in the session {string}", async function (this: ChatticusWorld, count: number, session: string) {
	const expected = Array.from({ length: count }, (_, index) => `note ${index + 1}`);
	assert.deepEqual(await readNotes(this, session), expected);
});

type ConversationOwnerPolicy = SnapshotPolicy | undefined;

const messageTexts = (messages: readonly { role: string; content: unknown }[]): string[] =>
	messages.filter((message) => message.role !== "system").map((message) => {
		const content = message.content;
		const text =
			typeof content === "string"
				? content
				: (content as { type: string; text?: string }[]).map((part) => (part.type === "text" ? part.text : "")).join("");
		return `${message.role}: ${text}`;
	});

const expectedConversation = (turns: number): string[] =>
	Array.from({ length: turns }, (_, index) => [`user: question ${index + 1}`, `assistant: answer ${index + 1}`]).flat();

Given("a scripted bot that answers question N with {string}", function (this: ChatticusWorld, pattern: string) {
	assert.equal(pattern, "answer N");
	const scenario = scenarioOf(this);
	const faux = fauxProvider({ models: [{ id: "faux-model" }] });
	faux.setResponses(Array.from({ length: 80 }, (_, index) => () => fauxAssistantMessage(`answer ${index + 1}`)));
	scenario.faux = faux;
});

async function openConversationOwner(world: ChatticusWorld, policy: ConversationOwnerPolicy): Promise<OwnerSession> {
	const scenario = scenarioOf(world);
	const piStorage = await ensurePiStorage(world);
	assert.ok(scenario.faux, "no scripted bot");
	const models = createModels();
	models.setProvider(scenario.faux.provider);
	return openOwnerSession(storageIdOf(world, DEFAULT_SESSION), {
		client: scenario.staged.client,
		s3: scenario.s3,
		tableName: piStorage.tableName,
		bucket: piStorage.bucket,
		models,
		extensions: chatticusExtensions({ systemPrompt: () => "You are Ada." }),
		context: BACKGROUND_CONTEXT,
		snapshotPolicy: policy,
	});
}

async function ask(world: ChatticusWorld, owner: OwnerSession, questionNumber: number): Promise<string> {
	const scenario = scenarioOf(world);
	assert.ok(scenario.faux, "no scripted bot");
	const agent = { model: { provider: scenario.faux.provider.id, modelId: "faux-model" }, thinkingLevel: "off" as const };
	const root = await owner.harness.root(BACKGROUND_CONTEXT, { agent });
	await root.configure(agent, BACKGROUND_CONTEXT);
	const submission = await root.submit(
		{ type: "input", content: `question ${questionNumber}`, requestId: `question-${questionNumber}` },
		BACKGROUND_CONTEXT,
	);
	const settled = await submission.wait(BACKGROUND_CONTEXT);
	if (settled.type !== "input" || settled.status === "unanswered") throw new Error(`question ${questionNumber} was not answered`);
	const view = await root.context(BACKGROUND_CONTEXT);
	const last = messageTexts(view.messages as never).at(-1);
	assert.ok(last !== undefined && last.startsWith("assistant: "), "the last message is not an answer");
	return last.slice("assistant: ".length);
}

const historyOwnerPolicies: Record<string, ConversationOwnerPolicy> = {
	"never writes snapshots": undefined,
	"writes a snapshot when it closes": { atClose: true },
	"writes a snapshot every 10 commits": { everyCommits: 10 },
};

const turnsHeld = new WeakMap<ChatticusWorld, number>();

async function holdTurns(world: ChatticusWorld, policyName: string, turns: number): Promise<void> {
	const policy = historyOwnerPolicies[policyName];
	assert.ok(policyName in historyOwnerPolicies, `unknown owner kind: ${policyName}`);
	const owner = await openConversationOwner(world, policy);
	const first = (turnsHeld.get(world) ?? 0) + 1;
	for (let question = first; question < first + turns; question++) await ask(world, owner, question);
	turnsHeld.set(world, first + turns - 1);
	await owner.close();
}

Given(
	/^an owner who (never writes snapshots|writes a snapshot when it closes|writes a snapshot every 10 commits) holds a conversation of (\d+) turns$/,
	{ timeout: HISTORY_STEP_TIMEOUT_MILLISECONDS },
	async function (this: ChatticusWorld, policyName: string, turns: string) {
		await holdTurns(this, policyName, Number(turns));
	},
);

Given(
	/^an owner who (never writes snapshots|writes a snapshot when it closes|writes a snapshot every 10 commits) continues the conversation for (\d+) turns$/,
	{ timeout: HISTORY_STEP_TIMEOUT_MILLISECONDS },
	async function (this: ChatticusWorld, policyName: string, turns: string) {
		await holdTurns(this, policyName, Number(turns));
	},
);

async function coldRead(world: ChatticusWorld): Promise<ColdRead> {
	const scenario = scenarioOf(world);
	scenario.getReads.keys.length = 0;
	const owner = await openConversationOwner(world, undefined);
	assert.ok(scenario.faux, "no scripted bot");
	const agent = { model: { provider: scenario.faux.provider.id, modelId: "faux-model" }, thinkingLevel: "off" as const };
	const root = await owner.harness.root(BACKGROUND_CONTEXT, { agent });
	const view = await root.context(BACKGROUND_CONTEXT);
	const reads = scenario.getReads.keys.length;
	scenario.coldOwner = owner;
	const read: ColdRead = {
		reads,
		messages: messageTexts(view.messages as never),
		raw: JSON.stringify(view.messages),
	};
	scenario.coldReads.push(read);
	return read;
}

When("a cold owner opens the session and reads the conversation", async function (this: ChatticusWorld) {
	await coldRead(this);
	await scenarioOf(this).coldOwner?.close();
});

When("the snapshot is withdrawn from the session", async function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	const piStorage = await ensurePiStorage(this);
	await scenario.staged.client.send(
		new DeleteItemCommand({
			TableName: piStorage.tableName,
			Key: { pk: { S: `PI#${storageIdOf(this, DEFAULT_SESSION)}` }, sk: { S: "SNAPSHOT" } },
		}),
	);
});

When("a cold owner opens the session and sends question {int}", async function (this: ChatticusWorld, question: number) {
	const scenario = scenarioOf(this);
	const owner = await openConversationOwner(this, undefined);
	scenario.coldAnswer = await ask(this, owner, question);
	await owner.close();
});

Then("the cold owner made more than {int} object reads", function (this: ChatticusWorld, floor: number) {
	const read = scenarioOf(this).coldReads.at(-1);
	assert.ok(read, "no cold read was made");
	assert.ok(read.reads > floor, `expected more than ${floor} object reads, got ${read.reads}`);
});

Then("the cold owner made at most {int} object reads", function (this: ChatticusWorld, ceiling: number) {
	const read = scenarioOf(this).coldReads.at(-1);
	assert.ok(read, "no cold read was made");
	assert.ok(read.reads <= ceiling, `expected at most ${ceiling} object reads, got ${read.reads}`);
});

Then("the cold owner read all {int} questions and answers in order", async function (this: ChatticusWorld, turns: number) {
	const scenario = scenarioOf(this);
	const read = scenario.coldReads.length > 0 ? scenario.coldReads.at(-1)! : await coldRead(this);
	assert.deepEqual(read.messages, expectedConversation(turns));
});

Then("the cold owner receives {string}", function (this: ChatticusWorld, expected: string) {
	assert.equal(scenarioOf(this).coldAnswer, expected);
});

Then("a second cold owner reads all {int} questions and answers in order", async function (this: ChatticusWorld, turns: number) {
	const read = await coldRead(this);
	await scenarioOf(this).coldOwner?.close();
	assert.deepEqual(read.messages, expectedConversation(turns));
});

Then("the first cold read made fewer object reads than the second", function (this: ChatticusWorld) {
	const [first, second] = scenarioOf(this).coldReads;
	assert.ok(first && second, "two cold reads were not made");
	assert.ok(first.reads < second.reads, `first read ${first.reads} objects, second ${second.reads}`);
});

Then("both cold reads show the model exactly the same messages", function (this: ChatticusWorld) {
	const [first, second] = scenarioOf(this).coldReads;
	assert.ok(first && second, "two cold reads were not made");
	assert.equal(first.raw, second.raw);
});

Given("the session has more than {int} snapshot object", async function (this: ChatticusWorld, floor: number) {
	const piStorage = await ensurePiStorage(this);
	const keys = await listKeys(scenarioOf(this).s3, piStorage.bucket, snapshotPrefix(storageIdOf(this, DEFAULT_SESSION)));
	assert.ok(keys.length > floor, `expected more than ${floor} snapshot objects, found ${keys.length}`);
});

Then("the session has exactly {int} snapshot object", async function (this: ChatticusWorld, expected: number) {
	const piStorage = await ensurePiStorage(this);
	const keys = await listKeys(scenarioOf(this).s3, piStorage.bucket, snapshotPrefix(storageIdOf(this, DEFAULT_SESSION)));
	assert.equal(keys.length, expected);
});

Then(
	"a cold owner opens the session and reads the conversation with at most {int} object reads",
	async function (this: ChatticusWorld, ceiling: number) {
		const read = await coldRead(this);
		await scenarioOf(this).coldOwner?.close();
		assert.ok(read.reads <= ceiling, `expected at most ${ceiling} object reads, got ${read.reads}`);
		assert.deepEqual(read.messages, expectedConversation(turnsHeld.get(this) ?? 0));
	},
);

After(function (this: ChatticusWorld) {
	scenarios.get(this)?.dynamo.destroy();
});
