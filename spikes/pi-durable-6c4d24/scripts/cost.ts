import { randomUUID } from "node:crypto";
import { QueryCommand } from "@aws-sdk/client-dynamodb";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { commitKey } from "../src/indexed-storage.ts";
import { type MeterSnapshot, meterDelta, residentBytes } from "../src/meter.ts";
import { type Backend, BUCKET, context, openOwner, type Owner, TABLE_NAME } from "../src/owner.ts";
import { summarize, writeResult } from "../src/report.ts";
import { createLocalClient, createLocalS3, ensureBucket, type Item } from "../src/table.ts";

const client = createLocalClient();
const s3 = createLocalS3();

async function partitionItems(storageId: string): Promise<Item[]> {
	const items: Item[] = [];
	let startKey: Item | undefined;
	do {
		const response = await client.send(
			new QueryCommand({
				TableName: TABLE_NAME,
				KeyConditionExpression: "pk = :pk",
				ExpressionAttributeValues: { ":pk": { S: `PI#${storageId}` } },
				ExclusiveStartKey: startKey,
			}),
		);
		items.push(...(response.Items ?? []));
		startKey = response.LastEvaluatedKey;
	} while (startKey !== undefined);
	return items;
}

async function objectBytes(storageId: string): Promise<{ objects: number; bytes: number }> {
	const prefix = commitKey(storageId, 0, 0).replace(/[^/]+$/, "");
	let objects = 0;
	let bytes = 0;
	let token: string | undefined;
	do {
		const response = await s3.send(
			new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }),
		);
		for (const object of response.Contents ?? []) {
			objects++;
			bytes += object.Size ?? 0;
		}
		token = response.NextContinuationToken;
	} while (token !== undefined);
	return { objects, bytes };
}

async function turn(owner: Owner, content: string, requestId: string) {
	const before: MeterSnapshot = owner.storage.meter.snapshot();
	const commitsBefore = owner.storage.measurements.length;
	const started = performance.now();
	const submission = await owner.root.submit({ type: "input", content, requestId }, context);
	const settled = await submission.wait(context);
	return {
		status: settled.status,
		milliseconds: Math.round(performance.now() - started),
		requests: meterDelta(owner.storage.meter.snapshot(), before),
		commits: summarize(owner.storage.measurements.slice(commitsBefore)),
	};
}

async function measure(backend: Backend) {
	const storageId = `tenant-1#bot-ada#cost-${backend}-${randomUUID().slice(0, 8)}`;
	const first = await openOwner({ storageId, fence: 1, name: "owner-1", capability: "computer", backend, toolDelayMs: 3000 });
	const setup = meterDelta(first.storage.meter.snapshot(), {
		dynamoRequests: 0,
		writeRequestUnits: 0,
		readRequestUnits: 0,
		s3Puts: 0,
		s3Gets: 0,
		s3BytesPut: 0,
		largestIndexItemBytes: 0,
	});
	const afterSetup = residentBytes(await partitionItems(storageId));
	const objectsAfterSetup = await objectBytes(storageId);
	const plain = await turn(first,"Name three primary colours. One line.", "cost-1");
	const afterPlain = residentBytes(await partitionItems(storageId));
	const objectsAfterPlain = await objectBytes(storageId);
	const tool = await turn(first, "Use run_terminal to run `ls /srv`, then report the output in one line.", "cost-2");
	await first.close();
	const items = await partitionItems(storageId);
	const objects = await objectBytes(storageId);
	const reopenStarted = performance.now();
	const second = await openOwner({ storageId, fence: 2, name: "owner-2", capability: "computer", backend });
	const reopen = {
		milliseconds: Math.round(performance.now() - reopenStarted),
		requests: second.storage.meter.snapshot(),
	};
	const transcriptStarted = performance.now();
	await second.storage.scanEntries({ conversationId: second.root.id }, 1000, undefined, context);
	const transcriptRead = {
		milliseconds: Math.round(performance.now() - transcriptStarted),
		requests: meterDelta(second.storage.meter.snapshot(), reopen.requests),
	};
	await second.close();
	return {
		backend,
		storageId,
		setup,
		plain,
		tool,
		resident: {
			dynamoBillableBytesAfterSetup: afterSetup,
			s3AfterSetup: objectsAfterSetup,
			dynamoBillableBytesAfterPlainTurn: afterPlain,
			s3AfterPlainTurn: objectsAfterPlain,
			dynamoBillableBytesAfterBothTurns: residentBytes(items),
			dynamoItems: items.length,
			largestResidentItemBytes: Math.max(...items.map((item) => JSON.stringify(item).length)),
			s3AfterBothTurns: objects,
		},
		reopen,
		transcriptRead,
	};
}

await ensureBucket(s3, BUCKET);
const results = [await measure("dynamodb"), await measure("indexed")];
writeResult("cost.json", results);
console.log(JSON.stringify(results, null, 2));
