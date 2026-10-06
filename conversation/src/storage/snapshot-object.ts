import {
	type AttributeValue,
	type DynamoDBClient,
	GetItemCommand,
	QueryCommand,
	UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { StorageWrite } from "@earendil-works/pi-durable";
import type { CommitObject } from "./indexed-storage.ts";
import { commitKey, encode, number, parse, parseCommitKey, snapshotKey, text } from "./storage-support.ts";

type Item = Record<string, AttributeValue>;

/** Version of the snapshot object format. A reader refuses any other value. */
export const SNAPSHOT_FORMAT = 1;

/** Commit objects fetched in parallel while a snapshot is built. */
const SNAPSHOT_FETCH_CONCURRENCY = 16;

/**
 * The immutable S3 object of one session snapshot: the referenced part of every commit object that a cold owner would
 * otherwise fetch one by one.
 *
 * A snapshot is a pack, not a second copy of the transcript. Each entry of `commits` is keyed by the commit object's
 * key suffix (`<seq:012>-<fence:08>`) and holds only the writes, by position, that an index item of this storage
 * still points at as of `seq`: the latest record of every entry, task and submission, and the revisions of every
 * document from its newest base to its newest revision. Nothing in it is derived or summarized, so what the model
 * reads through a snapshot is byte for byte what it reads through the commit objects.
 */
export type SnapshotObject = {
	readonly format: typeof SNAPSHOT_FORMAT;
	/** Highest commit sequence the snapshot covers. Every index pointer at or below it is answered by `commits`. */
	readonly seq: number;
	/** Fence of the owner that wrote the snapshot. */
	readonly fence: number;
	readonly commits: Readonly<Record<string, Readonly<Record<string, StorageWrite>>>>;
};

/** What the `SNAPSHOT` index item of a storage says: the newest snapshot object a cold owner should read. */
export type SnapshotReference = { readonly seq: number; readonly fence: number };

/** Clients, table and bucket the snapshot functions read and write. */
export type SnapshotDependencies = {
	readonly client: DynamoDBClient;
	readonly s3: S3Client;
	readonly tableName: string;
	readonly bucket: string;
	/** Fence stamped into the snapshot key; 0 when the writer is not an owner. */
	readonly fence?: number;
	/** Where to read a commit object that is not in the previous snapshot; defaults to fetching it from S3. */
	readonly readCommitObject?: (key: string) => Promise<CommitObject>;
};

/** Result of a snapshot write. */
export type SnapshotWriteResult = {
	/** Sequence the storage's `SNAPSHOT` item now names. */
	readonly seq: number;
	/** Whether this call wrote a new snapshot object. False when the storage already had one at least as new. */
	readonly written: boolean;
	/** Number of commit objects the written snapshot packs. */
	readonly commits: number;
};

const commitSuffix = (seq: number, fence: number): string =>
	`${String(seq).padStart(12, "0")}-${String(fence).padStart(8, "0")}`;

/**
 * Read the `SNAPSHOT` item of a storage.
 *
 * @param client DynamoDB client.
 * @param tableName Pi session table.
 * @param storageId Storage identity.
 * @returns The newest snapshot reference, or `undefined` when the storage has never been snapshotted.
 */
export async function readSnapshotReference(
	client: DynamoDBClient,
	tableName: string,
	storageId: string,
): Promise<SnapshotReference | undefined> {
	const response = await client.send(
		new GetItemCommand({
			TableName: tableName,
			Key: { pk: { S: `PI#${storageId}` }, sk: { S: "SNAPSHOT" } },
			ConsistentRead: true,
		}),
	);
	return response.Item === undefined
		? undefined
		: { seq: number(response.Item, "seq")!, fence: number(response.Item, "fence")! };
}

/**
 * Fetch and decode one snapshot object.
 *
 * @param s3 S3 client.
 * @param bucket Bucket.
 * @param storageId Storage identity.
 * @param reference Which snapshot to read.
 * @returns The snapshot object.
 * @throws Error When the object has an unknown format.
 */
export async function readSnapshotObject(
	s3: S3Client,
	bucket: string,
	storageId: string,
	reference: SnapshotReference,
): Promise<SnapshotObject> {
	const response = await s3.send(
		new GetObjectCommand({ Bucket: bucket, Key: snapshotKey(storageId, reference.seq, reference.fence) }),
	);
	const snapshot = parse<SnapshotObject>(await response.Body!.transformToString());
	if (snapshot.format !== SNAPSHOT_FORMAT) throw new Error(`Unknown snapshot format ${String(snapshot.format)}`);
	return snapshot;
}

/**
 * Turn the packed writes of one snapshot entry back into the shape of a commit object, with the writes at the same
 * positions they had in the original object and nothing at the positions the snapshot does not carry.
 *
 * @param storageId Storage identity.
 * @param suffix Key suffix of the packed commit, `<seq:012>-<fence:08>`.
 * @param packed Packed writes by position.
 * @returns A commit object whose `token` is empty: a packed object is never used for idempotency checks.
 */
export function unpackCommitObject(
	storageId: string,
	suffix: string,
	packed: Readonly<Record<string, StorageWrite>>,
): CommitObject {
	const parts = parseCommitKey(`/commits/${suffix}.json`);
	if (parts === undefined) throw new Error(`Malformed snapshot commit suffix ${suffix} for ${storageId}`);
	const writes: StorageWrite[] = [];
	for (const [position, write] of Object.entries(packed)) writes[Number(position)] = write;
	return { seq: parts.seq, fence: parts.fence, token: "", writes };
}

type Pointer = { readonly seq: number; readonly fence: number; readonly position: number };

async function queryAll(
	client: DynamoDBClient,
	tableName: string,
	storageId: string,
	prefix: string,
	projection: string,
): Promise<Item[]> {
	const items: Item[] = [];
	let startKey: Item | undefined;
	do {
		const response = await client.send(
			new QueryCommand({
				TableName: tableName,
				ConsistentRead: true,
				KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
				ExpressionAttributeValues: { ":pk": { S: `PI#${storageId}` }, ":prefix": { S: prefix } },
				ProjectionExpression: projection,
				ExclusiveStartKey: startKey,
			}),
		);
		items.push(...(response.Items ?? []));
		startKey = response.LastEvaluatedKey;
	} while (startKey !== undefined);
	return items;
}

/**
 * The index pointers a cold owner would follow to rebuild the transcript as of `throughSeq`: the latest record of
 * every entry, task and submission, and for every document the revisions from the newest base up to the newest
 * revision at or below `throughSeq`.
 */
async function referencedPointers(
	dependencies: SnapshotDependencies,
	storageId: string,
	throughSeq: number,
): Promise<Pointer[]> {
	const pointers: Pointer[] = [];
	const asPointer = (item: Item): Pointer => ({
		seq: number(item, "c")!,
		fence: number(item, "f")!,
		position: number(item, "p")!,
	});
	const records = await queryAll(dependencies.client, dependencies.tableName, storageId, "R#", "t, c, f, p");
	for (const item of records) {
		const kind = text(item, "t");
		if (kind !== "entry" && kind !== "task" && kind !== "submission") continue;
		if (number(item, "c")! > throughSeq) continue;
		pointers.push(asPointer(item));
	}
	const revisions = await queryAll(dependencies.client, dependencies.tableName, storageId, "V#", "sk, b, c, f, p");
	const byDocument = new Map<string, Item[]>();
	for (const item of revisions) {
		if (number(item, "c")! > throughSeq) continue;
		const document = text(item, "sk")!.split("#")[1]!;
		const list = byDocument.get(document) ?? [];
		list.push(item);
		byDocument.set(document, list);
	}
	for (const list of byDocument.values()) {
		let newestBase = list.length - 1;
		while (newestBase > 0 && number(list[newestBase]!, "b") !== 1) newestBase--;
		for (const item of list.slice(newestBase)) pointers.push(asPointer(item));
	}
	return pointers;
}

async function mapWithConcurrency<T, R>(values: readonly T[], limit: number, work: (value: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(values.length);
	let next = 0;
	const lane = async (): Promise<void> => {
		while (next < values.length) {
			const index = next++;
			results[index] = await work(values[index]!);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, values.length) }, lane));
	return results;
}

