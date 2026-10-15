import { randomUUID } from "node:crypto";
import {
	CreateTableCommand,
	DeleteTableCommand,
	DynamoDBClient,
	UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { afterAll, describe, expect, it } from "vitest";
import type { Channel, ChannelMessageRecord } from "../src/domain/channels.ts";
import { type MessageDependencies, postMessage } from "../src/domain/messages.ts";
import type { TurnRunJob } from "../src/domain/turn-admission.ts";
import { list as listMailbox, type MailboxItem } from "../src/pi/mailbox.ts";
import { MessageBodyCache } from "../src/pi/message-cache.ts";
import { DynamoMessagingStore } from "../src/store/dynamo-messaging-store.ts";
import { DynamoTurnAdmission, turnPartitionKey } from "../src/store/turn-admission-store.ts";

const client = new DynamoDBClient({
	endpoint: process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5555",
	region: "us-east-1",
	credentials: { accessKeyId: "test", secretAccessKey: "test" },
	maxAttempts: 1,
});

const createdTables: string[] = [];

async function freshTable(): Promise<string> {
	const tableName = `admission-${randomUUID()}`;
	await client.send(
		new CreateTableCommand({
			TableName: tableName,
			KeySchema: [
				{ AttributeName: "pk", KeyType: "HASH" },
				{ AttributeName: "sk", KeyType: "RANGE" },
			],
			AttributeDefinitions: [
				{ AttributeName: "pk", AttributeType: "S" },
				{ AttributeName: "sk", AttributeType: "S" },
			],
			BillingMode: "PAY_PER_REQUEST",
		}),
	);
	createdTables.push(tableName);
	return tableName;
}

afterAll(async () => {
	for (const tableName of createdTables) {
		await client.send(new DeleteTableCommand({ TableName: tableName }));
	}
	client.destroy();
});

const NOW = new Date("2026-10-05T10:00:00Z");

function mailboxItem(seq: number, overrides: Partial<MailboxItem> = {}): MailboxItem {
	return {
		tenantId: "anthus",
		botId: "bot-1",
		channelId: "channel-1",
		seq,
		messageId: `message-${seq}`,
		authorKind: "human",
		authorId: "ryan",
		addressedToBotId: "bot-1",
		body: `body ${seq}`,
		createdAt: NOW.toISOString(),
		...overrides,
	};
}

async function markTurn(tableName: string, turnId: string, assignment: string, values: Record<string, unknown>) {
	await client.send(
		new UpdateItemCommand({
			TableName: tableName,
			Key: { pk: { S: turnPartitionKey("anthus", turnId) }, sk: { S: "meta" } },
			UpdateExpression: assignment,
			...(assignment.includes("#status") ? { ExpressionAttributeNames: { "#status": "status" } } : {}),
			ExpressionAttributeValues: values as never,
		}),
	);
}

const startRequest = (turnId: string, expectedPointerTurnId: string | null) => ({
	tenantId: "anthus",
	channelId: "channel-1",
	botId: "bot-1",
	turnId,
	promptMessageSeq: 1,
	promptAuthorId: "ryan",
	grant: null,
	createdAt: NOW,
	startedEventId: `event-${turnId}`,
	expectedPointerTurnId,
});

describe("DynamoTurnAdmission", () => {
	it("reports no turn before one starts and then the active turn", async () => {
		const admission = new DynamoTurnAdmission(client, await freshTable());
		expect(await admission.openTurn("anthus", "channel-1", "bot-1")).toBeNull();
		expect(await admission.startTurn(startRequest("turn-a", null))).toBe(true);
		expect(await admission.openTurn("anthus", "channel-1", "bot-1")).toEqual({
			pointerTurnId: "turn-a",
			active: true,
			closing: false,
		});
	});

	it("lets only one of two racing starts claim the pointer", async () => {
		const admission = new DynamoTurnAdmission(client, await freshTable());
		const outcomes = await Promise.all([
			admission.startTurn(startRequest("turn-a", null)),
			admission.startTurn(startRequest("turn-b", null)),
		]);
		expect(outcomes.filter(Boolean)).toHaveLength(1);
	});

	it("replaces the pointer of a finished turn only when it still names that turn", async () => {
		const tableName = await freshTable();
		const admission = new DynamoTurnAdmission(client, tableName);
		await admission.startTurn(startRequest("turn-a", null));
		await markTurn(tableName, "turn-a", "SET #status = :done", { ":done": { S: "completed" } });
		expect((await admission.openTurn("anthus", "channel-1", "bot-1"))?.active).toBe(false);
		expect(await admission.startTurn(startRequest("turn-b", "turn-x"))).toBe(false);
		expect(await admission.startTurn(startRequest("turn-b", "turn-a"))).toBe(true);
	});

	it("steers an active turn by writing the mailbox item in the same transaction", async () => {
		const tableName = await freshTable();
		const admission = new DynamoTurnAdmission(client, tableName);
		await admission.startTurn(startRequest("turn-a", null));
		expect(await admission.steerTurn("turn-a", mailboxItem(2))).toBe(true);
		const stored = await listMailbox({ client, tableName }, "anthus", "bot-1", "channel-1");
		expect(stored.map((item) => item.seq)).toEqual([2]);
	});

	it("refuses to steer a closing or finished turn and writes no mailbox item", async () => {
		const tableName = await freshTable();
		const admission = new DynamoTurnAdmission(client, tableName);
		await admission.startTurn(startRequest("turn-a", null));
		await markTurn(tableName, "turn-a", "SET closing = :yes", { ":yes": { BOOL: true } });
		expect((await admission.openTurn("anthus", "channel-1", "bot-1"))?.closing).toBe(true);
		expect(await admission.steerTurn("turn-a", mailboxItem(2))).toBe(false);
		await markTurn(tableName, "turn-a", "SET #status = :done", { ":done": { S: "completed" } });
		expect(await admission.steerTurn("turn-a", mailboxItem(3))).toBe(false);
		expect(await listMailbox({ client, tableName }, "anthus", "bot-1", "channel-1")).toEqual([]);
	});

	it("rejects a steer whose sequence already holds a different message", async () => {
		const tableName = await freshTable();
		const admission = new DynamoTurnAdmission(client, tableName);
		await admission.startTurn(startRequest("turn-a", null));
		await admission.steerTurn("turn-a", mailboxItem(2));
		await expect(admission.steerTurn("turn-a", mailboxItem(2, { messageId: "other" }))).rejects.toThrow(
			/already holds a different message/,
		);
	});
});

describe("postMessage while a turn is closing", () => {
	it("waits for the closing turn to finish, then starts the bot's next turn", async () => {
		const tableName = await freshTable();
		const store = new DynamoMessagingStore(client, tableName);
		const channel: Channel = {
			channelId: "channel-1",
			tenantId: "anthus",
			kind: "direct",
			name: null,
			participants: [
				{ kind: "human", actorId: "ryan" },
				{ kind: "bot", actorId: "bot-1" },
			],
			nextSeq: 1,
		};
		await store.putChannel(channel);
		const admission = new DynamoTurnAdmission(client, tableName);
		await admission.startTurn(startRequest("turn-a", null));
		await markTurn(tableName, "turn-a", "SET closing = :yes", { ":yes": { BOOL: true } });
		const jobs: TurnRunJob[] = [];
		let nextId = 0;
		const deps: MessageDependencies = {
			store,
			ids: { next: () => `generated-${++nextId}` },
			clock: { now: () => NOW },
			mailbox: { client, tableName },
			turns: admission,
			turnRuns: {
				async enqueue(job) {
					jobs.push(job);
				},
			},
			turnProbes: { async send() {} },
			listing: undefined as never,
			closingPollMilliseconds: 10,
		};
		setTimeout(() => {
			void markTurn(tableName, "turn-a", "SET #status = :done", { ":done": { S: "completed" } });
		}, 60);
		const result = await postMessage(deps, {
			tenantId: "anthus",
			channelId: "channel-1",
			authorKind: "human",
			authorId: "ryan",
			body: "after the close",
			addressedToBotId: "bot-1",
			idempotencyKey: null,
		});
		expect(result.turnId).toBe("generated-2");
		expect(jobs.map((job) => job.turnId)).toEqual(["generated-2"]);
		expect((await admission.openTurn("anthus", "channel-1", "bot-1"))?.pointerTurnId).toBe("generated-2");
	});
});

describe("post idempotency in the messaging store", () => {
	it("round trips a message and its turn and scopes the key to the tenant", async () => {
		const store = new DynamoMessagingStore(client, await freshTable());
		const message: ChannelMessageRecord = {
			messageId: "m-1",
			channelId: "channel-1",
			tenantId: "anthus",
			seq: 4,
			authorKind: "human",
			authorId: "ryan",
			body: "hello",
			addressedToBotId: "bot-1",
			createdAt: NOW,
		};
		expect(await store.getPostIdempotency("anthus", "key-1")).toBeNull();
		await store.putPostIdempotency("anthus", "key-1", message, "turn-a");
		expect(await store.getPostIdempotency("anthus", "key-1")).toEqual({ message, turnId: "turn-a" });
		expect(await store.getPostIdempotency("other", "key-1")).toBeNull();
		await store.putPostIdempotency("anthus", "key-2", { ...message, addressedToBotId: null }, null);
		expect((await store.getPostIdempotency("anthus", "key-2"))?.turnId).toBeNull();
	});
});

describe("MessageBodyCache", () => {
	it("evicts the least recently used entry beyond its capacity", () => {
		const cache = new MessageBodyCache<string>(2);
		cache.set("a", "1").set("b", "2");
		expect(cache.get("a")).toBe("1");
		cache.set("c", "3");
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("a")).toBe("1");
		expect(cache.get("c")).toBe("3");
		expect(cache.size).toBe(2);
	});

	it("holds 500 entries by default and rejects a non-positive capacity", () => {
		const cache = new MessageBodyCache<number>();
		for (let index = 0; index < 600; index += 1) cache.set(`key-${index}`, index);
		expect(cache.size).toBe(500);
		expect(cache.get("key-99")).toBeUndefined();
		expect(cache.get("key-100")).toBe(100);
		expect(() => new MessageBodyCache<number>(0)).toThrow(/positive integer/);
	});
});
