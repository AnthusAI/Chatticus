import { randomUUID } from "node:crypto";
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { afterAll, describe, expect, it } from "vitest";
import { InMemoryMessagingStore } from "../features-support/in-memory-messaging-store.ts";
import type { Channel, ChannelMessageRecord } from "../src/domain/channels.ts";
import type { Identity, Invitation, Membership, Organization } from "../src/domain/organizations.ts";
import { DuplicateBotNameError } from "../src/http/errors.ts";
import type { Bot } from "../src/store/codecs/bot.ts";
import type { Computer } from "../src/store/codecs/computer.ts";
import type { Task } from "../src/store/codecs/task.ts";
import type { Worker } from "../src/store/codecs/worker.ts";
import { DynamoMessagingStore } from "../src/store/dynamo-messaging-store.ts";
import type { MessagingStore } from "../src/store/messaging-store.ts";

const client = new DynamoDBClient({
	endpoint: process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5555",
	region: "us-east-1",
	credentials: { accessKeyId: "test", secretAccessKey: "test" },
	maxAttempts: 1,
});

const createdTables: string[] = [];

async function freshDynamoStore(): Promise<MessagingStore> {
	const tableName = `contract-messaging-${randomUUID()}`;
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
	return new DynamoMessagingStore(client, tableName, 2);
}

afterAll(async () => {
	for (const tableName of createdTables) {
		await client.send(new DeleteTableCommand({ TableName: tableName }));
	}
	client.destroy();
});

const T0 = new Date("2026-01-01T00:00:00Z");

function organization(tenantId: string, overrides: Partial<Organization> = {}): Organization {
	return {
		tenantId,
		name: `Org ${tenantId}`,
		status: "pending",
		ownerUserId: `owner-${tenantId}`,
		createdAt: T0,
		awsAccountId: null,
		awsCrossAccountRole: null,
		awsExternalId: null,
		awsSetupPath: null,
		monthlyAwsSpendCeilingUsd: null,
		...overrides,
	};
}

function membership(tenantId: string, userId: string): Membership {
	return { tenantId, userId, role: "member", joinedAt: T0 };
}

function invitation(invitationId: string, email: string, createdAtSeconds: number, status: Invitation["status"]): Invitation {
	return {
		invitationId,
		tenantId: "tenant-a",
		email,
		invitedByUserId: "owner-a",
		role: "member",
		status,
		expiresAt: new Date("2026-02-01T00:00:00Z"),
		createdAt: new Date(T0.getTime() + createdAtSeconds * 1000),
	};
}

function bot(tenantId: string, botId: string, name: string): Bot {
	return { botId, tenantId, name, memory: { mood: "calm" } };
}

function channel(channelId: string, userId: string): Channel {
	return {
		channelId,
		tenantId: "tenant-a",
		kind: "direct",
		name: null,
		participants: [
			{ kind: "human", actorId: userId },
			{ kind: "bot", actorId: "bot-1" },
		],
		nextSeq: 1,
	};
}

function message(seq: number): ChannelMessageRecord {
	return {
		messageId: `message-${seq}`,
		channelId: "channel-1",
		tenantId: "tenant-a",
		seq,
		authorKind: "human",
		authorId: "user-1",
		body: `body ${seq}`,
		addressedToBotId: seq % 2 === 0 ? "bot-1" : null,
		createdAt: new Date(T0.getTime() + seq * 1000),
	};
}

