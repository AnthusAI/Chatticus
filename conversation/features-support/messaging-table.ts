import { randomUUID } from "node:crypto";
import { Agent } from "node:http";
import {
	type AttributeValue,
	CreateTableCommand,
	DeleteItemCommand,
	DeleteTableCommand,
	DynamoDBClient,
	PutItemCommand,
	QueryCommand,
	UpdateTimeToLiveCommand,
} from "@aws-sdk/client-dynamodb";
import { organizationKey, vendorLedgerKey } from "../src/budget/budget-store.ts";
import type { Decimal } from "../src/budget/decimal.ts";
import { BILLED_VIA_VENDOR, ORGANIZATION_STATUS_ENABLED } from "../src/budget/models.ts";

type Item = Record<string, AttributeValue>;

export const DEPLOYMENT_AWS_ACCOUNT_ID = "111122223333";

export function localDynamoClient(): DynamoDBClient {
	return new DynamoDBClient({
		endpoint: process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5555",
		region: "us-east-1",
		credentials: { accessKeyId: "test", secretAccessKey: "test" },
		maxAttempts: 1,
		requestHandler: { httpAgent: new Agent({ keepAlive: true, maxSockets: 64 }) },
	});
}

export interface SeededOrganization {
	readonly tenantId: string;
	readonly name: string;
	readonly awsAccountId: string;
	readonly awsCrossAccountRole?: string;
	readonly awsExternalId?: string;
}

/**
 * A per-scenario `Messaging` table on a local DynamoDB emulator, plus writers
 * that lay down the items the Python control plane owns (organizations and the
 * vendor ledger) in exactly the layout Python writes them.
 */
export class ScenarioMessagingTable {
	readonly client: DynamoDBClient;
	readonly tableName: string;

	constructor(client: DynamoDBClient) {
		this.client = client;
		this.tableName = `messaging-${randomUUID()}`;
	}

	async create(): Promise<void> {
		await this.client.send(
			new CreateTableCommand({
				TableName: this.tableName,
				KeySchema: [
					{ AttributeName: "pk", KeyType: "HASH" },
					{ AttributeName: "sk", KeyType: "RANGE" },
				],
				AttributeDefinitions: [
					{ AttributeName: "pk", AttributeType: "S" },
					{ AttributeName: "sk", AttributeType: "S" },
				],
				BillingMode: "PAY_PER_REQUEST",
			}),
		);
	}

	async drop(): Promise<void> {
		await this.client.send(new DeleteTableCommand({ TableName: this.tableName }));
	}

	async putOrganization(organization: SeededOrganization, createdAt: string): Promise<void> {
		const key = organizationKey(organization.tenantId);
		const item: Item = {
			pk: { S: key.pk },
			sk: { S: key.sk },
			tenant_id: { S: organization.tenantId },
			name: { S: organization.name },
			status: { S: ORGANIZATION_STATUS_ENABLED },
			owner_user_id: { S: `user-${organization.tenantId}` },
			created_at: { S: createdAt },
			aws_account_id: { S: organization.awsAccountId },
		};
		if (organization.awsCrossAccountRole === undefined) {
			item.aws_setup_path = { S: "anthus-managed" };
		} else {
			item.aws_cross_account_role = { S: organization.awsCrossAccountRole };
			item.aws_external_id = { S: organization.awsExternalId ?? organization.tenantId };
		}
		await this.client.send(new PutItemCommand({ TableName: this.tableName, Item: item }));
	}

	async putVendorLedgerRow(row: {
		tenantId: string;
		turnId: string;
		billedVia: string;
		costUsd: Decimal | null;
		recordedAt: string;
	}): Promise<void> {
		const key = vendorLedgerKey(row.tenantId, row.turnId);
		const billedByVendor = row.billedVia === BILLED_VIA_VENDOR;
		const item: Item = {
			pk: { S: key.pk },
			sk: { S: key.sk },
			tenant_id: { S: row.tenantId },
			turn_id: { S: row.turnId },
			vendor: { S: "openai" },
			model: { S: "chatticus-test-model" },
			input_tokens: { N: "10" },
			output_tokens: { N: "5" },
			billed_via: { S: row.billedVia },
			recorded_at: { S: row.recordedAt },
		};
		if (billedByVendor) {
			item.input_price_per_million_usd = { N: "2.00" };
			item.output_price_per_million_usd = { N: "4.00" };
		}
		if (row.costUsd !== null) {
			item.cost_usd = { N: row.costUsd.toString() };
		}
		await this.client.send(new PutItemCommand({ TableName: this.tableName, Item: item }));
	}

	async deleteVendorLedgerRow(tenantId: string, turnId: string): Promise<void> {
		const key = vendorLedgerKey(tenantId, turnId);
		await this.client.send(
			new DeleteItemCommand({ TableName: this.tableName, Key: { pk: { S: key.pk }, sk: { S: key.sk } } }),
		);
	}

	/** Remove every item under a partition whose sort key starts with the prefix, as DynamoDB does when time to live passes. */
	async expireItemsWithSortKeyPrefix(partitionKey: string, sortKeyPrefix: string): Promise<number> {
		const response = await this.client.send(
			new QueryCommand({
				TableName: this.tableName,
				KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
				ExpressionAttributeValues: { ":pk": { S: partitionKey }, ":prefix": { S: sortKeyPrefix } },
				ConsistentRead: true,
			}),
		);
		for (const item of response.Items ?? []) {
			await this.client.send(new DeleteItemCommand({ TableName: this.tableName, Key: { pk: item.pk!, sk: item.sk! } }));
		}
		return response.Items?.length ?? 0;
	}

	async countItemsWithSortKeyPrefix(partitionKey: string, sortKeyPrefix: string): Promise<number> {
		const response = await this.client.send(
			new QueryCommand({
				TableName: this.tableName,
				KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
				ExpressionAttributeValues: { ":pk": { S: partitionKey }, ":prefix": { S: sortKeyPrefix } },
				Select: "COUNT",
			}),
		);
		return response.Count ?? 0;
	}
}

/**
 * Create the shared Messaging table in moto with plain pk/sk design and TTL.
 * Used once per worker in BeforeAll hooks.
 */
export async function createMessagingTable(client: DynamoDBClient, tableName: string): Promise<void> {
	await client.send(
		new CreateTableCommand({
			TableName: tableName,
			KeySchema: [
				{ AttributeName: "pk", KeyType: "HASH" },
				{ AttributeName: "sk", KeyType: "RANGE" },
			],
			AttributeDefinitions: [
				{ AttributeName: "pk", AttributeType: "S" },
				{ AttributeName: "sk", AttributeType: "S" },
			],
			BillingMode: "PAY_PER_REQUEST",
		}),
	);
	// Enable TTL on expires_at attribute
	await client.send(
		new UpdateTimeToLiveCommand({
			TableName: tableName,
			TimeToLiveSpecification: {
				AttributeName: "expires_at",
				Enabled: true,
			},
		}),
	);
}
