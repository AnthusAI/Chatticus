import { randomUUID } from "node:crypto";
import type { EntryId, StorageWrite } from "@earendil-works/pi-durable";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { DynamoDbStorage } from "../src/dynamodb-storage.ts";
import { context, TABLE_NAME } from "../src/owner.ts";
import { writeResult } from "../src/report.ts";
import { createLocalClient, ensureTable } from "../src/table.ts";

const client = createLocalClient();
await ensureTable(client, TABLE_NAME);
const storage = await DynamoDbStorage.open({ client, tableName: TABLE_NAME, storageId: `limits#${randomUUID()}` });
await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);

async function attempt(name: string, writes: StorageWrite[]) {
	try {
		const seq = await storage.commit(writes, context);
		return { name, outcome: `committed as seq ${seq}`, measurement: storage.measurements.at(-1) };
	} catch (error) {
		return { name, outcome: `${(error as Error).name}: ${(error as Error).message}` };
	}
}

const entry = async (bytes: number): Promise<StorageWrite> => ({
	type: "entry",
	value: {
		id: await storage.mintId<EntryId>(),
		conversationId: ROOT_CONVERSATION_ID,
		kind: "pi.assistant",
		data: { text: "x".repeat(bytes) },
	},
});

const results = [];
results.push(await attempt("98 entries in one commit (99 items with META)", await Promise.all(Array.from({ length: 98 }, () => entry(10)))));
results.push(await attempt("100 entries in one commit (101 items with META)", await Promise.all(Array.from({ length: 100 }, () => entry(10)))));
results.push(await attempt("one 390 KB entry", [await entry(390 * 1024)]));
results.push(await attempt("one 410 KB entry", [await entry(410 * 1024)]));
results.push(
	await attempt(
		"twelve 350 KB entries (4.2 MB)",
		await Promise.all(Array.from({ length: 12 }, () => entry(350 * 1024))),
	),
);
writeResult("limits.json", results);
console.log(JSON.stringify(results, null, 2));
