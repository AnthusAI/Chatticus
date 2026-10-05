import assert from "node:assert/strict";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { defineParameterType, Given, Then, When } from "@cucumber/cucumber";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxProviderHandle, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Conversation, Submission } from "@earendil-works/pi-durable";
import {
	appendLine,
	attributedWriteEntryDraft,
	type ChannelLogLine,
	readEntryBody,
	readLog,
	reconcileInputLine,
	writeAttributedMessage,
} from "../../src/pi/channel-log.ts";
import { listChannelMessages, type ListedMessage } from "../../src/pi/channel-listing.ts";
import { chatticusExtensions } from "../../src/pi/extension.ts";
import { allocateSeq, drain, list, type MailboxItem, type MailboxStore, put } from "../../src/pi/mailbox.ts";
import { type OwnerSession, openOwnerSession } from "../../src/pi/session.ts";
import { IndexedStorage } from "../../src/storage/indexed-storage.ts";
import { storageIdFor } from "../../src/storage/storage-support.ts";
import type { ChatticusWorld } from "../world.ts";

defineParameterType({
	name: "numbers",
	regexp: /\d+(?:(?:, | and )\d+)*/,
	transformer: (text: string) => text.match(/\d+/g)?.map(Number) ?? [],
});

defineParameterType({
	name: "listing",
	regexp: /\d+ from "[^"]+" saying "[^"]+"(?: and \d+ from "[^"]+" saying "[^"]+")*/,
	transformer: (text: string) =>
		[...text.matchAll(/(\d+) from "([^"]+)" saying "([^"]+)"/g)].map(
			(match) => [Number(match[1]), match[2], match[3]] as [number, string, string],
		),
});

const endpoint = process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5555";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };
const dynamo = new DynamoDBClient({ endpoint, region: "us-east-1", credentials, maxAttempts: 1 });
const s3 = new S3Client({ endpoint, region: "us-east-1", credentials, forcePathStyle: true, maxAttempts: 1 });
const CONVERSATIONS_TABLE = "Conversations";
const BUCKET = "PiSessions";

type Draft = {
	seq: number;
	messageId: string;
	authorKind: string;
	authorId: string;
	addressedToBotId: string | null;
	createdAt: string;
	body: string;
};

type MailboxScenario = {
	faux: FauxProviderHandle;
	modelCalls: number;
	requestTexts: string[];
	numbers: number[];
	owners: Map<string, OwnerSession>;
	roots: Map<string, Conversation>;
	currentBot: string;
	currentChannel: string;
	listedNumbers: number[];
	putError: Error | null;
	drainError: Error | null;
	submissions: Submission[];
	submittedDrafts: Map<number, Draft>;
	answers: string[];
	readSeqs: ChannelLogLine[];
	listed: ListedMessage[];
	gate: { release: () => void; promise: Promise<void> };
};

const scenarios = new WeakMap<ChatticusWorld, MailboxScenario>();

const scenarioOf = (world: ChatticusWorld): MailboxScenario => {
	const existing = scenarios.get(world);
	if (existing) return existing;
	let release: () => void = () => undefined;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	const created: MailboxScenario = {
		faux: fauxProvider({ models: [{ id: "faux-model" }] }),
		modelCalls: 0,
		requestTexts: [],
		numbers: [],
		owners: new Map(),
		roots: new Map(),
		currentBot: "",
		currentChannel: "",
		listedNumbers: [],
		putError: null,
		drainError: null,
		submissions: [],
		submittedDrafts: new Map(),
		answers: [],
		readSeqs: [],
		listed: [],
		gate: { release, promise },
	};
	scenarios.set(world, created);
	return created;
};

const mailboxStoreOf = (world: ChatticusWorld): MailboxStore => ({
	client: world.messagingTable.client,
	tableName: world.messagingTable.tableName,
});

const createdAtFor = (seq: number): string => new Date(Date.UTC(2026, 9, 5, 10, 0, seq)).toISOString();

const draftFor = (seq: number, authorId: string, body: string, addressedToBotId: string | null = null): Draft => ({
	seq,
	messageId: `m-${seq}`,
	authorKind: authorId === "ryan" ? "human" : "bot",
	authorId,
	addressedToBotId,
	createdAt: createdAtFor(seq),
	body,
});

const mailboxItemFor = (world: ChatticusWorld, botId: string, channelId: string, draft: Draft): MailboxItem => ({
	tenantId: world.tenantId,
	botId,
	channelId,
	seq: draft.seq,
	messageId: draft.messageId,
	authorKind: draft.authorKind,
	authorId: draft.authorId,
	addressedToBotId: draft.addressedToBotId,
	body: draft.body,
	createdAt: draft.createdAt,
});

