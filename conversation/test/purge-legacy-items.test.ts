import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DynamoDBClient, PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { beforeAll, describe, expect, it } from "vitest";
import { createMessagingTable } from "../features-support/messaging-table.ts";
import type { Channel, ChannelMessageRecord } from "../src/domain/channels.ts";
import { transcriptChecksum } from "../src/migration/legacy-layout.ts";
import { type VerifiedMarker, writeVerifiedMarker } from "../src/migration/migration-state.ts";
import { purgeLegacyItems } from "../src/migration/purge.ts";
import { encodeChannel, encodeMessage } from "../src/store/codecs/channel.ts";
import { formatIsoDateTime } from "../src/store/codecs/util.ts";

const endpoint = process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5555";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };
const client = new DynamoDBClient({ endpoint, region: "us-east-1", credentials, maxAttempts: 1 });
const tableName = `purge-${randomUUID()}`;
const verifiedAt = new Date("2026-09-01T00:00:00Z");
const afterFourteenDays = new Date("2026-09-15T00:00:01Z");
const beforeFourteenDays = new Date("2026-09-14T23:59:00Z");

beforeAll(async () => {
	await createMessagingTable(client, tableName);
});

type Scenario = { tenantId: string; channelId: string; messages: ChannelMessageRecord[] };

async function seedChannel(
	messageCount: number,
	options: { marker?: Partial<VerifiedMarker> | null; extraSeqAbove?: number } = {},
): Promise<Scenario> {
	const tenantId = `tenant-${randomUUID()}`;
	const channelId = "chan-general";
	const channel: Channel = {
		channelId,
		tenantId,
		kind: "named",
		name: "General",
		participants: [{ kind: "bot", actorId: "ada" }],
		nextSeq: messageCount + 1 + (options.extraSeqAbove ?? 0),
	};
	await client.send(new PutItemCommand({ TableName: tableName, Item: encodeChannel(channel) }));
	const messages: ChannelMessageRecord[] = [];
	for (let seq = 1; seq <= messageCount + (options.extraSeqAbove ?? 0); seq += 1) {
		const message: ChannelMessageRecord = {
			messageId: `${tenantId}-m${seq}`,
			channelId,
			tenantId,
			seq,
			authorKind: "human",
			authorId: "ryan",
			body: `message ${seq}`,
			addressedToBotId: null,
			createdAt: new Date(Date.UTC(2026, 7, 30, 9, 0, seq)),
		};
		messages.push(message);
		await client.send(new PutItemCommand({ TableName: tableName, Item: encodeMessage(message) }));
	}
	if (options.marker !== null) {
		const covered = messages.slice(0, messageCount).map((message) => ({
			...message,
			createdAt: formatIsoDateTime(message.createdAt),
		}));
		await writeVerifiedMarker(client, tableName, {
			tenantId,
			channelId,
			verifiedThroughSeq: messageCount,
			messageCount,
			checksum: transcriptChecksum(covered),
			verifiedAt: formatIsoDateTime(verifiedAt),
			...options.marker,
		});
	}
	return { tenantId, channelId, messages };
}

async function remainingSortKeys(scenario: Scenario): Promise<string[]> {
	const response = await client.send(
		new QueryCommand({
			TableName: tableName,
			KeyConditionExpression: "pk = :pk",
			ExpressionAttributeValues: { ":pk": { S: `${scenario.tenantId}#channel#${scenario.channelId}` } },
			ConsistentRead: true,
		}),
	);
	return (response.Items ?? []).map((item) => item.sk!.S!);
}

const messageKeys = (count: number): string[] =>
	Array.from({ length: count }, (_unused, index) => `msg#${String(index + 1).padStart(10, "0")}`);

const deps = (now: Date) => ({ client, messagingTableName: tableName, clock: { now: () => now } });