/**
 * Write a snapshot object for a storage and publish it through the storage's `SNAPSHOT` index item.
 *
 * The covered sequence is `META.seq` read before the index is read, so every pointer at or below it is already
 * visible. The object is written first and never overwritten; the `SNAPSHOT` item moves only forward. A snapshot that
 * loses that race, or crashes before it, is an unreferenced object that the sweeper removes.
 *
 * It reads the previous snapshot (one GET) and fetches only the commit objects the previous snapshot did not carry,
 * so the cost of a snapshot grows with the commits since the last one, not with history.
 *
 * @param dependencies Clients, table, bucket, and the writer's fence.
 * @param storageId Storage identity, `tenant#bot#channel`.
 * @returns Which snapshot the storage now names and whether this call wrote it.
 * @throws Error When a commit object a pointer needs cannot be read; nothing is published then.
 */
export async function writeSnapshotObject(
	dependencies: SnapshotDependencies,
	storageId: string,
): Promise<SnapshotWriteResult> {
	const { client, s3, tableName, bucket } = dependencies;
	const fence = dependencies.fence ?? 0;
	const metaResponse = await client.send(
		new GetItemCommand({
			TableName: tableName,
			Key: { pk: { S: `PI#${storageId}` }, sk: { S: "META" } },
			ConsistentRead: true,
		}),
	);
	const throughSeq = metaResponse.Item === undefined ? 0 : number(metaResponse.Item, "seq")!;
	const previous = await readSnapshotReference(client, tableName, storageId);
	if (throughSeq === 0 || (previous !== undefined && previous.seq >= throughSeq)) {
		return { seq: previous?.seq ?? 0, written: false, commits: 0 };
	}
	const pointers = await referencedPointers(dependencies, storageId, throughSeq);
	const positionsByCommit = new Map<string, Set<number>>();
	for (const pointer of pointers) {
		const suffix = commitSuffix(pointer.seq, pointer.fence);
		const positions = positionsByCommit.get(suffix) ?? new Set<number>();
		positions.add(pointer.position);
		positionsByCommit.set(suffix, positions);
	}
	const earlier = previous === undefined ? undefined : await readSnapshotObject(s3, bucket, storageId, previous);
	const readCommitObject =
		dependencies.readCommitObject ??
		(async (key: string): Promise<CommitObject> => {
			const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
			return parse<CommitObject>(await response.Body!.transformToString());
		});
	const packed = await mapWithConcurrency([...positionsByCommit], SNAPSHOT_FETCH_CONCURRENCY, async ([suffix, positions]) => {
		const writes: Record<string, StorageWrite> = {};
		const carried = earlier?.commits[suffix];
		const parts = parseCommitKey(`/commits/${suffix}.json`)!;
		const object = carried === undefined ? await readCommitObject(commitKey(storageId, parts.seq, parts.fence)) : undefined;
		for (const position of positions) {
			const write = carried?.[String(position)] ?? object?.writes[position];
			if (write === undefined) throw new Error(`Commit ${suffix} of ${storageId} has no write at position ${position}`);
			writes[String(position)] = write;
		}
		return [suffix, writes] as const;
	});
	const snapshot: SnapshotObject = {
		format: SNAPSHOT_FORMAT,
		seq: throughSeq,
		fence,
		commits: Object.fromEntries(packed),
	};
	try {
		await s3.send(
			new PutObjectCommand({
				Bucket: bucket,
				Key: snapshotKey(storageId, throughSeq, fence),
				Body: encode(snapshot),
				ContentType: "application/json",
				IfNoneMatch: "*",
			}),
		);
	} catch (error) {
		const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
		if (status !== 412) throw error;
	}
	try {
		await client.send(
			new UpdateItemCommand({
				TableName: tableName,
				Key: { pk: { S: `PI#${storageId}` }, sk: { S: "SNAPSHOT" } },
				UpdateExpression: "SET seq = :seq, fence = :fence",
				ConditionExpression: "attribute_not_exists(seq) OR seq < :seq",
				ExpressionAttributeValues: { ":seq": { N: String(throughSeq) }, ":fence": { N: String(fence) } },
			}),
		);
	} catch (error) {
		if ((error as Error).name === "ConditionalCheckFailedException") {
			const newest = await readSnapshotReference(client, tableName, storageId);
			return { seq: newest?.seq ?? throughSeq, written: false, commits: 0 };
		}
		throw error;
	}
	return { seq: throughSeq, written: true, commits: packed.length };
}
