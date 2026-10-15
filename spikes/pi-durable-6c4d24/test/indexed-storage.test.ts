import { randomUUID } from "node:crypto";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { IndexedStorage } from "../src/indexed-storage.ts";
import { createLocalClient, createLocalS3, ensureBucket, ensureTable } from "../src/table.ts";

const client = createLocalClient();
const s3 = createLocalS3();
const tableName = "pi-durable-index-conformance";
const bucket = "pi-durable-conformance";

beforeAll(async () => {
	await ensureTable(client, tableName);
	await ensureBucket(s3, bucket);
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
