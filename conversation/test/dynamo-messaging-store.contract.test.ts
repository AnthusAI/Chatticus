import { randomUUID } from "node:crypto";
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { afterAll, describe, expect, it } from "vitest";
import { Decimal } from "../src/budget/decimal.ts";
import { InMemoryMessagingStore } from "../features-support/in-memory-messaging-store.ts";
import type { Channel, ChannelMessageRecord } from "../src/domain/channels.ts";
import type { Identity, Invitation, Membership, Organization } from "../src/domain/organizations.ts";
import { recordHostHydrated, recordHostSnapshotPublished } from "../src/domain/computers.ts";
import { DuplicateBotNameError } from "../src/http/errors.ts";
import type { Bot } from "../src/store/codecs/bot.ts";
import type { Computer } from "../src/store/codecs/computer.ts";
import type { FileAuditRecord } from "../src/store/codecs/file-audit.ts";
import type { LiveFileOperation } from "../src/store/codecs/live-file-operation.ts";
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
		setupFeeCents: null,
		assistedSetupSession: false,
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
				monthlyAwsSpendCeilingUsd: Decimal.parse("250"),
			});
			await store.putOrganization(bare);
			await store.putOrganization(full);
			expect(await store.getOrganization("tenant-a")).toEqual(bare);
			expect(await store.getOrganization("tenant-b")).toEqual(full);
			expect(await store.getOrganization("tenant-missing")).toBeNull();
		});

		it("writes a monthly spend ceiling only while the organization holds none", async () => {
			const store = await makeStore();
			const withoutCeiling = organization("tenant-a", { status: "enabled", awsSetupPath: "anthus-managed" });
			await store.putOrganization(withoutCeiling);
			await store.putOrganization(organization("tenant-b", { monthlyAwsSpendCeilingUsd: Decimal.parse("500") }));
			expect(await store.setMonthlyAwsSpendCeilingWhenUnset("tenant-a", Decimal.parse("50"))).toBe(true);
			expect(await store.setMonthlyAwsSpendCeilingWhenUnset("tenant-a", Decimal.parse("75"))).toBe(false);
			expect(await store.setMonthlyAwsSpendCeilingWhenUnset("tenant-b", Decimal.parse("50"))).toBe(false);
			expect(await store.setMonthlyAwsSpendCeilingWhenUnset("tenant-missing", Decimal.parse("50"))).toBe(false);
			expect(await store.getOrganization("tenant-a")).toEqual({ ...withoutCeiling, monthlyAwsSpendCeilingUsd: Decimal.parse("50") });
			expect((await store.getOrganization("tenant-b"))?.monthlyAwsSpendCeilingUsd?.toString()).toBe(Decimal.parse("500").toString());
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

		it("starts a host generation by compare-and-set and dispatches it once", async () => {
			const store = await makeStore();
			const computer: Computer = {
				computerId: "c-1",
				tenantId: "tenant-a",
				policy: "prefer_local",
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
			await store.putComputer(computer);
			const lease = new Date("2026-01-01T00:01:00Z");
			const first = await store.claimHostStartGeneration("tenant-a", 0, lease);
			expect(first?.hostStartGeneration).toBe(1);
			expect(first?.hostStartLeaseExpiresAt?.getTime()).toBe(lease.getTime());
			expect(await store.claimHostStartGeneration("tenant-a", 0, lease)).toBeNull();
			expect(await store.markHostStartDispatched("tenant-a", 2)).toBe(false);
			expect(await store.markHostStartDispatched("tenant-a", 1)).toBe(true);
			expect(await store.markHostStartDispatched("tenant-a", 1)).toBe(false);
			await store.releaseHostStartDispatch("tenant-a", 1);
			expect(await store.markHostStartDispatched("tenant-a", 1)).toBe(true);
			expect((await store.getComputer("tenant-a"))?.hostStartDispatchedGeneration).toBe(1);
			expect(await store.claimHostStartGeneration("tenant-none", 0, lease)).toBeNull();
			expect(await store.releaseHostStartLease("tenant-a", 2)).toBe(false);
			expect((await store.getComputer("tenant-a"))?.hostStartLeaseExpiresAt?.getTime()).toBe(lease.getTime());
			expect(await store.releaseHostStartLease("tenant-a", 1)).toBe(true);
			expect((await store.getComputer("tenant-a"))?.hostStartLeaseExpiresAt).toBeUndefined();
			expect((await store.getComputer("tenant-a"))?.hostStartGeneration).toBe(1);
			expect(await store.releaseHostStartLease("tenant-none", 1)).toBe(false);
		});

		it("grants the disk write lock to one host, marks the disk dirty in place, and clears the lock on a new generation", async () => {
			const store = await makeStore();
			const computer: Computer = {
				computerId: "c-1",
				tenantId: "tenant-a",
				policy: "prefer_local",
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
			await store.putComputer(computer);
			expect(await store.claimComputerDiskWriter("tenant-a", "host-a")).toBe(true);
			expect(await store.claimComputerDiskWriter("tenant-a", "host-a")).toBe(true);
			expect(await store.claimComputerDiskWriter("tenant-a", "host-b")).toBe(false);
			expect(await store.claimComputerDiskWriter("tenant-none", "host-a")).toBe(false);
			expect(await store.markComputerDiskDirty("tenant-a")).toBe(true);
			expect(await store.markComputerDiskDirty("tenant-none")).toBe(false);
			const held = await store.getComputer("tenant-a");
			expect(held?.liveWriterHostId).toBe("host-a");
			expect(held?.diskDirty).toBe(true);
			const next = await store.claimHostStartGeneration("tenant-a", 0, new Date("2026-01-01T00:01:00Z"));
			expect(next?.liveWriterHostId).toBeUndefined();
			expect(await store.claimComputerDiskWriter("tenant-a", "host-b")).toBe(true);
		});

		describe("the owner fields of the computer", () => {
			const computerOnGeneration = (generation: number): Computer => ({
				computerId: "c-1",
				tenantId: "tenant-a",
				policy: "prefer_local",
				stopped: false,
				modelReady: true,
				workspaceReady: false,
				browserReady: false,
				hostStartGeneration: generation,
				hostStartDispatchedGeneration: generation,
				snapshotGeneration: 0,
				diskDirty: false,
				hydrateRequired: false,
			});
			const bootstrap = (ownerId: string, generation: number) => ({ ownerId, generation, protocolVersion: 1, startedAt: new Date("2026-01-01T00:10:00.700Z"), credentialsExpireAt: new Date("2026-01-01T01:10:00.900Z") });
			const dispatch = (dispatchId: string, attempt = 1) => ({
				dispatchId,
				turnId: "turn-1",
				actionId: "action-1",
				attempt,
				leaseExpiresAt: new Date("2026-01-01T00:11:00Z"),
			});

			it("consumes a bootstrap once and never again for a finished generation", async () => {
				const store = await makeStore();
				await store.putComputer(computerOnGeneration(2));
				expect(await store.consumeOwnerBootstrap("tenant-a", bootstrap("owner-wrong-generation", 1))).toBeNull();
				const consumed = await store.consumeOwnerBootstrap("tenant-a", bootstrap("owner-a", 2));
				expect(consumed).toMatchObject({ ownerId: "owner-a", ownerGeneration: 2, ownerProtocolVersion: 1 });
				expect(consumed?.ownerStartedAt?.getTime()).toBe(new Date("2026-01-01T00:10:00Z").getTime());
				expect(consumed?.ownerCredentialsExpireAt?.getTime()).toBe(new Date("2026-01-01T01:10:00Z").getTime());
				expect((await store.getComputer("tenant-a"))?.ownerCredentialsExpireAt?.getTime()).toBe(new Date("2026-01-01T01:10:00Z").getTime());
				expect(await store.consumeOwnerBootstrap("tenant-a", bootstrap("owner-a", 2))).toBeNull();
				expect(await store.consumeOwnerBootstrap("tenant-none", bootstrap("owner-a", 2))).toBeNull();
			});

			it("clears the owner fields when a new generation is claimed and keeps the last owner generation", async () => {
				const store = await makeStore();
				await store.putComputer(computerOnGeneration(1));
				await store.consumeOwnerBootstrap("tenant-a", bootstrap("owner-a", 1));
				await store.updateOwnerPresence("tenant-a", "owner-a", { idleSinceAt: new Date("2026-01-01T00:10:30Z") });
				expect(await store.offerOwnerDispatch("tenant-a", "owner-a", null, dispatch("d-1"))).toBe(true);
				const claimed = await store.claimHostStartGeneration("tenant-a", 1, new Date("2026-01-01T00:12:00Z"));
				expect(claimed?.hostStartGeneration).toBe(2);
				expect(claimed?.ownerId).toBeUndefined();
				expect(claimed?.idleSinceAt).toBeUndefined();
				expect(claimed?.ownerCredentialsExpireAt).toBeUndefined();
				expect(claimed?.ownerStartedAt).toBeUndefined();
				expect(claimed?.dispatchId).toBeUndefined();
				expect(claimed?.ownerGeneration).toBe(1);
				expect(await store.consumeOwnerBootstrap("tenant-a", bootstrap("owner-b", 1))).toBeNull();
			});

			it("changes the presence of the live owner only", async () => {
				const store = await makeStore();
				await store.putComputer(computerOnGeneration(1));
				expect(await store.updateOwnerPresence("tenant-a", "owner-a", { protocolVersion: 2 })).toBe(false);
				await store.consumeOwnerBootstrap("tenant-a", bootstrap("owner-a", 1));
				expect(await store.updateOwnerPresence("tenant-a", "owner-someone-else", { idleSinceAt: T0 })).toBe(false);
				expect(await store.updateOwnerPresence("tenant-a", "owner-a", { protocolVersion: 2, idleSinceAt: T0 })).toBe(true);
				expect(await store.getComputer("tenant-a")).toMatchObject({ ownerProtocolVersion: 2, idleSinceAt: T0 });
				expect(await store.updateOwnerPresence("tenant-a", "owner-a", { idleSinceAt: null })).toBe(true);
				expect((await store.getComputer("tenant-a"))?.idleSinceAt).toBeUndefined();
			});

			it("offers a dispatch only over the dispatch it was judged against, and an approved stop and an offer cannot both stand", async () => {
				const store = await makeStore();
				await store.putComputer(computerOnGeneration(1));
				await store.consumeOwnerBootstrap("tenant-a", bootstrap("owner-a", 1));
				expect(await store.offerOwnerDispatch("tenant-a", "owner-a", "d-ghost", dispatch("d-1"))).toBe(false);
				expect(await store.offerOwnerDispatch("tenant-a", "owner-a", null, dispatch("d-1"))).toBe(true);
				expect(await store.offerOwnerDispatch("tenant-a", "owner-a", null, dispatch("d-2"))).toBe(false);
				expect(await store.approveOwnerStop("tenant-a", "owner-a", null, null, T0)).toBe(false);
				expect(await store.offerOwnerDispatch("tenant-a", "owner-a", "d-1", dispatch("d-2", 2))).toBe(true);
				expect(await store.approveOwnerStop("tenant-a", "owner-a", "d-2", null, T0)).toBe(true);
				expect(await store.offerOwnerDispatch("tenant-a", "owner-a", "d-2", dispatch("d-3", 3))).toBe(false);
				expect(await store.getComputer("tenant-a")).toMatchObject({ dispatchId: "d-2", dispatchAttempt: 2, ownerStopApprovedAt: T0 });
			});

			describe("recording a credential renewal", () => {
				const supervisorRenewal = (seenRenewedAt: Date | null, renewedAtSeconds: number, expireSeconds: number) =>
					({
						kind: "supervisor" as const,
						seenRenewedAt,
						renewedAt: new Date(T0.getTime() + renewedAtSeconds * 1000 + 400),
						credentialsExpireAt: new Date(T0.getTime() + expireSeconds * 1000 + 700),
					});
				const turnRenewal = (dispatchId: string, seenRenewedAt: Date | null, renewedAtSeconds: number) =>
					({ kind: "turn" as const, dispatchId, seenRenewedAt, renewedAt: new Date(T0.getTime() + renewedAtSeconds * 1000 + 400) });
				const liveOwner = async (store: MessagingStore): Promise<void> => {
					await store.putComputer(computerOnGeneration(1));
					await store.consumeOwnerBootstrap("tenant-a", bootstrap("owner-a", 1));
				};

				it("records a supervisor renewal once for the value that was read, at second precision, and moves the credential expiry", async () => {
					const store = await makeStore();
					await liveOwner(store);
					expect(await store.renewOwnerCredentials("tenant-a", "owner-a", 1, supervisorRenewal(null, 2400, 6000))).toBe(true);
					const renewed = await store.getComputer("tenant-a");
					expect(renewed?.ownerCredentialsRenewedAt?.getTime()).toBe(T0.getTime() + 2400 * 1000);
					expect(renewed?.ownerCredentialsExpireAt?.getTime()).toBe(T0.getTime() + 6000 * 1000);
					expect(await store.renewOwnerCredentials("tenant-a", "owner-a", 1, supervisorRenewal(null, 2401, 6001))).toBe(false);
					expect(await store.renewOwnerCredentials("tenant-a", "owner-a", 1, supervisorRenewal(new Date(T0.getTime() + 1000), 2402, 6002))).toBe(false);
					expect((await store.getComputer("tenant-a"))?.ownerCredentialsExpireAt?.getTime()).toBe(T0.getTime() + 6000 * 1000);
					expect(await store.renewOwnerCredentials("tenant-a", "owner-a", 1, supervisorRenewal(new Date(T0.getTime() + 2400 * 1000), 4800, 8400))).toBe(true);
					expect((await store.getComputer("tenant-a"))?.ownerCredentialsExpireAt?.getTime()).toBe(T0.getTime() + 8400 * 1000);
				});

				it("records a renewal only for the live owner of the generation with no approved stop", async () => {
					const store = await makeStore();
					expect(await store.renewOwnerCredentials("tenant-none", "owner-a", 1, supervisorRenewal(null, 10, 3600))).toBe(false);
					await liveOwner(store);
					expect(await store.renewOwnerCredentials("tenant-a", "owner-someone-else", 1, supervisorRenewal(null, 10, 3600))).toBe(false);
					expect(await store.renewOwnerCredentials("tenant-a", "owner-a", 2, supervisorRenewal(null, 10, 3600))).toBe(false);
					expect(await store.approveOwnerStop("tenant-a", "owner-a", null, null, T0)).toBe(true);
					expect(await store.renewOwnerCredentials("tenant-a", "owner-a", 1, supervisorRenewal(null, 10, 3600))).toBe(false);
					expect(await store.renewOwnerCredentials("tenant-a", "owner-a", 1, turnRenewal("d-1", null, 10))).toBe(false);
					expect((await store.getComputer("tenant-a"))?.ownerCredentialsRenewedAt).toBeUndefined();
				});

				it("limits a turn renewal to the stored dispatch and keeps the two kinds apart", async () => {
					const store = await makeStore();
					await liveOwner(store);
					expect(await store.renewOwnerCredentials("tenant-a", "owner-a", 1, turnRenewal("d-1", null, 10))).toBe(false);
					expect(await store.offerOwnerDispatch("tenant-a", "owner-a", null, dispatch("d-1"))).toBe(true);
					expect(await store.renewOwnerCredentials("tenant-a", "owner-a", 1, turnRenewal("d-ghost", null, 10))).toBe(false);
					expect(await store.renewOwnerCredentials("tenant-a", "owner-a", 1, turnRenewal("d-1", null, 10))).toBe(true);
					expect(await store.renewOwnerCredentials("tenant-a", "owner-a", 1, turnRenewal("d-1", null, 11))).toBe(false);
					expect(await store.renewOwnerCredentials("tenant-a", "owner-a", 1, supervisorRenewal(null, 12, 3700))).toBe(true);
					const renewed = await store.getComputer("tenant-a");
					expect(renewed?.dispatchCredentialsRenewedAt?.getTime()).toBe(T0.getTime() + 10 * 1000);
					expect(renewed?.ownerCredentialsRenewedAt?.getTime()).toBe(T0.getTime() + 12 * 1000);
				});

				it("starts the turn renewal limit over with every dispatch offer and clears both marks with the owner", async () => {
					const store = await makeStore();
					await liveOwner(store);
					await store.offerOwnerDispatch("tenant-a", "owner-a", null, dispatch("d-1"));
					await store.renewOwnerCredentials("tenant-a", "owner-a", 1, turnRenewal("d-1", null, 10));
					await store.renewOwnerCredentials("tenant-a", "owner-a", 1, supervisorRenewal(null, 12, 3700));
					expect(await store.offerOwnerDispatch("tenant-a", "owner-a", "d-1", dispatch("d-2", 2))).toBe(true);
					const offered = await store.getComputer("tenant-a");
					expect(offered?.dispatchCredentialsRenewedAt).toBeUndefined();
					expect(offered?.ownerCredentialsRenewedAt?.getTime()).toBe(T0.getTime() + 12 * 1000);
					expect(await store.renewOwnerCredentials("tenant-a", "owner-a", 1, turnRenewal("d-2", null, 20))).toBe(true);
					const claimed = await store.claimHostStartGeneration("tenant-a", 1, new Date("2026-01-01T00:12:00Z"));
					expect(claimed?.ownerCredentialsRenewedAt).toBeUndefined();
					expect(claimed?.dispatchCredentialsRenewedAt).toBeUndefined();
				});

				it("clears the renewal marks of a previous owner when the next bootstrap is consumed", async () => {
					const store = await makeStore();
					await liveOwner(store);
					await store.offerOwnerDispatch("tenant-a", "owner-a", null, dispatch("d-1"));
					await store.renewOwnerCredentials("tenant-a", "owner-a", 1, turnRenewal("d-1", null, 10));
					await store.renewOwnerCredentials("tenant-a", "owner-a", 1, supervisorRenewal(null, 12, 3700));
					const previous = await store.getComputer("tenant-a");
					await store.putComputer({ ...previous!, hostStartGeneration: 2, hostStartDispatchedGeneration: 2 });
					const next = await store.consumeOwnerBootstrap("tenant-a", bootstrap("owner-b", 2));
					expect(next?.ownerId).toBe("owner-b");
					expect(next?.ownerCredentialsRenewedAt).toBeUndefined();
					expect(next?.dispatchCredentialsRenewedAt).toBeUndefined();
					const stored = await store.getComputer("tenant-a");
					expect(stored?.ownerCredentialsRenewedAt).toBeUndefined();
					expect(stored?.dispatchCredentialsRenewedAt).toBeUndefined();
					expect(stored?.ownerCredentialsExpireAt?.getTime()).toBe(new Date("2026-01-01T01:10:00Z").getTime());
				});
			});

			const racingAfterFirstComputerRead = (store: MessagingStore, race: () => Promise<unknown>): MessagingStore => {
				let raced = false;
				return new Proxy(store, {
					get(target, property) {
						const value = Reflect.get(target, property) as unknown;
						if (property === "getComputer") {
							return async (tenantId: string) => {
								const computer = await target.getComputer(tenantId);
								if (!raced) {
									raced = true;
									await race();
								}
								return computer;
							};
						}
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
			};

			it("records a snapshot publish without reverting a field written between its read and its write", async () => {
				const store = await makeStore();
				await store.putComputer({ ...computerOnGeneration(1), snapshotUri: "s3://snapshots/tenant-a", snapshotChecksum: "checksum-1", snapshotGeneration: 1, diskDirty: true });
				await store.putWorker({ workerId: "owner-a", tenantId: "tenant-a", costClass: "local", capabilities: ["cpu", "computer"], tokenHash: "hash", lastHeartbeatAt: T0, computerId: "c-1" });
				await store.consumeOwnerBootstrap("tenant-a", bootstrap("owner-a", 1));
				const racing = racingAfterFirstComputerRead(store, () => store.updateOwnerPresence("tenant-a", "owner-a", { idleSinceAt: T0 }));
				const published = await recordHostSnapshotPublished("tenant-a", "owner-a", "checksum-2", null, { store: racing });
				expect(published).toMatchObject({ snapshotChecksum: "checksum-2", snapshotGeneration: 2, diskDirty: false });
				expect(await store.getComputer("tenant-a")).toMatchObject({ snapshotChecksum: "checksum-2", snapshotGeneration: 2, diskDirty: false, idleSinceAt: T0 });
				expect((await store.getWorker("tenant-a", "owner-a"))?.hydratedSnapshotGeneration).toBe(2);
			});

			it("records a hydrate without reverting a field written between its read and its write", async () => {
				const store = await makeStore();
				await store.putComputer({ ...computerOnGeneration(1), snapshotUri: "s3://snapshots/tenant-a", snapshotGeneration: 3, hydrateRequired: true, diskDirty: true, intendedHostWorkerId: "owner-a" });
				await store.putWorker({ workerId: "owner-a", tenantId: "tenant-a", costClass: "local", capabilities: ["cpu", "computer"], tokenHash: "hash", lastHeartbeatAt: T0, computerId: "c-1" });
				await store.consumeOwnerBootstrap("tenant-a", bootstrap("owner-a", 1));
				const racing = racingAfterFirstComputerRead(store, () => store.updateOwnerPresence("tenant-a", "owner-a", { idleSinceAt: T0 }));
				await recordHostHydrated("tenant-a", "owner-a", { store: racing });
				const after = await store.getComputer("tenant-a");
				expect(after).toMatchObject({ hydrateRequired: false, diskDirty: false, idleSinceAt: T0 });
				expect(after?.intendedHostWorkerId).toBeUndefined();
				expect((await store.getWorker("tenant-a", "owner-a"))?.hydratedSnapshotGeneration).toBe(3);
			});

			it("records a poll only when its sequence is not older than the recorded one", async () => {
				const store = await makeStore();
				const worker: Worker = { workerId: "owner-a", tenantId: "tenant-a", costClass: "local", capabilities: ["computer", "cpu"], tokenHash: "hash", lastHeartbeatAt: T0 };
				expect(await store.recordOwnerPoll("tenant-a", "owner-a", { sequence: 1, state: "idle", at: T0, paceMilliseconds: 1000 })).toBe(false);
				await store.putWorker(worker);
				const later = new Date(T0.getTime() + 5000);
				expect(await store.recordOwnerPoll("tenant-a", "owner-a", { sequence: 4, state: "idle", at: later, paceMilliseconds: 1000 })).toBe(true);
				expect(await store.recordOwnerPoll("tenant-a", "owner-a", { sequence: 4, state: "idle", at: later, paceMilliseconds: 1000 })).toBe(true);
				expect(await store.recordOwnerPoll("tenant-a", "owner-a", { sequence: 3, state: "serving", at: later, paceMilliseconds: 5000 })).toBe(false);
				expect(await store.getWorker("tenant-a", "owner-a")).toMatchObject({ pollSequence: 4, pollState: "idle", lastHeartbeatAt: later });
			});
		});

		describe("file requests, the interactive window and the audit family", () => {
			const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);
			const liveComputer = async (store: MessagingStore): Promise<void> => {
				await store.putComputer({
					computerId: "c-1",
					tenantId: "tenant-a",
					policy: "prefer_local",
					stopped: false,
					modelReady: true,
					workspaceReady: false,
					browserReady: false,
					hostStartGeneration: 1,
					hostStartDispatchedGeneration: 1,
					snapshotGeneration: 0,
					diskDirty: false,
					hydrateRequired: false,
				});
				await store.consumeOwnerBootstrap("tenant-a", { ownerId: "owner-a", generation: 1, protocolVersion: 2, startedAt: T0, credentialsExpireAt: new Date(T0.getTime() + 3600000) });
			};
			const operation = (operationId: string, queuedSeconds = 0, overrides: Partial<LiveFileOperation> = {}): LiveFileOperation => ({
				operationId,
				tenantId: "tenant-a",
				computerId: "c-1",
				userId: "mia",
				ownerId: "owner-a",
				generation: 1,
				kind: "read",
				status: "pending",
				request: JSON.stringify({ kind: "read", path: "/workspace/a", offset: 0, length: 10, mask: true }),
				queuedAt: at(queuedSeconds),
				expiresAt: at(queuedSeconds + 120),
				...overrides,
			});
			const delivery = (sequence: number, seconds = 1) => ({ ownerId: "owner-a", generation: 1, sequence, at: at(seconds) });

			it("queues a request with the computer record in one step, only for the live owner with no approved stop", async () => {
				const store = await makeStore();
				await liveComputer(store);
				expect(await store.queueLiveFileOperation({ ...operation("op-wrong-owner"), ownerId: "owner-b" }, at(45))).toBe(false);
				expect(await store.queueLiveFileOperation({ ...operation("op-wrong-generation"), generation: 2 }, at(45))).toBe(false);
				expect(await store.queueLiveFileOperation(operation("op-1"), at(45))).toBe(true);
				expect(await store.queueLiveFileOperation(operation("op-1"), at(46))).toBe(false);
				expect(await store.getComputer("tenant-a")).toMatchObject({ fileOperationId: "op-1", interactiveUntilAt: at(45) });
				expect((await store.listLiveFileOperations("tenant-a", at(1))).map((entry) => entry.operationId)).toEqual(["op-1"]);
				await store.approveOwnerStop("tenant-a", "owner-a", null, "op-1", at(2));
				expect(await store.queueLiveFileOperation(operation("op-2"), at(45))).toBe(false);
				expect(await store.getLiveFileOperation("tenant-a", "op-2", at(3))).toBeNull();
			});

			it("approves a stop only over the file operation id it was judged against", async () => {
				const store = await makeStore();
				await liveComputer(store);
				await store.queueLiveFileOperation(operation("op-1"), at(45));
				expect(await store.approveOwnerStop("tenant-a", "owner-a", null, null, at(2))).toBe(false);
				expect(await store.approveOwnerStop("tenant-a", "owner-a", null, "op-ghost", at(2))).toBe(false);
				expect(await store.approveOwnerStop("tenant-a", "owner-a", null, "op-1", at(2))).toBe(true);
			});

			it("delivers a pending request once, to the owner it names, and not after it expired", async () => {
				const store = await makeStore();
				await liveComputer(store);
				await store.queueLiveFileOperation(operation("op-1"), at(45));
				expect(await store.deliverLiveFileOperation("tenant-a", "op-1", { ...delivery(3), ownerId: "owner-b" })).toBe(false);
				expect(await store.deliverLiveFileOperation("tenant-a", "op-1", delivery(3))).toBe(true);
				expect(await store.deliverLiveFileOperation("tenant-a", "op-1", delivery(4))).toBe(false);
				expect(await store.getLiveFileOperation("tenant-a", "op-1", at(2))).toMatchObject({ status: "delivered", deliveredSequence: 3, deliveredAt: at(1) });
				await store.queueLiveFileOperation(operation("op-late", 0), at(45));
				expect(await store.deliverLiveFileOperation("tenant-a", "op-late", delivery(5, 121))).toBe(false);
			});

			it("abandons only a pending request and removes its payload", async () => {
				const store = await makeStore();
				await liveComputer(store);
				await store.queueLiveFileOperation(operation("op-1"), at(45));
				await store.queueLiveFileOperation(operation("op-2"), at(45));
				expect(await store.abandonLiveFileOperation("tenant-a", "op-1", at(9))).toBe("abandoned");
				expect((await store.getLiveFileOperation("tenant-a", "op-1", at(9)))?.request).toBeUndefined();
				expect(await store.deliverLiveFileOperation("tenant-a", "op-1", delivery(3))).toBe(false);
				await store.deliverLiveFileOperation("tenant-a", "op-2", delivery(3));
				expect(await store.abandonLiveFileOperation("tenant-a", "op-2", at(9))).toBe("delivered");
				expect(await store.abandonLiveFileOperation("tenant-a", "op-none", at(9))).toBe("absent");
			});

			it("completes only a delivered request, once, and marks a waiter that gave up", async () => {
				const store = await makeStore();
				await liveComputer(store);
				await store.queueLiveFileOperation(operation("op-1"), at(45));
				expect(await store.completeLiveFileOperation("tenant-a", "op-1", "{}", at(2))).toBeNull();
				expect(await store.markLiveFileOperationWaiterGone("tenant-a", "op-1")).toBe(false);
				await store.deliverLiveFileOperation("tenant-a", "op-1", delivery(3));
				expect(await store.markLiveFileOperationWaiterGone("tenant-a", "op-1")).toBe(true);
				const done = await store.completeLiveFileOperation("tenant-a", "op-1", '{"status":"ok"}', at(2));
				expect(done).toMatchObject({ status: "done", outcome: '{"status":"ok"}', waiterGone: true });
				expect(await store.completeLiveFileOperation("tenant-a", "op-1", "{}", at(3))).toBeNull();
				await store.deleteLiveFileOperation("tenant-a", "op-1");
				await store.deleteLiveFileOperation("tenant-a", "op-1");
				expect(await store.getLiveFileOperation("tenant-a", "op-1", at(3))).toBeNull();
			});

			it("keeps an answer of 2000 listing entries, which is more than a table item holds as text", async () => {
				const store = await makeStore();
				await liveComputer(store);
				await store.queueLiveFileOperation(operation("op-big"), at(45));
				await store.deliverLiveFileOperation("tenant-a", "op-big", delivery(3));
				const entries = Array.from({ length: 2000 }, (_, number) => ({
					name: `file-${number}.txt`,
					path: `/workspace/many/file-${number}.txt`,
					kind: "file",
					size: number,
					mode: "664",
					sha256: null,
					link_target: null,
					modified_at: "2026-01-01T00:00:00.000Z",
					overlay: "none",
					tree_sha256: null,
				}));
				const outcome = JSON.stringify({ status: "ok", result: { kind: "list", resolved_path: "/workspace/many", entries, truncated: false } });
				expect(outcome.length).toBeGreaterThan(400_000);
				expect((await store.completeLiveFileOperation("tenant-a", "op-big", outcome, at(2)))?.outcome).toBe(outcome);
				expect((await store.getLiveFileOperation("tenant-a", "op-big", at(3)))?.outcome).toBe(outcome);
			});

			it("treats an item past its expiry as absent to every reader and counts only open requests", async () => {
				const store = await makeStore();
				await liveComputer(store);
				await store.queueLiveFileOperation(operation("op-old", 0), at(45));
				await store.queueLiveFileOperation(operation("op-new", 100), at(145));
				await store.queueLiveFileOperation(operation("op-done", 100), at(145));
				await store.deliverLiveFileOperation("tenant-a", "op-done", { ...delivery(1, 101) });
				await store.completeLiveFileOperation("tenant-a", "op-done", "{}", at(102));
				expect(await store.countOpenLiveFileOperations("tenant-a", at(110))).toBe(2);
				expect(await store.countOpenLiveFileOperations("tenant-a", at(121))).toBe(1);
				expect(await store.getLiveFileOperation("tenant-a", "op-old", at(121))).toBeNull();
				expect((await store.listLiveFileOperations("tenant-a", at(121))).map((entry) => entry.operationId)).toEqual(["op-done", "op-new"]);
				expect(await store.deliverLiveFileOperation("tenant-a", "op-old", delivery(9, 121))).toBe(false);
				expect(await store.completeLiveFileOperation("tenant-a", "op-old", "{}", at(121))).toBeNull();
				expect(await store.abandonLiveFileOperation("tenant-a", "op-old", at(121))).not.toBe("pending");
			});

			it("moves the interactive window of the live owner only, and not after a stop was approved", async () => {
				const store = await makeStore();
				await liveComputer(store);
				expect(await store.touchInteractiveWindow("tenant-a", "owner-b", 1, at(45))).toBe(false);
				expect(await store.touchInteractiveWindow("tenant-a", "owner-a", 2, at(45))).toBe(false);
				expect(await store.touchInteractiveWindow("tenant-a", "owner-a", 1, at(45))).toBe(true);
				expect((await store.getComputer("tenant-a"))?.interactiveUntilAt).toEqual(at(45));
				await store.approveOwnerStop("tenant-a", "owner-a", null, null, at(1));
				expect(await store.touchInteractiveWindow("tenant-a", "owner-a", 1, at(90))).toBe(false);
			});

			it("clears the interactive window and the file operation id with the other owner fields", async () => {
				const store = await makeStore();
				await liveComputer(store);
				await store.queueLiveFileOperation(operation("op-1"), at(45));
				const claimed = await store.claimHostStartGeneration("tenant-a", 1, at(60));
				expect(claimed?.interactiveUntilAt).toBeUndefined();
				expect(claimed?.fileOperationId).toBeUndefined();
			});

			it("writes an audit record once, finishes it, and hides it after its expiry", async () => {
				const store = await makeStore();
				const record: FileAuditRecord = {
					tenantId: "tenant-a",
					computerId: "c-1",
					userId: "mia",
					operationId: "op-1",
					operation: "write",
					path: "/workspace/a",
					source: "live",
					outcome: "pending",
					at: at(5),
					expiresAt: at(5 + 90 * 24 * 3600),
					sha256After: "a".repeat(64),
					secretName: false,
				};
				await store.putFileAudit(record);
				await expect(store.putFileAudit(record)).rejects.toBeDefined();
				expect(await store.finalizeFileAudit("tenant-a", at(99).getTime(), "op-1", { outcome: "ok", finishedAt: at(6) })).toBe(false);
				const finish = { outcome: "conflict" as const, finishedAt: at(6), errorCode: "precondition_failed", resolvedPath: "/workspace/a", flags: ["integrity_mismatch"] };
				expect(await store.finalizeFileAudit("tenant-a", at(5).getTime(), "op-1", finish)).toBe(true);
				expect(await store.finalizeFileAudit("tenant-a", at(5).getTime(), "op-1", finish)).toBe(true);
				expect(await store.getFileAudit("tenant-a", at(5).getTime(), "op-1", at(7))).toMatchObject({
					outcome: "conflict",
					errorCode: "precondition_failed",
					resolvedPath: "/workspace/a",
					flags: ["integrity_mismatch"],
					sha256After: "a".repeat(64),
					finishedAt: at(6),
				});
				expect((await store.listFileAuditRecords("tenant-a", at(7))).map((entry) => entry.operationId)).toEqual(["op-1"]);
				expect(await store.listFileAuditRecords("tenant-a", at(5 + 91 * 24 * 3600))).toEqual([]);
				expect(await store.getFileAudit("tenant-a", at(5).getTime(), "op-1", at(5 + 91 * 24 * 3600))).toBeNull();
			});

			it("counts rate classes of one user separately within a window", async () => {
				const store = await makeStore();
				expect(await store.incrementRateCounter("user-1", "file_rate#read", T0, 60)).toBe(1);
				expect(await store.incrementRateCounter("user-1", "file_rate#read", at(30), 60)).toBe(2);
				expect(await store.incrementRateCounter("user-1", "file_rate#write", at(30), 60)).toBe(1);
				expect(await store.incrementRateCounter("user-2", "file_rate#read", at(30), 60)).toBe(1);
				expect(await store.incrementRateCounter("user-1", "file_rate#read", at(60), 60)).toBe(1);
			});
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
