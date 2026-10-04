import { randomUUID } from "node:crypto";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { type EntryId, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { commitKey, IndexedStorage } from "../src/indexed-storage.ts";
import { BUCKET, claimFence, context, TABLE_NAME } from "../src/owner.ts";
import { writeResult } from "../src/report.ts";
import { createLocalClient, createLocalS3, ensureBucket, ensureTable } from "../src/table.ts";

const client = createLocalClient();
const s3 = createLocalS3();
await ensureTable(client, TABLE_NAME);
await ensureBucket(s3, BUCKET);

const exists = async (key: string) => {
	try {
		await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
		return true;
	} catch {
		return false;
	}
};
const outcome = async (run: () => Promise<unknown>) => {
	try {
		return `committed as seq ${await run()}`;
	} catch (error) {
		return `${(error as Error).name}: ${(error as Error).message}`;
	}
};

const storageId = `orphans#${randomUUID().slice(0, 8)}`;
await claimFence(storageId, 1);
const open = (fence: number) =>
	IndexedStorage.open({ client, s3, tableName: TABLE_NAME, bucket: BUCKET, storageId, fence });
const owner = await open(1);
await owner.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
const result: Record<string, unknown> = { storageId };

const rejected = await outcome(() =>
	owner.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context),
);
result.rejectedTransaction = { outcome: rejected, objectLeftAtKey: await exists(commitKey(storageId, 2, 1)) };

await s3.send(
	new PutObjectCommand({
		Bucket: BUCKET,
		Key: commitKey(storageId, 2, 1),
		Body: JSON.stringify({ seq: 2, fence: 1, token: "crashed-attempt", writes: [] }),
	}),
);
const afterCrash = await outcome(async () =>
	owner.commit(
		[{ type: "entry", value: { id: await owner.mintId<EntryId>(), conversationId: ROOT_CONVERSATION_ID, kind: "note" } }],
		context,
	),
);
result.orphanFromCrashedAttemptAtSameKey = { outcome: afterCrash };

await claimFence(storageId, 2);
const staleCommit = await outcome(async () =>
	owner.commit(
		[{ type: "entry", value: { id: await owner.mintId<EntryId>(), conversationId: ROOT_CONVERSATION_ID, kind: "late" } }],
		context,
	),
);
result.staleOwnerAfterFenceMoved = { outcome: staleCommit, objectLeftAtKey: await exists(commitKey(storageId, 3, 1)) };

const next = await open(2);
const page = await next.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 10, undefined, context);
result.nextOwnerSeesEntries = page.items.map((entry) => entry.kind);

writeResult("orphans.json", result);
console.log(JSON.stringify(result, null, 2));
