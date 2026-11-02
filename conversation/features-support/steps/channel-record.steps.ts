import assert from "node:assert/strict";
import { DeleteItemCommand, PutItemCommand, QueryCommand, ScanCommand, type ScanCommandOutput, type AttributeValue } from "@aws-sdk/client-dynamodb";
import type { CommitObjectCache } from "../../src/storage/indexed-storage.ts";
import { GetObjectCommand, ListObjectVersionsCommand, PutObjectCommand, type ListObjectVersionsCommandOutput, PutBucketVersioningCommand } from "@aws-sdk/client-s3";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import { type ComputerAction, encodeAction, encodeActionIndex } from "../../src/store/codecs/action.ts";
import { createBot } from "../../src/domain/bots.ts";
import { getChannel } from "../../src/domain/channels.ts";
import { listMessages, postMessage } from "../../src/domain/messages.ts";
import { completePendingErasures, eraseMessage, type ErasureReport } from "../../src/domain/message-erasure.ts";
import { runMigrationCli } from "../../src/migration/cli.ts";
import { backfillChannelRecord, type ChannelBackfillReport } from "../../src/migration/backfill-record.ts";
import { type ListedMessage, listChannelMessages } from "../../src/pi/channel-listing.ts";
import { list as listMailbox } from "../../src/pi/mailbox.ts";
import { dropSession } from "../../src/pi/session-drop.ts";
import { rebuildSessionFromRecord } from "../../src/pi/session-rebuild.ts";
import { storageIdFor } from "../../src/storage/storage-support.ts";
import { DynamoMessagingStore } from "../../src/store/dynamo-messaging-store.ts";
import { readTurnCalls } from "../../src/domain/costs.ts";
import { recordResponse } from "../api.ts";
import { recordingDynamoClient, recordingS3Client, type RecordedAwsRequest } from "../aws-request-recorder.ts";
import { modelScenarioOf } from "../executor-harness.ts";
import { erasureQueueOf } from "../erasure-queue.ts";
import { erasureRequestsOf } from "../erasure-request-recording.ts";
import { DynamoTurnAdmission } from "../../src/store/turn-admission-store.ts";
import { executorMessageDependencies } from "../front-door.ts";
import { memberGet, memberPost } from "../org-user-client.ts";
import { ensurePiStorage } from "../pi-storage.ts";
import type { ChatticusWorld } from "../world.ts";
import { readChannelMessages } from "./model.steps.ts";
import { post } from "./message.steps.ts";

const reports = new WeakMap<ChatticusWorld, { backfill?: ChannelBackfillReport; erasure?: ErasureReport; pending?: ErasureReport[] }>();
const reportsOf = (world: ChatticusWorld) => {
	let found = reports.get(world);
	if (found === undefined) {
		found = {};
		reports.set(world, found);
	}
	return found;
};

function openChannelOf(world: ChatticusWorld): { channelId: string; tenantId: string } {
	assert.ok(world.lastChannel, "No channel has been opened");
	return world.lastChannel;
}

function botNamed(world: ChatticusWorld, name: string): { botId: string; tenantId: string } {
	const bot = world.botsByName?.get(name);
	assert.ok(bot, `Bot ${name} not found`);
	return bot;
}

When(
	"tenant {string} user {string} opens a named channel {string} with no bot",
	async function (this: ChatticusWorld, tenantId: string, userId: string, name: string) {
		const response = await recordResponse(
			await memberPost(this, `/orgs/${tenantId}/channels`, { user_id: userId, bot_ids: [], kind: "named", name }),
		);
		assert.equal(response.status, 200, response.text);
		this.lastChannel = { channelId: response.json.channel_id, tenantId };
	},
);

When(
	"tenant {string} user {string} has a bot named {string} that is not on the channel yet",
	async function (this: ChatticusWorld, tenantId: string, userId: string, name: string) {
		const bot = await createBot(tenantId, name, { creatorUserId: userId }, { store: this.messagingStore(), ids: this.ids });
		this.botsById?.set(bot.botId, bot);
		this.botsByName?.set(name, bot);
	},
);