const openReadOnly = (world: ChatticusWorld, botId: string, channelId: string): Promise<IndexedStorage> =>
	IndexedStorage.open({
		client: dynamo,
		s3,
		tableName: CONVERSATIONS_TABLE,
		bucket: BUCKET,
		storageId: storageIdFor(world.tenantId, botId, channelId),
	});

const agentFor = (scenario: MailboxScenario) => ({
	model: { provider: scenario.faux.provider.id, modelId: "faux-model" },
	thinkingLevel: "off" as const,
});

const ownerKey = (botId: string, channelId: string): string => `${botId}#${channelId}`;

const openOwner = async (world: ChatticusWorld, botId: string, channelId: string): Promise<Conversation> => {
	const scenario = scenarioOf(world);
	const key = ownerKey(botId, channelId);
	const known = scenario.roots.get(key);
	if (known) {
		scenario.currentBot = botId;
		scenario.currentChannel = channelId;
		return known;
	}
	const models = createModels();
	models.setProvider(scenario.faux.provider);
	const owner = await openOwnerSession(storageIdFor(world.tenantId, botId, channelId), {
		client: dynamo,
		s3,
		tableName: CONVERSATIONS_TABLE,
		bucket: BUCKET,
		models,
		extensions: chatticusExtensions({ systemPrompt: () => `You are ${botId}.` }),
		context: BACKGROUND_CONTEXT,
	});
	const agent = agentFor(scenario);
	const root = await owner.harness.root(BACKGROUND_CONTEXT, { agent });
	await root.configure(agent, BACKGROUND_CONTEXT);
	scenario.owners.set(key, owner);
	scenario.roots.set(key, root);
	scenario.currentBot = botId;
	scenario.currentChannel = channelId;
	return root;
};

const currentRoot = (world: ChatticusWorld): Conversation => {
	const scenario = scenarioOf(world);
	const root = scenario.roots.get(ownerKey(scenario.currentBot, scenario.currentChannel));
	assert.ok(root, "no owner holds a session in this scenario");
	return root;
};

const countingResponse = (scenario: MailboxScenario, text: string) => (context: unknown) => {
	scenario.modelCalls += 1;
	scenario.requestTexts.push(JSON.stringify(context));
	return fauxAssistantMessage(text);
};

const lineFor = (seq: number, draft: Draft | undefined, authorId: string, addressed: string | null): Omit<Draft, "body"> => ({
	seq,
	messageId: draft?.messageId ?? `m-${seq}`,
	authorKind: authorId === "ryan" ? "human" : "bot",
	authorId,
	addressedToBotId: addressed,
	createdAt: createdAtFor(seq),
});

When("{int} messages are numbered in channel {string}", async function (this: ChatticusWorld, count: number, channel: string) {
	const scenario = scenarioOf(this);
	for (let index = 0; index < count; index += 1) {
		scenario.numbers.push(await allocateSeq(mailboxStoreOf(this), this.tenantId, channel));
	}
});

When(
	"{int} messages are numbered at the same time in channel {string}",
	async function (this: ChatticusWorld, count: number, channel: string) {
		const scenario = scenarioOf(this);
		const store = mailboxStoreOf(this);
		scenario.numbers = await Promise.all(Array.from({ length: count }, () => allocateSeq(store, this.tenantId, channel)));
	},
);

Then("the numbers are {numbers}", function (this: ChatticusWorld, expected: number[]) {
	assert.deepEqual([...scenarioOf(this).numbers].sort((left, right) => left - right), expected);
});

Given(
	"mailbox messages {numbers} for bot {string} in channel {string}",
	async function (this: ChatticusWorld, numbers: number[], bot: string, channel: string) {
		for (const seq of numbers) {
			await put(mailboxStoreOf(this), mailboxItemFor(this, bot, channel, draftFor(seq, "ryan", `body ${seq}`, bot)));
		}
	},
);

When(
	"a different message is put at number {int} in the mailbox of bot {string} in channel {string}",
	async function (this: ChatticusWorld, seq: number, bot: string, channel: string) {
		const draft = { ...draftFor(seq, "ryan", "other", bot), messageId: "someone-else" };
		await put(mailboxStoreOf(this), mailboxItemFor(this, bot, channel, draft)).catch((error: Error) => {
			scenarioOf(this).putError = error;
		});
	},
);

Then("the mailbox put fails because that number is taken", function (this: ChatticusWorld) {
	assert.match(scenarioOf(this).putError?.message ?? "", /already holds a different message/);
});