describe("purgeLegacyItems", () => {
	it("deletes only the verified old message items and nothing else when executed after the minimum age", async () => {
		const scenario = await seedChannel(5, { extraSeqAbove: 2 });
		const results = await purgeLegacyItems(deps(afterFourteenDays), { tenantId: scenario.tenantId }, { execute: true, minimumAgeDays: 14 });
		expect(results).toEqual([{ tenantId: scenario.tenantId, channelId: "chan-general", outcome: "purged", items: 5 }]);
		expect(await remainingSortKeys(scenario)).toEqual(["meta", "msg#0000000006", "msg#0000000007"]);
		const marker = await client.send(
			new QueryCommand({
				TableName: tableName,
				KeyConditionExpression: "pk = :pk",
				ExpressionAttributeValues: { ":pk": { S: `VERIFIED#${scenario.tenantId}#chan-general` } },
			}),
		);
		expect(marker.Items).toHaveLength(1);
	});

	it("does not delete anything without the execute option and says what it would delete", async () => {
		const scenario = await seedChannel(4);
		const results = await purgeLegacyItems(deps(afterFourteenDays), { tenantId: scenario.tenantId }, { execute: false, minimumAgeDays: 14 });
		expect(results).toEqual([{ tenantId: scenario.tenantId, channelId: "chan-general", outcome: "would_purge", items: 4 }]);
		expect(await remainingSortKeys(scenario)).toEqual(["meta", ...messageKeys(4)]);
	});

	it("never deletes a channel without a verified marker", async () => {
		const scenario = await seedChannel(3, { marker: null });
		const results = await purgeLegacyItems(deps(afterFourteenDays), { tenantId: scenario.tenantId }, { execute: true, minimumAgeDays: 14 });
		expect(results).toEqual([
			{ tenantId: scenario.tenantId, channelId: "chan-general", outcome: "skipped", items: 0, reason: "no verified marker" },
		]);
		expect(await remainingSortKeys(scenario)).toEqual(["meta", ...messageKeys(3)]);
	});

	it("never deletes before the marker is old enough", async () => {
		const scenario = await seedChannel(3);
		const results = await purgeLegacyItems(deps(beforeFourteenDays), { tenantId: scenario.tenantId }, { execute: true, minimumAgeDays: 14 });
		expect(results[0]).toMatchObject({ outcome: "skipped", items: 0 });
		expect(results[0]!.reason).toContain("needs 14");
		expect(await remainingSortKeys(scenario)).toEqual(["meta", ...messageKeys(3)]);
	});

	it("never deletes when an old item changed since the verification", async () => {
		const scenario = await seedChannel(3);
		await client.send(
			new PutItemCommand({ TableName: tableName, Item: encodeMessage({ ...scenario.messages[1]!, body: "edited afterwards" }) }),
		);
		const results = await purgeLegacyItems(deps(afterFourteenDays), { tenantId: scenario.tenantId }, { execute: true, minimumAgeDays: 14 });
		expect(results[0]).toMatchObject({ outcome: "skipped", reason: "the old items no longer match the verified marker" });
		expect(await remainingSortKeys(scenario)).toEqual(["meta", ...messageKeys(3)]);
	});

	it("never deletes when the marker covers more messages than the old items hold", async () => {
		const scenario = await seedChannel(3, { marker: { messageCount: 4, verifiedThroughSeq: 4 } });
		const results = await purgeLegacyItems(deps(afterFourteenDays), { tenantId: scenario.tenantId }, { execute: true, minimumAgeDays: 14 });
		expect(results[0]).toMatchObject({ outcome: "skipped" });
		expect(await remainingSortKeys(scenario)).toEqual(["meta", ...messageKeys(3)]);
	});

	it("purges only the channel it is scoped to", async () => {
		const first = await seedChannel(2);
		const results = await purgeLegacyItems(deps(afterFourteenDays), { tenantId: first.tenantId, channelId: "other" }, { execute: true, minimumAgeDays: 14 });
		expect(results).toEqual([]);
		expect(await remainingSortKeys(first)).toEqual(["meta", ...messageKeys(2)]);
	});
});

describe("purge-legacy-items command", () => {
	const run = (args: string[], extra: Record<string, string> = {}) =>
		spawnSync(process.execPath, ["bin/purge-legacy-items.ts", ...args], {
			encoding: "utf8",
			env: {
				PATH: process.env.PATH ?? "",
				AWS_ENDPOINT_URL: endpoint,
				AWS_REGION: "us-east-1",
				AWS_ACCESS_KEY_ID: "test",
				AWS_SECRET_ACCESS_KEY: "test",
				CHATTICUS_MESSAGING_TABLE: tableName,
				...extra,
			},
		});

	it("is a dry run unless --execute is given", async () => {
		const scenario = await seedChannel(3, { marker: { verifiedAt: "2020-01-01T00:00:00+00:00" } });
		const dry = run(["--environment", "development", "--tenant", scenario.tenantId]);
		expect(dry.status).toBe(0);
		expect(dry.stdout).toContain(`would_purge tenant=${scenario.tenantId} channel=chan-general items=3`);
		expect(dry.stdout).toContain("dry run: nothing was deleted");
		expect(await remainingSortKeys(scenario)).toEqual(["meta", ...messageKeys(3)]);
		const executed = run(["--environment", "development", "--tenant", scenario.tenantId, "--execute"]);
		expect(executed.status).toBe(0);
		expect(executed.stdout).toContain(`purged tenant=${scenario.tenantId} channel=chan-general items=3`);
		expect(await remainingSortKeys(scenario)).toEqual(["meta"]);
	});

	it("refuses to run without a named environment", () => {
		const result = run(["--execute"]);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("--environment must be one of development, staging, production");
	});
});