When("bot {string} joins the channel", async function (this: ChatticusWorld, name: string) {
	const channel = openChannelOf(this);
	const current = await getChannel(channel.tenantId, channel.channelId, { store: this.messagingStore() });
	await this.messagingStore().putChannel({
		...current,
		participants: [...current.participants, { kind: "bot", actorId: botNamed(this, name).botId }],
	});
});

When(
	"user {string} of tenant {string} posts {int} messages without addressing a bot",
	async function (this: ChatticusWorld, userId: string, tenantId: string, count: number) {
		const channel = openChannelOf(this);
		const dependencies = await executorMessageDependencies(this);
		for (let index = 1; index <= count; index += 1) {
			await postMessage(dependencies, {
				tenantId,
				channelId: channel.channelId,
				authorKind: "human",
				authorId: userId,
				body: `line ${index} of the discussion`,
				addressedToBotId: null,
				idempotencyKey: null,
			});
		}
	},
);

Then("the channel lists these messages in order:", async function (this: ChatticusWorld, table: DataTable) {
	const listed = await readChannelMessages(this);
	assert.deepEqual(
		listed.map((message) => message.body),
		table.raw().map((row) => (row[0] ?? "").trim()),
	);
});

Then("the channel lists {int} messages", async function (this: ChatticusWorld, count: number) {
	assert.equal((await readChannelMessages(this)).length, count);
});

Then("the mailbox of bot {string} on the channel is empty", async function (this: ChatticusWorld, name: string) {
	const channel = openChannelOf(this);
	const dependencies = await executorMessageDependencies(this);
	assert.deepEqual(await listMailbox(dependencies.mailbox, channel.tenantId, botNamed(this, name).botId, channel.channelId), []);
});

Then("the last bot answer lists a call to tool {string}", async function (this: ChatticusWorld, tool: string) {
	const answers = (await readChannelMessages(this)).filter((message) => message.author_kind === "bot");
	const last = answers.at(-1);
	assert.ok(last, "The channel has no bot answer");
	assert.ok(
		(last.activity ?? []).some((item: { tool: string }) => item.tool === tool),
		`The answer lists no call to ${tool}: ${JSON.stringify(last.activity)}`,
	);
});

Then("the channel record is the only place the listing reads", async function (this: ChatticusWorld) {
	const channel = openChannelOf(this);
	const base = await executorMessageDependencies(this);
	const requests: RecordedAwsRequest[] = [];
	const dependencies = {
		...base,
		store: new DynamoMessagingStore(recordingDynamoClient(this.messagingTable.client, requests), this.messagingTable.tableName),
		listing: { ...base.listing, client: recordingDynamoClient(base.listing.client, requests), s3: recordingS3Client(base.listing.s3, requests) },
	};
	await listMessages(dependencies, { tenantId: channel.tenantId, channelId: channel.channelId });
	assert.deepEqual(
		requests.filter((request) => request.store === base.listing.conversationsTableName || request.service === "s3"),
		[],
		"The listing touched a Pi session",
	);
});

When("the channel record is emptied, as it was before the record existed", async function (this: ChatticusWorld) {
	const channel = openChannelOf(this);
	const client = this.messagingTable.client;
	const response = await client.send(
		new QueryCommand({
			TableName: this.messagingTable.tableName,
			KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
			ExpressionAttributeValues: { ":pk": { S: `${channel.tenantId}#channel#${channel.channelId}` }, ":prefix": { S: "msg#" } },
		}),
	);
	for (const item of response.Items ?? []) {
		await client.send(new DeleteItemCommand({ TableName: this.messagingTable.tableName, Key: { pk: item.pk!, sk: item.sk! } }));
	}
});