When(
	"the mailbox of bot {string} in channel {string} is listed after message {int}",
	async function (this: ChatticusWorld, bot: string, channel: string, after: number) {
		const items = await list(mailboxStoreOf(this), this.tenantId, bot, channel, after);
		scenarioOf(this).listedNumbers = items.map((item) => item.seq);
	},
);

Then("the listed message numbers are {numbers}", function (this: ChatticusWorld, expected: number[]) {
	assert.deepEqual(scenarioOf(this).listedNumbers, expected);
});

Then(
	"the mailbox of bot {string} in channel {string} holds {int} message(s)",
	async function (this: ChatticusWorld, bot: string, channel: string, count: number) {
		assert.equal((await list(mailboxStoreOf(this), this.tenantId, bot, channel)).length, count);
	},
);

Then(
	"the mailbox of bot {string} in channel {string} holds messages {numbers}",
	async function (this: ChatticusWorld, bot: string, channel: string, expected: number[]) {
		const items = await list(mailboxStoreOf(this), this.tenantId, bot, channel);
		assert.deepEqual(
			items.map((item) => item.seq),
			expected,
		);
	},
);

When(
	"the mailbox of bot {string} in channel {string} is drained and handling message {int} fails",
	async function (this: ChatticusWorld, bot: string, channel: string, failing: number) {
		await drain(mailboxStoreOf(this), this.tenantId, bot, channel, async (item) => {
			if (item.seq === failing) throw new Error(`handling message ${failing} failed`);
		}).catch((error: Error) => {
			scenarioOf(this).drainError = error;
		});
		assert.ok(scenarioOf(this).drainError, "the drain should have stopped on the failing handler");
	},
);

When(
	"the mailbox of bot {string} in channel {string} is drained successfully",
	async function (this: ChatticusWorld, bot: string, channel: string) {
		await drain(mailboxStoreOf(this), this.tenantId, bot, channel, async () => undefined);
	},
);

Given(
	"an owner holds the session of bot {string} in channel {string}",
	async function (this: ChatticusWorld, bot: string, channel: string) {
		await openOwner(this, bot, channel);
	},
);

Given("the bot {string} answers {string}", function (this: ChatticusWorld, _bot: string, reply: string) {
	const scenario = scenarioOf(this);
	scenario.faux.setResponses(Array.from({ length: 4 }, () => countingResponse(scenario, reply)));
});

Given("the bot {string} is busy with a tool round", function (this: ChatticusWorld, _bot: string) {
	const scenario = scenarioOf(this);
	scenario.faux.setResponses([
		async (context: unknown) => {
			scenario.modelCalls += 1;
			scenario.requestTexts.push(JSON.stringify(context));
			await scenario.gate.promise;
			return fauxAssistantMessage([fauxToolCall("note_to_channel", { note: "working" })]);
		},
		countingResponse(scenario, "Report in metric units"),
	]);
});

When(
	"the owner writes message {int} from human {string} saying {string}",
	async function (this: ChatticusWorld, seq: number, author: string, body: string) {
		await writeAttributedMessage(currentRoot(this), draftFor(seq, author, body));
	},
);

When(
	"the owner submits message {int} from human {string} saying {string} as a write",
	async function (this: ChatticusWorld, seq: number, author: string, body: string) {
		const scenario = scenarioOf(this);
		const draft = draftFor(seq, author, body);
		scenario.submittedDrafts.set(seq, draft);
		const submission = await currentRoot(this).submit(
			{ type: "write", entry: attributedWriteEntryDraft(draft), requestId: `msg:${draft.messageId}` },
			BACKGROUND_CONTEXT,
		);
		scenario.submissions.push(submission);
		await submission.wait(BACKGROUND_CONTEXT);
	},
);

When(
	"the owner starts message {int} from human {string} saying {string} as an input",
	async function (this: ChatticusWorld, seq: number, author: string, body: string) {
		const scenario = scenarioOf(this);
		const draft = draftFor(seq, author, body, scenario.currentBot);
		scenario.submittedDrafts.set(seq, draft);
		scenario.submissions.push(
			await currentRoot(this).submit({ type: "input", content: body, requestId: `msg:${draft.messageId}` }, BACKGROUND_CONTEXT),
		);
	},
);

