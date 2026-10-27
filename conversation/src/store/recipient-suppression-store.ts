import { GetItemCommand, PutItemCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { normalizeEmailAddress } from "../channels/email/email-addresses.ts";
import type { RecipientSuppression, RecipientSuppressionList } from "../channels/email/recipient-suppression.ts";

const suppressionKeys = (tenantId: string, bindingId: string, address: string): { pk: { S: string }; sk: { S: string } } => ({
	pk: { S: `${tenantId}#channels` },
	sk: { S: `suppression#${bindingId}#${normalizeEmailAddress(address)}` },
});

/**
 * The suppression list in the Messaging table, one item per binding and address under the organization's channel
 * partition. Suppressing an address again keeps the first reason and time.
 */
export class DynamoRecipientSuppressionList implements RecipientSuppressionList {
	private readonly client: DynamoDBClient;
	private readonly tableName: string;

	/**
	 * @param client The DynamoDB client.
	 * @param tableName The Messaging table.
	 */
	constructor(client: DynamoDBClient, tableName: string) {
		this.client = client;
		this.tableName = tableName;
	}

	async isSuppressed(tenantId: string, bindingId: string, address: string): Promise<boolean> {
		const found = await this.client.send(new GetItemCommand({ TableName: this.tableName, Key: suppressionKeys(tenantId, bindingId, address), ConsistentRead: true }));
		return found.Item !== undefined;
	}

	async suppress(suppression: RecipientSuppression): Promise<void> {
		try {
			await this.client.send(
				new PutItemCommand({
					TableName: this.tableName,
					Item: {
						...suppressionKeys(suppression.tenantId, suppression.bindingId, suppression.address),
						tenant_id: { S: suppression.tenantId },
						binding_id: { S: suppression.bindingId },
						reason: { S: suppression.reason },
						suppressed_at: { S: suppression.suppressedAt.toISOString() },
					},
					ConditionExpression: "attribute_not_exists(pk)",
				}),
			);
		} catch (error) {
			if ((error as { name?: string }).name !== "ConditionalCheckFailedException") throw error;
		}
	}
}
