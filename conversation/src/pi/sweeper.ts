import {
	type AttributeValue,
	type DynamoDBClient,
	GetItemCommand,
	QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { DeleteObjectCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import {
	type Clock,
	commitPrefix,
	number,
	parseCommitKey,
	parseSnapshotKey,
	snapshotPrefix,
} from "../storage/storage-support.ts";
import { readSnapshotReference } from "../storage/snapshot-object.ts";

/** What the sweeper needs: the Pi session table and bucket, a clock, and how long an object is left alone. */
export type SweeperDependencies = {
	readonly client: DynamoDBClient;
	readonly s3: S3Client;
	readonly tableName: string;
	readonly bucket: string;
	readonly clock: Clock;
	/** An object whose last-modified time is within this many milliseconds of now is never touched. */
	readonly graceMilliseconds: number;
};

/** What one sweep of one storage removed. */
export type SweepResult = {
	/** Commit objects deleted because they were orphans. */
	readonly deleted: number;
	/** Snapshot objects deleted because a newer snapshot is published. */
	readonly deletedSnapshots: number;
};

type Item = Record<string, AttributeValue>;

type StoredObject = { readonly key: string; readonly lastModified: Date };

async function listObjects(s3: S3Client, bucket: string, prefix: string): Promise<StoredObject[]> {
	const objects: StoredObject[] = [];
	let continuation: string | undefined;
	do {
		const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuation }));
		for (const object of page.Contents ?? []) {
			if (object.Key !== undefined && object.LastModified !== undefined) {
				objects.push({ key: object.Key, lastModified: object.LastModified });
			}
		}
		continuation = page.NextContinuationToken;
	} while (continuation !== undefined);
	return objects;
}

async function readCounter(client: DynamoDBClient, tableName: string, storageId: string, sk: string, name: string): Promise<number> {
	const response = await client.send(
		new GetItemCommand({ TableName: tableName, Key: { pk: { S: `PI#${storageId}` }, sk: { S: sk } }, ConsistentRead: true }),
	);
	return response.Item === undefined ? 0 : (number(response.Item, name) ?? 0);
}

/** The `(seq, fence)` of every commit object some index item of the storage points at, as `seq:fence` strings. */
async function referencedCommits(client: DynamoDBClient, tableName: string, storageId: string): Promise<Set<string>> {
	const referenced = new Set<string>();
	let startKey: Item | undefined;
	do {
		const response = await client.send(
			new QueryCommand({
				TableName: tableName,
				ConsistentRead: true,
				KeyConditionExpression: "pk = :pk",
				FilterExpression: "attribute_exists(c)",
				ExpressionAttributeValues: { ":pk": { S: `PI#${storageId}` } },
				ProjectionExpression: "c, f",
				ExclusiveStartKey: startKey,
			}),
		);
		for (const item of response.Items ?? []) referenced.add(`${number(item, "c")}:${number(item, "f")}`);
		startKey = response.LastEvaluatedKey;
	} while (startKey !== undefined);
	return referenced;
}

const olderThanGrace = (dependencies: SweeperDependencies, object: StoredObject): boolean =>
	dependencies.clock.now().getTime() - object.lastModified.getTime() >= dependencies.graceMilliseconds;

/**
 * Delete the orphaned commit objects of one storage, and the snapshot objects a newer snapshot has replaced.
 *
 * A commit object `(seq, fence)` is deleted only when all of these hold:
 *
 * 1. no index item of the storage points at `(seq, fence)`;
 * 2. `META.seq >= seq` (the commit's `META` condition can never succeed again) or `OWNER.fence > fence` (its owner
 *    fence check can never succeed again);
 * 3. the object was last modified at least the grace period ago.
 *
 * `META` and `OWNER` are read before the index and before the listing, so every value the rule acts on can only be
 * older than the truth, and both only rise. An object with `seq > META.seq` whose fence is still the current owner's
 * may be a live commit in flight; it is kept for as long as that holds, however old it is.
 *
 * @param dependencies Clients, table, bucket, clock and grace period.
 * @param storageId Storage identity, `tenant#bot#channel`.
 * @returns How many objects were deleted.
 */
export async function sweepOrphans(dependencies: SweeperDependencies, storageId: string): Promise<SweepResult> {
	const { client, s3, tableName, bucket } = dependencies;
	const committedSeq = await readCounter(client, tableName, storageId, "META", "seq");
	const ownerFence = await readCounter(client, tableName, storageId, "OWNER", "fence");
	const snapshotReference = await readSnapshotReference(client, tableName, storageId);
	const objects = await listObjects(s3, bucket, commitPrefix(storageId));
	const referenced = await referencedCommits(client, tableName, storageId);
	let deleted = 0;
	for (const object of objects) {
		const parts = parseCommitKey(object.key);
		if (parts === undefined) continue;
		if (referenced.has(`${parts.seq}:${parts.fence}`)) continue;
		if (!(committedSeq >= parts.seq || ownerFence > parts.fence)) continue;
		if (!olderThanGrace(dependencies, object)) continue;
		await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.key }));
		deleted += 1;
	}
	let deletedSnapshots = 0;
	if (snapshotReference !== undefined) {
		for (const object of await listObjects(s3, bucket, snapshotPrefix(storageId))) {
			const parts = parseSnapshotKey(object.key);
			if (parts === undefined) continue;
			if (parts.seq > snapshotReference.seq) continue;
			if (parts.seq === snapshotReference.seq && parts.fence === snapshotReference.fence) continue;
			if (!olderThanGrace(dependencies, object)) continue;
			await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.key }));
			deletedSnapshots += 1;
		}
	}
	return { deleted, deletedSnapshots };
}

/**
 * Every storage identity that has objects in the bucket, found from the key prefixes under `conversations/`.
 *
 * @param s3 S3 client.
 * @param bucket Bucket.
 * @returns Storage identities, `tenant#bot#channel`.
 */
export async function listStorageIds(s3: S3Client, bucket: string): Promise<string[]> {
	const ids: string[] = [];
	let continuation: string | undefined;
	do {
		const page = await s3.send(
			new ListObjectsV2Command({ Bucket: bucket, Prefix: "conversations/", Delimiter: "/", ContinuationToken: continuation }),
		);
		for (const prefix of page.CommonPrefixes ?? []) {
			const encoded = prefix.Prefix?.slice("conversations/".length, -1);
			if (encoded !== undefined && encoded !== "") ids.push(decodeURIComponent(encoded));
		}
		continuation = page.NextContinuationToken;
	} while (continuation !== undefined);
	return ids;
}

/**
 * Sweep every storage in the bucket, one after another.
 *
 * @param dependencies Clients, table, bucket, clock and grace period.
 * @returns Totals across storages and the number of storages swept.
 */
export async function sweepAllStorages(
	dependencies: SweeperDependencies,
): Promise<SweepResult & { readonly storages: number }> {
	const storageIds = await listStorageIds(dependencies.s3, dependencies.bucket);
	let deleted = 0;
	let deletedSnapshots = 0;
	for (const storageId of storageIds) {
		const result = await sweepOrphans(dependencies, storageId);
		deleted += result.deleted;
		deletedSnapshots += result.deletedSnapshots;
	}
	return { deleted, deletedSnapshots, storages: storageIds.length };
}
