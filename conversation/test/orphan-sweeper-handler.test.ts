import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handler } from "../src/lambdas/orphan-sweeper.ts";
import { openOwnerStorage } from "../src/pi/session.ts";
import { commitKey, storageIdFor } from "../src/storage/storage-support.ts";
import { createPiSessionBucket, createPiSessionTable } from "../src/storage/table-definition.ts";

const endpoint = process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5555";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };
const client = new DynamoDBClient({ endpoint, region: "us-east-1", credentials, maxAttempts: 1 });
const s3 = new S3Client({ endpoint, region: "us-east-1", credentials, forcePathStyle: true, maxAttempts: 1 });
const suffix = randomUUID();
const tableName = `sweeper-handler-${suffix}`;
const bucket = `sweeper-handler-${suffix}`;
const saved = { ...process.env };

beforeAll(async () => {
	await createPiSessionTable(client, tableName);
	await createPiSessionBucket(s3, bucket);
	Object.assign(process.env, {
		AWS_ENDPOINT_URL: endpoint,
		AWS_REGION: "us-east-1",
		AWS_ACCESS_KEY_ID: "test",
		AWS_SECRET_ACCESS_KEY: "test",
		CHATTICUS_CONVERSATIONS_TABLE: tableName,
		CHATTICUS_PI_SESSIONS_BUCKET: bucket,
		CHATTICUS_ORPHAN_GRACE_SECONDS: "0",
	});
});

afterAll(() => {
	process.env = saved;
});

describe("orphan sweeper handler", () => {
	it("sweeps every storage in the bucket and keeps committed objects", async () => {
		const storageId = storageIdFor("tenant", "bot", randomUUID());
		const first = await openOwnerStorage(storageId, { client, s3, tableName, bucket });
		const conversationId = await first.storage.mintId<ConversationId>();
		await first.storage.commit([{ type: "conversation", value: { id: conversationId } }], BACKGROUND_CONTEXT);
		await openOwnerStorage(storageId, { client, s3, tableName, bucket });
		await s3.send(
			new PutObjectCommand({
				Bucket: bucket,
				Key: commitKey(storageId, 2, 1),
				Body: JSON.stringify({ seq: 2, fence: 1, token: "crashed", writes: [] }),
			}),
		);
		const report = await handler();
		expect(report).toEqual({ deleted: 1, deletedSnapshots: 0, storages: 1 });
		const again = await handler({ storageIds: [storageId] });
		expect(again).toEqual({ deleted: 0, deletedSnapshots: 0, storages: 1 });
	});
});
