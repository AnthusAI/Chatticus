import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, StorageWrite } from "@earendil-works/pi-durable";
import { beforeAll, describe, expect, it } from "vitest";
import { IndexedStorage } from "../src/storage/indexed-storage.ts";
import { fenceFor, OwnershipLost, storageIdFor } from "../src/storage/storage-support.ts";
import { createPiSessionBucket, createPiSessionTable } from "../src/storage/table-definition.ts";

const endpoint = process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5555";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };
const client = new DynamoDBClient({ endpoint, region: "us-east-1", credentials, maxAttempts: 1 });
const s3 = new S3Client({ endpoint, region: "us-east-1", credentials, forcePathStyle: true, maxAttempts: 1 });
const tableName = "pi-session-fence";
const bucket = "pi-session-fence";

beforeAll(async () => {
	await createPiSessionTable(client, tableName);
	await createPiSessionBucket(s3, bucket);
});

const freshStorageId = (): string => storageIdFor("tenant", "bot", randomUUID());

const conversationWrite = (id: ConversationId): StorageWrite => ({ type: "conversation", value: { id } });

const openFenced = (storageId: string, fence: number) =>
	IndexedStorage.open({ client, s3, tableName, bucket, storageId, fence });

describe("owner fence", () => {
	it("lets the claiming owner open fenced and commit", async () => {
		const storageId = freshStorageId();
		await IndexedStorage.claimOwnership({ client, tableName, storageId, fence: 1001 });
		const storage = await openFenced(storageId, 1001);
		const id = await storage.mintId<ConversationId>();
		await expect(storage.commit([conversationWrite(id)], BACKGROUND_CONTEXT)).resolves.toBe(1);
	});

	it("stops the first owner's next commit after a newer owner claims", async () => {
		const storageId = freshStorageId();
		await IndexedStorage.claimOwnership({ client, tableName, storageId, fence: 1001 });
		const first = await openFenced(storageId, 1001);
		const firstId = await first.mintId<ConversationId>();
		await first.commit([conversationWrite(firstId)], BACKGROUND_CONTEXT);
		await IndexedStorage.claimOwnership({ client, tableName, storageId, fence: 2001 });
		const second = await openFenced(storageId, 2001);
		const staleId = await first.mintId<ConversationId>();
		await expect(first.commit([conversationWrite(staleId)], BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(OwnershipLost);
		const secondId = await second.mintId<ConversationId>();
		await expect(second.commit([conversationWrite(secondId)], BACKGROUND_CONTEXT)).resolves.toBe(2);
	});

	it("lets an owner claim its own fence again", async () => {
		const storageId = freshStorageId();
		await IndexedStorage.claimOwnership({ client, tableName, storageId, fence: 1001 });
		await expect(IndexedStorage.claimOwnership({ client, tableName, storageId, fence: 1001 })).resolves.toBeUndefined();
	});

	it("refuses a claim older than the held fence", async () => {
		const storageId = freshStorageId();
		await IndexedStorage.claimOwnership({ client, tableName, storageId, fence: 2001 });
		await expect(IndexedStorage.claimOwnership({ client, tableName, storageId, fence: 1001 })).rejects.toThrow(
			"Owner fence moved: a newer owner holds this storage",
		);
	});
});

describe("fenceFor", () => {
	it("combines the prompt sequence and the turn token", () => {
		expect(fenceFor(1, 1)).toBe(1001);
		expect(fenceFor(2, 1)).toBe(2001);
		expect(fenceFor(7, 999)).toBe(7999);
	});

	it("orders a retry of one prompt below the next prompt", () => {
		expect(fenceFor(3, 999)).toBeLessThan(fenceFor(4, 1));
		expect(fenceFor(3, 1)).toBeLessThan(fenceFor(3, 2));
	});

	it("rejects a turn token outside 1 to 999", () => {
		expect(() => fenceFor(1, 0)).toThrow(RangeError);
		expect(() => fenceFor(1, 1000)).toThrow(RangeError);
		expect(() => fenceFor(1, -1)).toThrow(RangeError);
	});
});

describe("storageIdFor", () => {
	it("joins tenant, bot, and channel with hash separators", () => {
		expect(storageIdFor("t", "b", "c")).toBe("t#b#c");
	});
});