When(
	"the owner submits message {int} from human {string} saying {string} as an input",
	async function (this: ChatticusWorld, seq: number, author: string, body: string) {
		const scenario = scenarioOf(this);
		const draft = draftFor(seq, author, body, scenario.currentBot);
		scenario.submittedDrafts.set(seq, draft);
		const submission = await currentRoot(this).submit(
			{ type: "input", content: body, requestId: `msg:${draft.messageId}` },
			BACKGROUND_CONTEXT,
		);
		scenario.submissions.push(submission);
		const settled = await submission.wait(BACKGROUND_CONTEXT);
		assert.equal(settled.status, "done");
	},
);

When(
	"message {int} from human {string} saying {string} is submitted to the busy bot as a steer",
	async function (this: ChatticusWorld, seq: number, author: string, body: string) {
		const scenario = scenarioOf(this);
		for (let attempt = 0; attempt < 200 && scenario.modelCalls === 0; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assert.equal(scenario.modelCalls, 1, "the first model request should be in flight");
		const draft = draftFor(seq, author, body, scenario.currentBot);
		scenario.submittedDrafts.set(seq, draft);
		const submission = await currentRoot(this).submit(
			{ type: "input", content: body, whenBusy: "steer", requestId: `msg:${draft.messageId}` },
			BACKGROUND_CONTEXT,
		);
		scenario.submissions.push(submission);
	},
);

When("the tool round finishes", async function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	scenario.gate.release();
	for (const submission of scenario.submissions) {
		const settled = await submission.wait(BACKGROUND_CONTEXT);
		assert.equal(settled.status, "done");
	}
});

When("the log is reconciled for message {int}", async function (this: ChatticusWorld, seq: number) {
	const scenario = scenarioOf(this);
	const draft = scenario.submittedDrafts.get(seq);
	assert.ok(draft, `message ${seq} was not submitted`);
	await reconcileInputLine(currentRoot(this), lineFor(seq, draft, draft.authorId, draft.addressedToBotId), `msg:${draft.messageId}`);
});

Then("both submissions are the same submission", function (this: ChatticusWorld) {
	const [first, second] = scenarioOf(this).submissions;
	assert.ok(first && second);
	assert.equal(first.id, second.id);
});

Then("the model was not called", function (this: ChatticusWorld) {
	assert.equal(scenarioOf(this).modelCalls, 0);
});

Then("the model was called {int} time(s)", function (this: ChatticusWorld, count: number) {
	assert.equal(scenarioOf(this).modelCalls, count);
});

Then("the turn is answered once", function (this: ChatticusWorld) {
	assert.equal(scenarioOf(this).modelCalls, 2);
});

Then("the model request that followed the tool round carried {string}", function (this: ChatticusWorld, text: string) {
	const scenario = scenarioOf(this);
	assert.ok(!scenario.requestTexts[0]?.includes(text), "the first request was made before the steer");
	assert.ok(scenario.requestTexts[1]?.includes(text), "the second request did not carry the steered message");
});

const logLinesOf = async (world: ChatticusWorld, bot: string, channel: string): Promise<ChannelLogLine[]> =>
	readLog(await openReadOnly(world, bot, channel));

Then(
	"the log of bot {string} in channel {string} lists message {int} from {string}",
	async function (this: ChatticusWorld, bot: string, channel: string, seq: number, author: string) {
		const line = (await logLinesOf(this, bot, channel)).find((candidate) => candidate.seq === seq);
		assert.ok(line, `message ${seq} is not in the log`);
		assert.equal(line.authorId, author);
	},
);

Then(
	"the log of bot {string} in channel {string} holds {int} line(s)",
	async function (this: ChatticusWorld, bot: string, channel: string, count: number) {
		assert.equal((await logLinesOf(this, bot, channel)).length, count);
	},
);

Then(
	"the entry of message {int} in the session of bot {string} reads {string} attributed to {string}",
	async function (this: ChatticusWorld, seq: number, bot: string, body: string, author: string) {
		const channel = scenarioOf(this).currentChannel;
		const storage = await openReadOnly(this, bot, channel);
		const line = (await readLog(storage)).find((candidate) => candidate.seq === seq);
		assert.ok(line, `message ${seq} is not in the log`);
		const found = await storage.entry(line.entryId as never, BACKGROUND_CONTEXT);
		assert.ok(found);
		assert.equal(found.entry.kind, "pi.user");
		assert.equal(found.entry.model?.[0]?.role, "user");
		assert.deepEqual(found.entry.data, { messageId: `m-${seq}`, authorKind: "human", authorId: author, body });
		assert.equal(await readEntryBody(storage, line.entryId), body);
	},
);