function contractSuite(name: string, makeStore: () => Promise<MessagingStore>): void {
	describe(`MessagingStore contract: ${name}`, () => {
		it("round-trips an identity by email", async () => {
			const store = await makeStore();
			const identity: Identity = { userId: "user-1", email: "a@example.com", createdAt: T0 };
			expect(await store.getIdentityByEmail("a@example.com")).toBeNull();
			await store.putIdentity(identity);
			expect(await store.getIdentityByEmail("a@example.com")).toEqual(identity);
			expect(await store.getIdentityByEmail("other@example.com")).toBeNull();
		});

		it("round-trips an organization with and without optional fields", async () => {
			const store = await makeStore();
			const bare = organization("tenant-a");
			const full = organization("tenant-b", {
				status: "enabled",
				awsAccountId: "123456789012",
				awsCrossAccountRole: "arn:aws:iam::123456789012:role/x",
				awsExternalId: "external",
				awsSetupPath: "customer-owned",
				monthlyAwsSpendCeilingUsd: 250,
			});
			await store.putOrganization(bare);
			await store.putOrganization(full);
			expect(await store.getOrganization("tenant-a")).toEqual(bare);
			expect(await store.getOrganization("tenant-b")).toEqual(full);
			expect(await store.getOrganization("tenant-missing")).toBeNull();
		});

		it("lists memberships of one organization sorted by user, across several pages", async () => {
			const store = await makeStore();
			for (const userId of ["u-e", "u-b", "u-d", "u-a", "u-c"]) {
				await store.putMembership(membership("tenant-a", userId));
			}
			await store.putMembership(membership("tenant-b", "u-z"));
			expect((await store.listMemberships("tenant-a")).map((entry) => entry.userId)).toEqual([
				"u-a",
				"u-b",
				"u-c",
				"u-d",
				"u-e",
			]);
			expect(await store.getMembership("tenant-a", "u-c")).toEqual(membership("tenant-a", "u-c"));
			expect(await store.getMembership("tenant-a", "u-z")).toBeNull();
		});

		it("lists the organizations a user belongs to, across several pages", async () => {
			const store = await makeStore();
			for (const tenantId of ["t-4", "t-2", "t-5", "t-1", "t-3"]) {
				await store.putOrganization(organization(tenantId));
				await store.putMembership(membership(tenantId, "user-1"));
			}
			await store.putOrganization(organization("t-other"));
			await store.putMembership(membership("t-other", "user-2"));
			expect((await store.listOrganizationsForUser("user-1")).map((entry) => entry.tenantId)).toEqual([
				"t-1",
				"t-2",
				"t-3",
				"t-4",
				"t-5",
			]);
		});

		it("lists organizations by status across several scan pages", async () => {
			const store = await makeStore();
			for (const tenantId of ["t-3", "t-1", "t-5", "t-2", "t-4"]) {
				await store.putOrganization(organization(tenantId, { status: "pending" }));
			}
			await store.putOrganization(organization("t-9", { status: "enabled" }));
			for (const userId of ["u-1", "u-2", "u-3"]) {
				await store.putMembership(membership("t-1", userId));
			}
			expect((await store.listOrganizationsByStatus("pending")).map((entry) => entry.tenantId)).toEqual([
				"t-1",
				"t-2",
				"t-3",
				"t-4",
				"t-5",
			]);
			expect((await store.listOrganizationsByStatus("enabled")).map((entry) => entry.tenantId)).toEqual(["t-9"]);
			expect(await store.listOrganizationsByStatus("suspended")).toEqual([]);
		});

		it("counts organization creation attempts per user within one window", async () => {
			const store = await makeStore();
			const window = 60 * 60 * 1000;
			expect(await store.incrementOrganizationCreationAttempts("user-1", T0, window)).toBe(1);
			expect(
				await store.incrementOrganizationCreationAttempts("user-1", new Date(T0.getTime() + 60_000), window),
			).toBe(2);
			expect(
				await store.incrementOrganizationCreationAttempts("user-1", new Date(T0.getTime() + 120_000), window),
			).toBe(3);
			expect(await store.incrementOrganizationCreationAttempts("user-2", T0, window)).toBe(1);
		});

		it("starts a fresh count once the window has passed", async () => {
			const store = await makeStore();
			const window = 60 * 60 * 1000;
			await store.incrementOrganizationCreationAttempts("user-1", T0, window);
			await store.incrementOrganizationCreationAttempts("user-1", T0, window);
			const later = new Date(T0.getTime() + 2 * window);
			expect(await store.incrementOrganizationCreationAttempts("user-1", later, window)).toBe(1);
		});

		it("reads an invitation and lists only pending ones for an email, oldest first, across several pages", async () => {
			const store = await makeStore();
			await store.putInvitation(invitation("inv-3", "a@example.com", 30, "pending"));
			await store.putInvitation(invitation("inv-1", "a@example.com", 10, "pending"));
			await store.putInvitation(invitation("inv-4", "a@example.com", 40, "accepted"));
			await store.putInvitation(invitation("inv-2", "a@example.com", 20, "pending"));
			await store.putInvitation(invitation("inv-5", "a@example.com", 5, "pending"));
			await store.putInvitation(invitation("inv-6", "b@example.com", 1, "pending"));
			expect(await store.getInvitation("inv-4")).toEqual(invitation("inv-4", "a@example.com", 40, "accepted"));
			expect(await store.getInvitation("inv-missing")).toBeNull();
			expect((await store.listPendingInvitationsForEmail("a@example.com")).map((entry) => entry.invitationId)).toEqual([
				"inv-5",
				"inv-1",
				"inv-2",
				"inv-3",
			]);
		});

		it("reflects an invitation status change in the pending list", async () => {
			const store = await makeStore();
			await store.putInvitation(invitation("inv-1", "a@example.com", 10, "pending"));
			await store.putInvitation(invitation("inv-1", "a@example.com", 10, "accepted"));
			expect(await store.listPendingInvitationsForEmail("a@example.com")).toEqual([]);
		});

		it("reserves a bot name once per organization", async () => {
			const store = await makeStore();
			await store.putBot(bot("tenant-a", "bot-1", "Scout"), true);
			await expect(store.putBot(bot("tenant-a", "bot-2", "Scout"), true)).rejects.toBeInstanceOf(DuplicateBotNameError);
			expect(await store.getBot("tenant-a", "bot-2")).toBeNull();
			expect(await store.getBotByName("tenant-a", "Scout")).toEqual(bot("tenant-a", "bot-1", "Scout"));
			await store.putBot(bot("tenant-b", "bot-3", "Scout"), true);
			expect((await store.getBotByName("tenant-b", "Scout"))?.botId).toBe("bot-3");
		});

		it("finds an unreserved bot by name by scanning the roster across several pages", async () => {
			const store = await makeStore();
			for (const [botId, name] of [
				["bot-1", "Ada"],
				["bot-2", "Bea"],
				["bot-3", "Cal"],
				["bot-4", "Dee"],
				["bot-5", "Eve"],
			]) {
				await store.putBot(bot("tenant-a", botId!, name!), false);
			}
			expect((await store.getBotByName("tenant-a", "Eve"))?.botId).toBe("bot-5");
			expect(await store.getBotByName("tenant-a", "Zed")).toBeNull();
		});

		it("lists bots of one organization sorted by name, across several pages", async () => {
			const store = await makeStore();
			for (const [botId, name] of [
				["bot-1", "Eve"],
				["bot-2", "Ada"],
				["bot-3", "Dee"],
				["bot-4", "Bea"],
				["bot-5", "Cal"],
			]) {
				await store.putBot(bot("tenant-a", botId!, name!), false);
			}
			await store.putBot(bot("tenant-b", "bot-9", "Other"), true);
			expect((await store.listBots("tenant-a")).map((entry) => entry.name)).toEqual(["Ada", "Bea", "Cal", "Dee", "Eve"]);
		});

		it("returns the bot recorded under an idempotency key", async () => {
			const store = await makeStore();
			const scout = bot("tenant-a", "bot-1", "Scout");
			await store.putBot(scout, true);
			expect(await store.getBotIdempotency("tenant-a", "key-1")).toBeNull();
			await store.putBotIdempotency("tenant-a", "key-1", scout);
			expect(await store.getBotIdempotency("tenant-a", "key-1")).toEqual(scout);
			expect(await store.getBotIdempotency("tenant-b", "key-1")).toBeNull();
		});

		it("persists a channel and resolves its tenant", async () => {
			const store = await makeStore();
			const direct = channel("channel-1", "user-1");
			await store.putChannel(direct);
			expect(await store.getChannel("tenant-a", "channel-1")).toEqual(direct);
			expect(await store.getChannel("tenant-b", "channel-1")).toBeNull();
			expect(await store.resolveChannelTenant("channel-1")).toBe("tenant-a");
			expect(await store.resolveChannelTenant("channel-missing")).toBeNull();
		});

		it("keeps the first channel stored under an identifier", async () => {
			const store = await makeStore();
			const first = channel("channel-1", "user-1");
			expect(await store.putChannelIfAbsent(first)).toEqual(first);
			const second = { ...channel("channel-1", "user-1"), nextSeq: 7 };
			expect(await store.putChannelIfAbsent(second)).toEqual(first);
			expect(await store.getChannel("tenant-a", "channel-1")).toEqual(first);
		});

		it("lists the channels a human participates in, sorted, across several pages", async () => {
			const store = await makeStore();
			for (const channelId of ["c-4", "c-2", "c-5", "c-1", "c-3"]) {
				await store.putChannel(channel(channelId, "user-1"));
			}
			await store.putChannel(channel("c-9", "user-2"));
			expect((await store.listChannels("tenant-a", "user-1")).map((entry) => entry.channelId)).toEqual([
				"c-1",
				"c-2",
				"c-3",
				"c-4",
				"c-5",
			]);
			expect((await store.listChannels("tenant-a", "user-2")).map((entry) => entry.channelId)).toEqual(["c-9"]);
		});

		it("returns the channel recorded under an idempotency key", async () => {
			const store = await makeStore();
			const direct = channel("channel-1", "user-1");
			await store.putChannel(direct);
			expect(await store.getChannelIdempotency("tenant-a", "key-1")).toBeNull();
			await store.putChannelIdempotency("tenant-a", "key-1", direct);
			expect(await store.getChannelIdempotency("tenant-a", "key-1")).toEqual(direct);
		});

		it("lists committed messages after a sequence in order, across several pages", async () => {
			const store = await makeStore();
			for (const seq of [4, 1, 6, 3, 2, 5]) {
				await store.putMessage(message(seq));
			}
			expect((await store.listMessages("tenant-a", "channel-1", 0)).map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6]);
			expect(await store.listMessages("tenant-a", "channel-1", 4)).toEqual([message(5), message(6)]);
			expect(await store.listMessages("tenant-a", "channel-1", 6)).toEqual([]);
			expect(await store.listMessages("tenant-a", "channel-other", 0)).toEqual([]);
		});

		it("round-trips a computer with and without optional fields", async () => {
			const store = await makeStore();
			const bare: Computer = {
				computerId: "computer-1",
				tenantId: "tenant-a",
				policy: "on_demand",
				stopped: false,
				modelReady: true,
				workspaceReady: false,
				browserReady: false,
				hostStartGeneration: 0,
				hostStartDispatchedGeneration: 0,
				snapshotGeneration: 0,
				diskDirty: false,
				hydrateRequired: false,
			};
			expect(await store.getComputer("tenant-a")).toBeNull();
			await store.putComputer(bare);
			expect(await store.getComputer("tenant-a")).toMatchObject(bare);
			const full: Computer = {
				...bare,
				stopped: true,
				hostStartGeneration: 3,
				hostStartLeaseExpiresAt: new Date("2026-03-01T00:00:00Z"),
				snapshotUri: "s3://bucket/key",
				snapshotChecksum: "abc",
				snapshotGeneration: 2,
				intendedHostWorkerId: "worker-1",
			};
			await store.putComputer(full);
			expect(await store.getComputer("tenant-a")).toEqual(full);
			expect(await store.getComputer("tenant-b")).toBeNull();
		});

		it("round-trips workers and lists them sorted, across several pages", async () => {
			const store = await makeStore();
			for (const workerId of ["w-3", "w-1", "w-5", "w-2", "w-4"]) {
				const worker: Worker = {
					workerId,
					tenantId: "tenant-a",
					costClass: "standard",
					capabilities: ["browser", "model"],
					tokenHash: "hash",
					lastHeartbeatAt: T0,
				};
				await store.putWorker(worker);
			}
			expect((await store.listWorkers("tenant-a")).map((entry) => entry.workerId)).toEqual(["w-1", "w-2", "w-3", "w-4", "w-5"]);
			expect((await store.getWorker("tenant-a", "w-2"))?.capabilities).toEqual(["browser", "model"]);
			expect(await store.getWorker("tenant-a", "w-9")).toBeNull();
		});

		it("round-trips tasks and lists one user's tasks sorted, across several pages", async () => {
			const store = await makeStore();
			for (const taskId of ["k-3", "k-1", "k-5", "k-2", "k-4"]) {
				const task: Task = { taskId, tenantId: "tenant-a", userId: "user-1", title: `Task ${taskId}`, status: "open" };
				await store.putTask(task);
			}
			await store.putTask({ taskId: "k-9", tenantId: "tenant-a", userId: "user-2", title: "Other", status: "open" });
			expect((await store.listTasks("tenant-a", "user-1")).map((entry) => entry.taskId)).toEqual(["k-1", "k-2", "k-3", "k-4", "k-5"]);
			expect((await store.getTask("tenant-a", "k-9"))?.userId).toBe("user-2");
			expect(await store.getTask("tenant-a", "k-missing")).toBeNull();
		});
	});
}

contractSuite("in-memory double", async () => new InMemoryMessagingStore());
contractSuite("DynamoDB store on moto", freshDynamoStore);

describe("DynamoMessagingStore item layout", () => {
	it("stamps the creation-rate record with a time-to-live attribute", async () => {
		const tableName = `contract-messaging-${randomUUID()}`;
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
		const store = new DynamoMessagingStore(client, tableName);
		const window = 60 * 60 * 1000;
		await store.incrementOrganizationCreationAttempts("user-1", T0, window);
		const bucket = Math.floor(T0.getTime() / 1000 / 3600);
		const response = await client.send(
			new GetItemCommand({
				TableName: tableName,
				Key: { pk: { S: "user#user-1" }, sk: { S: `org_create_rate#${bucket}` } },
			}),
		);
		expect(response.Item?.attempt_count?.N).toBe("1");
		expect(response.Item?.expires_at?.N).toBe(String(T0.getTime() / 1000 + 3600 + 3600));
	});
});