When("the channel record is backfilled", async function (this: ChatticusWorld) {
	reportsOf(this).backfill = await backfill(this, false);
});

async function backfill(world: ChatticusWorld, dryRun: boolean): Promise<ChannelBackfillReport> {
	const channel = openChannelOf(world);
	const dependencies = await operatorDependencies(world);
	return backfillChannelRecord(
		{
			client: dependencies.listing.client,
			s3: dependencies.listing.s3,
			messagingTableName: world.messagingTable.tableName,
			conversationsTableName: dependencies.listing.conversationsTableName,
			bucket: dependencies.listing.bucket,
			clock: world.clock,
			store: world.messagingStore(),
		},
		await getChannel(channel.tenantId, channel.channelId, { store: world.messagingStore() }),
		{ dryRun },
	);
}

Then("the backfill wrote {int} messages", function (this: ChatticusWorld, count: number) {
	assert.equal(reportsOf(this).backfill?.written, count);
});

Then("the backfill found {int} messages already in the record", function (this: ChatticusWorld, count: number) {
	assert.equal(reportsOf(this).backfill?.alreadyRecorded, count);
});

Then("the record rows match what the bot sessions held, activity included", async function (this: ChatticusWorld) {
	const channel = openChannelOf(this);
	const dependencies = await operatorDependencies(this);
	const current = await getChannel(channel.tenantId, channel.channelId, { store: this.messagingStore() });
	const botIds = current.participants.filter((participant) => participant.kind === "bot").map((participant) => participant.actorId);
	const merged = await listChannelMessages(dependencies.listing, channel.tenantId, channel.channelId, botIds, 0);
	const record = await listMessages(dependencies, { tenantId: channel.tenantId, channelId: channel.channelId });
	assert.deepEqual(
		record.map((message) => ({ seq: message.seq, body: message.body, activity: message.activity })),
		merged.map((message: ListedMessage) => ({ seq: message.seq, body: message.body, activity: message.activity })),
	);
});

// Read cost

type Counts = { dynamodb: number; s3: number; milliseconds: number };

const costs = new WeakMap<ChatticusWorld, { merge: Counts; mergeWarm: Counts; record: Counts; messages: number }>();

function countsOf(requests: readonly RecordedAwsRequest[], milliseconds: number): Counts {
	return {
		dynamodb: requests.filter((request) => request.service === "dynamodb").length,
		s3: requests.filter((request) => request.service === "s3").length,
		milliseconds: Math.round(milliseconds),
	};
}

When("the channel is read from the record and by merging the bot sessions, counting requests", async function (this: ChatticusWorld) {
	const channel = openChannelOf(this);
	const base = await operatorDependencies(this);
	const current = await getChannel(channel.tenantId, channel.channelId, { store: this.messagingStore() });
	const botIds = current.participants.filter((participant) => participant.kind === "bot").map((participant) => participant.actorId);
	const measure = async (run: (requests: RecordedAwsRequest[]) => Promise<number>): Promise<{ counts: Counts; messages: number }> => {
		const requests: RecordedAwsRequest[] = [];
		const started = performance.now();
		const messages = await run(requests);
		return { counts: countsOf(requests, performance.now() - started), messages };
	};
	const cache: CommitObjectCache = new Map();
	const mergeWith = (requests: RecordedAwsRequest[]) => async () => {
		const listing = {
			...base.listing,
			client: recordingDynamoClient(base.listing.client, requests),
			s3: recordingS3Client(base.listing.s3, requests),
			commitCache: cache,
			openExistingStorage: undefined,
		};
		const store = new DynamoMessagingStore(recordingDynamoClient(this.messagingTable.client, requests), this.messagingTable.tableName);
		await getChannel(channel.tenantId, channel.channelId, { store });
		return (await listChannelMessages(listing, channel.tenantId, channel.channelId, botIds, 0)).length;
	};
	const mergeCold = await measure((requests) => mergeWith(requests)());
	const mergeWarm = await measure((requests) => mergeWith(requests)());
	const record = await measure(async (requests) => {
		const dependencies = {
			...base,
			store: new DynamoMessagingStore(recordingDynamoClient(this.messagingTable.client, requests), this.messagingTable.tableName),
			listing: { ...base.listing, client: recordingDynamoClient(base.listing.client, requests), s3: recordingS3Client(base.listing.s3, requests) },
		};
		return (await listMessages(dependencies, { tenantId: channel.tenantId, channelId: channel.channelId })).length;
	});
	assert.equal(record.messages, mergeCold.messages);
	costs.set(this, { merge: mergeCold.counts, mergeWarm: mergeWarm.counts, record: record.counts, messages: record.messages });
});

