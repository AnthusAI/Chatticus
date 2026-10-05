import { CreateBucketCommand } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import { CreateTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

/** Key and local-secondary-index layout of the single pi-durable session table. */
export const PI_SESSION_TABLE_KEYS = {
	partitionKey: "pk",
	sortKey: "sk",
	localSecondaryIndexes: [
		{ indexName: "l1-index", attributeName: "l1", attributeType: "S", projection: "ALL" },
		{ indexName: "l2-index", attributeName: "l2", attributeType: "S", projection: "ALL" },
		{ indexName: "l3-index", attributeName: "l3", attributeType: "S", projection: "ALL" },
	],
} as const;

/**
 * Create the pi-durable session table. For tests only; production tables come from CDK. Idempotent.
 *
 * @param client DynamoDB client.
 * @param tableName Table name.
 */
export async function createPiSessionTable(client: DynamoDBClient, tableName: string): Promise<void> {
	const keys = PI_SESSION_TABLE_KEYS;
	try {
		await client.send(
			new CreateTableCommand({
				TableName: tableName,
				BillingMode: "PAY_PER_REQUEST",
				AttributeDefinitions: [
					{ AttributeName: keys.partitionKey, AttributeType: "S" },
					{ AttributeName: keys.sortKey, AttributeType: "S" },
					...keys.localSecondaryIndexes.map((index) => ({
						AttributeName: index.attributeName,
						AttributeType: index.attributeType,
					})),
				],
				KeySchema: [
					{ AttributeName: keys.partitionKey, KeyType: "HASH" },
					{ AttributeName: keys.sortKey, KeyType: "RANGE" },
				],
				LocalSecondaryIndexes: keys.localSecondaryIndexes.map((index) => ({
					IndexName: index.indexName,
					KeySchema: [
						{ AttributeName: keys.partitionKey, KeyType: "HASH" },
						{ AttributeName: index.attributeName, KeyType: "RANGE" },
					],
					Projection: { ProjectionType: index.projection },
				})),
			}),
		);
	} catch (error) {
		if ((error as Error).name !== "ResourceInUseException") throw error;
	}
}

/**
 * Create the commit-object bucket. For tests only; production buckets come from CDK. Idempotent.
 *
 * @param s3 S3 client.
 * @param bucket Bucket name.
 */
export async function createPiSessionBucket(s3: S3Client, bucket: string): Promise<void> {
	try {
		await s3.send(new CreateBucketCommand({ Bucket: bucket }));
	} catch (error) {
		const name = (error as Error).name;
		if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw error;
	}
}
