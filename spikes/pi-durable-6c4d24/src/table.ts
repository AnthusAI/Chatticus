import {
	type AttributeValue,
	CreateTableCommand,
	DescribeTableCommand,
	DynamoDBClient,
	ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";

export const LOCAL_ENDPOINT = process.env.PI_SPIKE_DYNAMODB_ENDPOINT ?? "http://127.0.0.1:5555";

/** Client pointed at the local moto endpoint with dummy credentials; never real AWS. */
export function createLocalClient(): DynamoDBClient {
	return new DynamoDBClient({
		endpoint: LOCAL_ENDPOINT,
		region: "us-east-1",
		credentials: { accessKeyId: "spike", secretAccessKey: "spike" },
		maxAttempts: 1,
	});
}

/**
 * Create the single pi-durable table: `pk`/`sk` plus three strongly consistent local secondary indexes.
 *
 * @param client DynamoDB client.
 * @param tableName Table name.
 */
export async function ensureTable(client: DynamoDBClient, tableName: string): Promise<void> {
	try {
		await client.send(new DescribeTableCommand({ TableName: tableName }));
		return;
	} catch (error) {
		if (!(error instanceof ResourceNotFoundException) && (error as Error).name !== "ResourceNotFoundException") {
			throw error;
		}
	}
	const indexAttribute = (name: string) => ({
		IndexName: name,
		KeySchema: [
			{ AttributeName: "pk", KeyType: "HASH" as const },
			{ AttributeName: name, KeyType: "RANGE" as const },
		],
		Projection: { ProjectionType: "ALL" as const },
	});
	await client.send(
		new CreateTableCommand({
			TableName: tableName,
			BillingMode: "PAY_PER_REQUEST",
			AttributeDefinitions: [
				{ AttributeName: "pk", AttributeType: "S" },
				{ AttributeName: "sk", AttributeType: "S" },
				{ AttributeName: "l1", AttributeType: "S" },
				{ AttributeName: "l2", AttributeType: "S" },
				{ AttributeName: "l3", AttributeType: "S" },
			],
			KeySchema: [
				{ AttributeName: "pk", KeyType: "HASH" },
				{ AttributeName: "sk", KeyType: "RANGE" },
			],
			LocalSecondaryIndexes: [indexAttribute("l1"), indexAttribute("l2"), indexAttribute("l3")],
		}),
	);
}

export type Item = Record<string, AttributeValue>;