Then("reading the record takes fewer DynamoDB requests and no S3 requests compared with the merge", function (this: ChatticusWorld) {
	const measured = costs.get(this);
	assert.ok(measured, "Nothing was measured");
	console.log(`READ COST for ${measured.messages} messages: ${JSON.stringify(measured)}`);
	assert.equal(measured.record.s3, 0);
	assert.ok(measured.record.dynamodb < measured.merge.dynamodb, "The record takes no fewer DynamoDB requests");
	assert.ok(measured.merge.s3 > 0, "The merge read nothing from S3, so the comparison measured nothing");
});

// Erasure

Given("the Pi sessions bucket keeps every object version", async function (this: ChatticusWorld) {
	const storage = await ensurePiStorage(this);
	await storage.s3.send(new PutBucketVersioningCommand({ Bucket: storage.bucket, VersioningConfiguration: { Status: "Enabled" } }));
});

When("user {string} of tenant {string} erases the message with seq {int}", async function (this: ChatticusWorld, _userId: string, tenantId: string, seq: number) {
	const channel = openChannelOf(this);
	reportsOf(this).erasure = await eraseMessage(await erasureDependencies(this), { tenantId, channelId: channel.channelId, seq });
});

When("the pending erasures of the channel are completed", async function (this: ChatticusWorld) {
	const channel = openChannelOf(this);
	reportsOf(this).pending = await completePendingErasures(await erasureDependencies(this), { tenantId: channel.tenantId, channelId: channel.channelId });
});

Then("the erasure tombstoned the messages with seq {string}", function (this: ChatticusWorld, list: string) {
	assert.deepEqual(reportsOf(this).erasure?.erasedSeqs, list.split(",").map((seq) => Number(seq.trim())));
});

Then("the erasure left the session of bot {string} for later because its turn is open", function (this: ChatticusWorld, name: string) {
	const outcome = reportsOf(this).erasure?.bots.find((bot) => bot.botId === botNamed(this, name).botId);
	assert.equal(outcome?.outcome, "deferred");
});

Then("the erasure dropped the session of bot {string}", function (this: ChatticusWorld, name: string) {
	const outcome = reportsOf(this).erasure?.bots.find((bot) => bot.botId === botNamed(this, name).botId);
	assert.equal(outcome?.outcome, "dropped");
});

Then("the channel lists the message with seq {int} as deleted with an empty body", async function (this: ChatticusWorld, seq: number) {
	const found = (await readChannelMessages(this)).find((message) => message.seq === seq);
	assert.ok(found, `The channel lists no message ${seq}`);
	assert.equal(found.body, "");
	assert.ok(found.deleted_at, "The message is not marked deleted");
	assert.equal(found.activity, undefined);
});

/** The message dependencies of an operator tool or a scenario step that reads Pi sessions: the scenario's own clients, outside every recorded role. */
async function operatorDependencies(world: ChatticusWorld) {
	const base = await executorMessageDependencies(world);
	const storage = await ensurePiStorage(world);
	return { ...base, listing: { ...base.listing, client: world.messagingTable.client, s3: storage.s3, openExistingStorage: undefined } };
}

