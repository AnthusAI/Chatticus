import { randomUUID } from "node:crypto";
import { GetItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
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

const sweepId = `orphans-sweep#${randomUUID().slice(0, 8)}`;
await claimFence(sweepId, 1);
const first = await IndexedStorage.open({ client, s3, tableName: TABLE_NAME, bucket: BUCKET, storageId: sweepId, fence: 1 });
await first.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
const plantCrashedObject = (seq: number, fence: number) =>
	s3.send(
		new PutObjectCommand({
			Bucket: BUCKET,
			Key: commitKey(sweepId, seq, fence),
			Body: JSON.stringify({ seq, fence, token: `crashed-${seq}-${fence}`, writes: [] }),
		}),
	);
await plantCrashedObject(2, 1);
await plantCrashedObject(9, 1);
await claimFence(sweepId, 2);
const second = await IndexedStorage.open({ client, s3, tableName: TABLE_NAME, bucket: BUCKET, storageId: sweepId, fence: 2 });
await second.commit(
	[{ type: "entry", value: { id: await second.mintId<EntryId>(), conversationId: ROOT_CONVERSATION_ID, kind: "a" } }],
	context,
);
await second.commit(
	[{ type: "entry", value: { id: await second.mintId<EntryId>(), conversationId: ROOT_CONVERSATION_ID, kind: "b" } }],
	context,
);
await plantCrashedObject(9, 2);

const sweepKeys = [commitKey(sweepId, 2, 1), commitKey(sweepId, 9, 1), commitKey(sweepId, 9, 2)];
const sweepOnce = async () => {
	const pk = { S: `PI#${sweepId}` };
	const metaItem = await client.send(new GetItemCommand({ TableName: TABLE_NAME, Key: { pk, sk: { S: "META" } }, ConsistentRead: true }));
	const ownerItem = await client.send(new GetItemCommand({ TableName: TABLE_NAME, Key: { pk, sk: { S: "OWNER" } }, ConsistentRead: true }));
	const metaSeq = Number(metaItem.Item?.seq?.N ?? 0);
	const ownerFence = Number(ownerItem.Item?.fence?.N ?? 0);
	const referenced = new Set<string>();
	let startKey: Record<string, any> | undefined;
	do {
		const response = await client.send(
			new QueryCommand({
				TableName: TABLE_NAME,
				KeyConditionExpression: "pk = :pk",
				ExpressionAttributeValues: { ":pk": pk },
				ExclusiveStartKey: startKey,
				ConsistentRead: true,
			}),
		);
		for (const item of response.Items ?? []) {
			if (item.c?.N !== undefined && item.f?.N !== undefined) referenced.add(commitKey(sweepId, Number(item.c.N), Number(item.f.N)));
		}
		startKey = response.LastEvaluatedKey;
	} while (startKey !== undefined);
	const decisions: Record<string, string> = {};
	for (const key of sweepKeys) {
		const name = key.split("/").at(-1)!;
		const [seq, fence] = name.replace(".json", "").split("-").map(Number);
		if (referenced.has(key)) decisions[name] = "kept: referenced by the index";
		else if (metaSeq >= seq) decisions[name] = `deleted: META.seq ${metaSeq} >= seq ${seq}`;
		else if (ownerFence > fence) decisions[name] = `deleted: OWNER.fence ${ownerFence} > fence ${fence}`;
		else decisions[name] = `kept: seq ${seq} > META.seq ${metaSeq} and fence ${fence} is still the owner fence`;
		if (decisions[name].startsWith("deleted")) {
			await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
		}
	}
	return { metaSeq, ownerFence, decisions };
};
const sweep = await sweepOnce();
result.sweeper = {
	rule: "read META and OWNER first; delete an unreferenced object only when META.seq >= seq or OWNER.fence > fence",
	...sweep,
	objectsRemaining: await Promise.all(sweepKeys.map(async (key) => ({ key, exists: await exists(key) }))),
};

writeResult("orphans.json", result);
console.log(JSON.stringify(result, null, 2));
