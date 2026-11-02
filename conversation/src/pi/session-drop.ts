import {
	BatchWriteItemCommand,
	type BatchWriteItemCommandOutput,
	type AttributeValue,
	type DynamoDBClient,
	QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { DeleteObjectsCommand, ListObjectVersionsCommand, type S3Client } from "@aws-sdk/client-s3";
import type { CommitObjectCache } from "../storage/indexed-storage.ts";


/** What dropping needs: the Pi session table and bucket, and the cache of commit objects to forget. */
export type SessionDropDependencies = {
	readonly client: DynamoDBClient;
	readonly s3: S3Client;
	readonly conversationsTableName: string;
	readonly bucket: string;
	readonly commitCache?: CommitObjectCache;
};

/** What a drop removed. */
export type SessionDropReport = { items: number; objectVersions: number };

const BATCH_WRITE_LIMIT = 25;
const OWNER_SORT_KEY = "OWNER";

/**
 * Delete a Pi session as if it had never been written: every DynamoDB item of its partition and every S3 object version
 * under its commit and snapshot prefixes, delete markers included. Only the OWNER item, which holds the fence counter and
 * no text, stays, so the next owner's fence is higher than any earlier owner's and a zombie writer of the dropped session
 * is still refused, and so no new commit object can reuse the key of a dropped one. The caller must have established
 * that no turn is open on the session.
 *
 * @param deps Clients, table, bucket and cache.
 * @param storageId Partition identity, `tenant#bot#channel`.
 * @returns How many DynamoDB items and S3 object versions were deleted.
 */
export async function dropSession(deps: SessionDropDependencies, storageId: string): Promise<SessionDropReport> {
	const report: SessionDropReport = { items: 0, objectVersions: 0 };
	const keys: Array<Record<string, AttributeValue>> = [];
	let startKey: Record<string, AttributeValue> | undefined;
	do {
		const page = await deps.client.send(
			new QueryCommand({
				TableName: deps.conversationsTableName,
				KeyConditionExpression: "pk = :pk",
				ExpressionAttributeValues: { ":pk": { S: `PI#${storageId}` } },
				ProjectionExpression: "pk, sk",
				ConsistentRead: true,
				ExclusiveStartKey: startKey,
			}),
		);
		for (const item of page.Items ?? []) {
			if (item.sk?.S !== OWNER_SORT_KEY) keys.push({ pk: item.pk!, sk: item.sk! });
		}
		startKey = page.LastEvaluatedKey;
	} while (startKey !== undefined);
	for (let start = 0; start < keys.length; start += BATCH_WRITE_LIMIT) {
		let batch = keys.slice(start, start + BATCH_WRITE_LIMIT);
		while (batch.length > 0) {
			const response: BatchWriteItemCommandOutput = await deps.client.send(
				new BatchWriteItemCommand({
					RequestItems: { [deps.conversationsTableName]: batch.map((Key) => ({ DeleteRequest: { Key } })) },
				}),
			);
			batch = (response.UnprocessedItems?.[deps.conversationsTableName] ?? []).map((request) => request.DeleteRequest!.Key!);
		}
	}
	report.items = keys.length;
	const prefix = `conversations/${encodeURIComponent(storageId)}/`;
	let keyMarker: string | undefined;
	let versionMarker: string | undefined;
	do {
		const page = await deps.s3.send(
			new ListObjectVersionsCommand({ Bucket: deps.bucket, Prefix: prefix, KeyMarker: keyMarker, VersionIdMarker: versionMarker }),
		);
		const versions = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])];
		if (versions.length > 0) {
			await deps.s3.send(
				new DeleteObjectsCommand({
					Bucket: deps.bucket,
					Delete: { Quiet: true, Objects: versions.map((version) => ({ Key: version.Key!, VersionId: version.VersionId })) },
				}),
			);
			for (const version of versions) deps.commitCache?.delete(version.Key!);
			report.objectVersions += versions.length;
		}
		keyMarker = page.IsTruncated === true ? page.NextKeyMarker : undefined;
		versionMarker = page.IsTruncated === true ? page.NextVersionIdMarker : undefined;
	} while (keyMarker !== undefined);
	return report;
}