/**
 * The message dependencies of the erasure worker. Its clients are the scenario's own, outside the front door's recorded
 * ones, because no role of the role access manifest may delete Pi session objects or list their versions today; the
 * worker is a new role (docs/MESSAGE_ERASURE.md).
 */
async function erasureDependencies(world: ChatticusWorld) {
	const base = await executorMessageDependencies(world);
	const storage = await ensurePiStorage(world);
	const sink = erasureRequestsOf(world);
	const client = recordingDynamoClient(world.messagingTable.client, sink);
	return {
		...base,
		mailbox: { client, tableName: world.messagingTable.tableName },
		store: new DynamoMessagingStore(client, world.messagingTable.tableName),
		turns: new DynamoTurnAdmission(client, world.messagingTable.tableName),
		listing: { ...base.listing, client, s3: recordingS3Client(storage.s3, sink), openExistingStorage: undefined },
	};
}

/** The places in the scenario's stores that hold a text, by what kind of item or object holds it. */
export async function placesHolding(world: ChatticusWorld, text: string): Promise<string[]> {
	const places = new Set<string>();
	const holds = (item: Record<string, AttributeValue>): boolean => Object.values(item).some((value) => JSON.stringify(value).includes(text));
	const messaging = world.messagingTable;
	let startKey: Record<string, AttributeValue> | undefined;
	do {
		const page: ScanCommandOutput = await messaging.client.send(new ScanCommand({ TableName: messaging.tableName, ExclusiveStartKey: startKey }));
		for (const item of page.Items ?? []) {
			if (!holds(item)) continue;
			const pk = item.pk?.S ?? "";
			const sk = item.sk?.S ?? "";
			if (sk.startsWith("msg#")) places.add("channel record");
			else if (pk.startsWith("MB#")) places.add("mailbox");
			else if (sk.startsWith("evt#")) places.add("turn events");
			else places.add(`messaging table ${pk.split("#")[0]!.slice(0, 12)}/${sk.split("#")[0]!.slice(0, 12)}`);
		}
		startKey = page.LastEvaluatedKey;
	} while (startKey !== undefined);
	const storage = await ensurePiStorage(world);
	startKey = undefined;
	do {
		const page: ScanCommandOutput = await messaging.client.send(new ScanCommand({ TableName: storage.tableName, ExclusiveStartKey: startKey }));
		for (const item of page.Items ?? []) if (holds(item)) places.add("Pi session table");
		startKey = page.LastEvaluatedKey;
	} while (startKey !== undefined);
	let keyMarker: string | undefined;
	let versionMarker: string | undefined;
	do {
		const page: ListObjectVersionsCommandOutput = await storage.s3.send(new ListObjectVersionsCommand({ Bucket: storage.bucket, KeyMarker: keyMarker, VersionIdMarker: versionMarker }));
		for (const version of page.Versions ?? []) {
			const object = await storage.s3.send(new GetObjectCommand({ Bucket: storage.bucket, Key: version.Key!, VersionId: version.VersionId }));
			if ((await object.Body!.transformToString()).includes(text)) places.add(version.IsLatest ? "Pi session objects (current)" : "Pi session objects (older versions)");
		}
		keyMarker = page.IsTruncated === true ? page.NextKeyMarker : undefined;
		versionMarker = page.IsTruncated === true ? page.NextVersionIdMarker : undefined;
	} while (keyMarker !== undefined);
	return [...places].sort();
}

Then("the text {string} is held by:", async function (this: ChatticusWorld, text: string, table: DataTable) {
	assert.deepEqual(await placesHolding(this, text), table.raw().map((row) => (row[0] ?? "").trim()).sort());
});

Then("the text {string} is held by nothing but:", async function (this: ChatticusWorld, text: string, table: DataTable) {
	assert.deepEqual(await placesHolding(this, text), table.raw().map((row) => (row[0] ?? "").trim()).sort());
});