Then(
	"the log line of message {int} points at an entry reading {string}",
	async function (this: ChatticusWorld, seq: number, body: string) {
		const scenario = scenarioOf(this);
		const storage = await openReadOnly(this, scenario.currentBot, scenario.currentChannel);
		const line = (await readLog(storage)).find((candidate) => candidate.seq === seq);
		assert.ok(line);
		assert.equal(await readEntryBody(storage, line.entryId), body);
	},
);

When(
	"the session of bot {string} in channel {string} is read without owning it",
	async function (this: ChatticusWorld, bot: string, channel: string) {
		scenarioOf(this).readSeqs = await logLinesOf(this, bot, channel);
	},
);

Then("the read sees message {int} reading {string}", async function (this: ChatticusWorld, seq: number, body: string) {
	const scenario = scenarioOf(this);
	const line = scenario.readSeqs.find((candidate) => candidate.seq === seq);
	assert.ok(line);
	const storage = await openReadOnly(this, scenario.currentBot, scenario.currentChannel);
	assert.equal(await readEntryBody(storage, line.entryId), body);
});

Then("the owner can still commit", async function (this: ChatticusWorld) {
	await writeAttributedMessage(currentRoot(this), draftFor(9, "ryan", "still here"));
	const scenario = scenarioOf(this);
	assert.equal(scenario.owners.get(ownerKey(scenario.currentBot, scenario.currentChannel))?.fence, 1);
	const lines = await logLinesOf(this, scenario.currentBot, scenario.currentChannel);
	assert.deepEqual(
		lines.map((line) => line.seq),
		[1, 9],
	);
});

Given(
	"bots {string} and {string} are in channel {string}",
	function (this: ChatticusWorld, first: string, second: string, channel: string) {
		const scenario = scenarioOf(this);
		scenario.currentChannel = channel;
		scenario.currentBot = first;
		void second;
	},
);

Given(
	"message {int} from human {string} saying {string} waits in both mailboxes",
	async function (this: ChatticusWorld, seq: number, author: string, body: string) {
		const scenario = scenarioOf(this);
		const draft = draftFor(seq, author, body, "ada");
		scenario.submittedDrafts.set(seq, draft);
		for (const bot of ["ada", "bob"]) {
			await put(mailboxStoreOf(this), mailboxItemFor(this, bot, scenario.currentChannel, draft));
		}
	},
);

When(
	"bot {string} drains its mailbox into its session as an input and its answer is logged as message {int}",
	async function (this: ChatticusWorld, bot: string, replySeq: number) {
		const scenario = scenarioOf(this);
		const channel = scenario.currentChannel;
		const root = await openOwner(this, bot, channel);
		await drain(mailboxStoreOf(this), this.tenantId, bot, channel, async (item) => {
			const requestId = `msg:${item.messageId}`;
			const submission = await root.submit({ type: "input", content: item.body, requestId }, BACKGROUND_CONTEXT);
			const settled = await submission.wait(BACKGROUND_CONTEXT);
			assert.equal(settled.status, "done");
			await reconcileInputLine(
				root,
				{
					seq: item.seq,
					messageId: item.messageId,
					authorKind: item.authorKind,
					authorId: item.authorId,
					addressedToBotId: item.addressedToBotId,
					createdAt: item.createdAt,
				},
				requestId,
			);
			assert.ok(settled.status === "done" && settled.answer);
			await appendLine(root, {
				seq: replySeq,
				messageId: `m-${replySeq}`,
				authorKind: "bot",
				authorId: bot,
				addressedToBotId: null,
				createdAt: createdAtFor(replySeq),
				entryId: settled.answer,
			});
		});
	},
);

When("the channel {string} is listed", async function (this: ChatticusWorld, channel: string) {
	scenarioOf(this).listed = await listChannelMessages(
		{
			client: dynamo,
			s3,
			messagingTableName: this.messagingTable.tableName,
			conversationsTableName: CONVERSATIONS_TABLE,
			bucket: BUCKET,
		},
		this.tenantId,
		channel,
		["ada", "bob"],
	);
});

When("the channel {string} is listed after message {int}", async function (this: ChatticusWorld, channel: string, after: number) {
	scenarioOf(this).listed = await listChannelMessages(
		{
			client: dynamo,
			s3,
			messagingTableName: this.messagingTable.tableName,
			conversationsTableName: CONVERSATIONS_TABLE,
			bucket: BUCKET,
		},
		this.tenantId,
		channel,
		["ada", "bob"],
		after,
	);
});

Then("the listed messages are {listing}", function (this: ChatticusWorld, expected: [number, string, string][]) {
	assert.deepEqual(
		scenarioOf(this).listed.map((message) => [message.seq, message.author_id, message.body]),
		expected,
	);
});
