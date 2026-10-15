import { randomUUID } from "node:crypto";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { DynamoDbStorage } from "../src/dynamodb-storage.ts";
import { createLocalClient, ensureTable } from "../src/table.ts";

const client = createLocalClient();
const tableName = "pi-durable-conformance";

beforeAll(async () => {
	await ensureTable(client, tableName);
});

registerStorageConformance({ describe, expect, it }, "DynamoDbStorage", async (use) => {
	const storage = await DynamoDbStorage.open({ client, tableName, storageId: `conformance#${randomUUID()}` });
	await use(storage);
});