Then("the text {string} is held nowhere", async function (this: ChatticusWorld, text: string) {
	assert.deepEqual(await placesHolding(this, text), []);
});

When("the session of bot {string} is dropped and rebuilt from the record, counting requests", async function (this: ChatticusWorld, name: string) {
	const channel = openChannelOf(this);
	const base = await operatorDependencies(this);
	const storage = await ensurePiStorage(this);
	const requests: RecordedAwsRequest[] = [];
	const clients = { client: recordingDynamoClient(base.listing.client, requests), s3: recordingS3Client(base.listing.s3, requests) };
	const started = performance.now();
	const dropped = await dropSession({ ...clients, conversationsTableName: storage.tableName, bucket: storage.bucket }, storageIdFor(channel.tenantId, botNamed(this, name).botId, channel.channelId));
	const droppedAt = performance.now();
	const messages = (await listMessages(base, { tenantId: channel.tenantId, channelId: channel.channelId })).filter((message) => message.deletedAt === undefined);
	const written = await rebuildSessionFromRecord({ ...clients, tableName: storage.tableName, bucket: storage.bucket }, botNamed(this, name).botId, messages);
	const finished = performance.now();
	console.log(
		`REBUILD of ${written} messages: dropped ${dropped.items} items and ${dropped.objectVersions} object versions in ${Math.round(droppedAt - started)} ms; ` +
			`rebuilt in ${Math.round(finished - droppedAt)} ms; requests ${JSON.stringify(countsOf(requests, finished - started))}`,
	);
	assert.equal(written, messages.length);
});

Then("the Pi session of bot {string} holds {int} channel log lines", async function (this: ChatticusWorld, name: string, count: number) {
	const channel = openChannelOf(this);
	const base = await operatorDependencies(this);
	const listed = await listChannelMessages(
		{ ...base.listing, openExistingStorage: undefined },
		channel.tenantId,
		channel.channelId,
		[botNamed(this, name).botId],
		0,
	);
	assert.equal(listed.length, count);
});

Then("the model's request {int} did not include {string}", function (this: ChatticusWorld, number: number, text: string) {
	const request = modelScenarioOf(this).scripted.requests[number - 1];
	assert.ok(request, `The model was not asked ${number} times`);
	assert.ok(!request.includes(text), `Request ${number} included ${JSON.stringify(text)}`);
});

When("every Pi session object is rewritten once, which leaves its earlier version behind", async function (this: ChatticusWorld) {
	const storage = await ensurePiStorage(this);
	const listed = await storage.s3.send(new ListObjectVersionsCommand({ Bucket: storage.bucket }));
	for (const version of listed.Versions ?? []) {
		const object = await storage.s3.send(new GetObjectCommand({ Bucket: storage.bucket, Key: version.Key!, VersionId: version.VersionId }));
		await storage.s3.send(new PutObjectCommand({ Bucket: storage.bucket, Key: version.Key!, Body: await object.Body!.transformToString() }));
	}
});

Then("the Pi session of bot {string} has no object versions or delete markers left from before", async function (this: ChatticusWorld, name: string) {
	const channel = openChannelOf(this);
	const storage = await ensurePiStorage(this);
	const prefix = `conversations/${encodeURIComponent(storageIdFor(channel.tenantId, botNamed(this, name).botId, channel.channelId))}/`;
	const listed = await storage.s3.send(new ListObjectVersionsCommand({ Bucket: storage.bucket, Prefix: prefix }));
	const older = (listed.Versions ?? []).filter((version) => version.IsLatest !== true);
	assert.deepEqual(older, []);
	assert.deepEqual(listed.DeleteMarkers ?? [], []);
});

async function lastTurnCalls(world: ChatticusWorld, _name: string) {
	const channel = openChannelOf(world);
	assert.ok(world.lastTurnId, "The last post started no turn");
	const dependencies = await executorMessageDependencies(world);
	return readTurnCalls({ ...dependencies.listing, openExistingStorage: undefined }, channel.tenantId, world.lastTurnId);
}

