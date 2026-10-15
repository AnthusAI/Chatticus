import { randomUUID } from "node:crypto";
import { Agent } from "node:http";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { IndexedStorage } from "../src/storage/indexed-storage.ts";
import { createPiSessionBucket, createPiSessionTable } from "../src/storage/table-definition.ts";

const endpoint = process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5555";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };
const httpAgent = new Agent({ keepAlive: true, maxSockets: 32 });
const client = new DynamoDBClient({ endpoint, region: "us-east-1", credentials, maxAttempts: 1, requestHandler: { httpAgent } });
const s3 = new S3Client({ endpoint, region: "us-east-1", credentials, forcePathStyle: true, maxAttempts: 1, requestHandler: { httpAgent } });
const tableName = `pi-session-conformance-${randomUUID()}`;
const bucket = `pi-session-conformance-${randomUUID()}`;

beforeAll(async () => {
	await createPiSessionTable(client, tableName);
	await createPiSessionBucket(s3, bucket);
});

const forgetfulCommitCache = {
	get: () => undefined,
	set: () => undefined,
	delete: () => undefined,
};

const SNAPSHOT_CASE_TIMEOUT_MILLISECONDS = 60_000;
const itWithRoomForSnapshots = ((name: string, body: () => unknown) =>
	it(name, body, SNAPSHOT_CASE_TIMEOUT_MILLISECONDS)) as unknown as typeof it;

registerStorageConformance({ describe, expect, it: itWithRoomForSnapshots }, "IndexedStorage with snapshots", async (use) => {
	const storage = await IndexedStorage.open({
		client,
		s3,
		tableName,
		bucket,
		storageId: `conformance#${randomUUID()}`,
		commitCache: forgetfulCommitCache,
		snapshotPolicy: { everyCommits: 3, atClose: true },
	});
	await use(storage);
});

registerStorageConformance({ describe, expect, it }, "IndexedStorage", async (use) => {
	const storage = await IndexedStorage.open({
		client,
		s3,
		tableName,
		bucket,
		storageId: `conformance#${randomUUID()}`,
	});
	await use(storage);
});