Then("the per-call cost records of the last turn of bot {string} can be read", async function (this: ChatticusWorld, name: string) {
	const calls = await lastTurnCalls(this, name);
	assert.ok(calls !== null && calls.length > 0, "The turn has no per-call cost records");
});


const longBody = (characters: number, ending: string): string => `${"long ".repeat(Math.ceil(characters / 5)).slice(0, characters - ending.length)}${ending}`;

When(
	"user {string} of tenant {string} posts a message of {int} characters ending in {string} on the channel without addressing a bot",
	async function (this: ChatticusWorld, userId: string, tenantId: string, characters: number, ending: string) {
		await post(this, { authorKind: "human", authorId: userId, body: longBody(characters, ending), addressedToBotId: null, tenantId });
	},
);

Then("the last post was refused with status {int}", function (this: ChatticusWorld, status: number) {
	assert.equal(this.postResponses.at(-1)?.status, status);
});

Then("the last post was accepted", function (this: ChatticusWorld) {
	assert.equal(this.postResponses.at(-1)?.status, 200, this.postResponses.at(-1)?.text);
});

Then("the last listed message has {int} characters and ends in {string}", async function (this: ChatticusWorld, characters: number, ending: string) {
	const last = (await readChannelMessages(this)).at(-1);
	assert.ok(last, "The channel lists no message");
	assert.equal(last.body.length, characters);
	assert.ok(last.body.endsWith(ending));
});

Then("the last listed message has {int} characters", async function (this: ChatticusWorld, characters: number) {
	const last = (await readChannelMessages(this)).at(-1);
	assert.ok(last, "The channel lists no message");
	assert.equal(last.body.length, characters);
});

When("the per-call cost copies are removed, as they were before they existed", async function (this: ChatticusWorld) {
	const channel = openChannelOf(this);
	assert.ok(this.lastTurnId, "The last post started no turn");
	const client = this.messagingTable.client;
	const response = await client.send(
		new QueryCommand({
			TableName: this.messagingTable.tableName,
			KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
			ExpressionAttributeValues: { ":pk": { S: `${channel.tenantId}#turn#${this.lastTurnId}` }, ":prefix": { S: "call#" } },
		}),
	);
	assert.ok((response.Items ?? []).length > 0, "The turn had no cost copies to remove");
	for (const item of response.Items ?? []) {
		await client.send(new DeleteItemCommand({ TableName: this.messagingTable.tableName, Key: { pk: item.pk!, sk: item.sk! } }));
	}
});

Then("the per-call cost records of the last turn of bot {string} can no longer be found", async function (this: ChatticusWorld, name: string) {
	assert.equal(await lastTurnCalls(this, name), null);
});

Given("an old post idempotency item holds the text {string}", async function (this: ChatticusWorld, text: string) {
	const channel = openChannelOf(this);
	await this.messagingTable.client.send(
		new PutItemCommand({
			TableName: this.messagingTable.tableName,
			Item: {
				pk: { S: `${channel.tenantId}#roster` },
				sk: { S: "idem#old-key-1" },
				tenant_id: { S: channel.tenantId },
				channel_id: { S: channel.channelId },
				message_id: { S: "m-old" },
				seq: { N: "1" },
				author_kind: { S: "human" },
				author_id: { S: "ryan" },
				body: { S: text },
				addressed_to_bot_id: { S: "" },
				created_at: { S: "2026-01-01T00:00:00.000Z" },
			},
		}),
	);
});

const operatorOutputs = new WeakMap<ChatticusWorld, string>();

When("the operator tool runs {string} on the scenario's stores", async function (this: ChatticusWorld, line: string) {
	const dependencies = await operatorDependencies(this);
	const result = await runMigrationCli([...line.split(" "), "--environment", "development"], {
		build: () => ({
			client: dependencies.listing.client,
			s3: dependencies.listing.s3,
			messagingTableName: this.messagingTable.tableName,
			conversationsTableName: dependencies.listing.conversationsTableName,
			bucket: dependencies.listing.bucket,
			clock: this.clock,
		}),
	});
	assert.equal(result.exitCode, 0, `${result.stdout}${result.stderr}`);
	operatorOutputs.set(this, result.stdout);
});

Then("the operator tool printed {string}", function (this: ChatticusWorld, text: string) {
	assert.ok(operatorOutputs.get(this)?.includes(text), `The output was ${operatorOutputs.get(this)}`);
});

Then("the finished turn asked for the pending erasure of the channel to be completed", function (this: ChatticusWorld) {
	const channel = openChannelOf(this);
	assert.deepEqual(erasureQueueOf(this).messages, [{ type: "complete", tenantId: channel.tenantId, channelId: channel.channelId }]);
});

Then("the finished turn asked for no erasure to be completed", function (this: ChatticusWorld) {
	assert.deepEqual(erasureQueueOf(this).messages, []);
});

When("the erasure worker takes the requests queued for it", async function (this: ChatticusWorld) {
	const queue = erasureQueueOf(this);
	const dependencies = await erasureDependencies(this);
	const handled: ErasureReport[] = [];
	for (const message of queue.messages.splice(0)) {
		if (message.type === "erase") handled.push(await eraseMessage(dependencies, message));
		else handled.push(...(await completePendingErasures(dependencies, { tenantId: message.tenantId, channelId: message.channelId })));
	}
	reportsOf(this).pending = handled;
});

Then("the Pi session of bot {string} was rebuilt before it answered", async function (this: ChatticusWorld, name: string) {
	const channel = openChannelOf(this);
	const base = await operatorDependencies(this);
	const lines = await listChannelMessages({ ...base.listing, openExistingStorage: undefined }, channel.tenantId, channel.channelId, [botNamed(this, name).botId], 0);
	assert.ok(lines.length > 0, "The session holds no channel history");
});

Given(
	"a computer action of the last turn of bot {string} has the argument {string} and the result {string}",
	async function (this: ChatticusWorld, name: string, argument: string, result: string) {
		const channel = openChannelOf(this);
		assert.ok(this.lastTurnId, "The last post started no turn");
		const action: ComputerAction = {
			actionId: "action-1",
			tenantId: channel.tenantId,
			computerId: "computer-1",
			turnId: this.lastTurnId,
			channelId: channel.channelId,
			botId: botNamed(this, name).botId,
			userId: null,
			callId: "call-1",
			toolName: "bash",
			arguments: { command: argument },
			gate: "workspace",
			envelope: { tool: "bash", idempotent: true },
			status: "done",
			claimedBy: null,
			leaseExpiresAt: null,
			result,
			resultIsError: false,
			createdAt: this.clock.now(),
			completedAt: this.clock.now(),
		};
		for (const item of [encodeAction(action), encodeActionIndex(action)]) {
			await this.messagingTable.client.send(new PutItemCommand({ TableName: this.messagingTable.tableName, Item: item }));
		}
	},
);

Then("the erasure swept the events and computer actions of {int} turn", function (this: ChatticusWorld, count: number) {
	assert.equal(reportsOf(this).erasure?.sweptTurnIds.length, count);
});

When(
	"user {string} of tenant {string} posts a message of {int} characters ending in {string} addressed to bot {string} on the channel",
	async function (this: ChatticusWorld, userId: string, tenantId: string, characters: number, ending: string, name: string) {
		await post(this, { authorKind: "human", authorId: userId, body: longBody(characters, ending), addressedToBotId: botNamed(this, name).botId, tenantId });
		assert.equal(this.postResponses.at(-1)?.status, 200, this.postResponses.at(-1)?.text);
	},
);
