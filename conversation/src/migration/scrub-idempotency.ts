import { type AttributeValue, type DynamoDBClient, ScanCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

/** What the scrub reads and writes. */
export type ScrubDependencies = { readonly client: DynamoDBClient; readonly messagingTableName: string };

/** What one scrub pass found and did. */
export type ScrubReport = {
	/** Post idempotency items that still hold a message body. */
	holdingText: number;
	/** Items this pass cleaned; zero unless `execute` was set. */
	scrubbed: number;
	execute: boolean;
};

const TEXT_ATTRIBUTES = ["body", "origin", "author_kind", "author_id", "addressed_to_bot_id"];

/**
 * Remove the message text from post idempotency items written before they stopped keeping it. An item keeps its channel,
 * sequence, message id and turn, which is all a replay needs: the replay reads the message from the channel record. The
 * keys are hashed, so only a scan of the table finds them. Without `execute` nothing is changed.
 *
 * @param deps Client and the Messaging table.
 * @param options Whether to write.
 * @returns How many items held text and how many were cleaned.
 */
export async function scrubIdempotencyBodies(deps: ScrubDependencies, options: { execute: boolean }): Promise<ScrubReport> {
	const report: ScrubReport = { holdingText: 0, scrubbed: 0, execute: options.execute };
	let startKey: Record<string, AttributeValue> | undefined;
	do {
		const page = await deps.client.send(
			new ScanCommand({
				TableName: deps.messagingTableName,
				FilterExpression: "begins_with(sk, :prefix) AND attribute_exists(body)",
				ExpressionAttributeValues: { ":prefix": { S: "idem#" } },
				ProjectionExpression: "pk, sk",
				ConsistentRead: true,
				ExclusiveStartKey: startKey,
			}),
		);
		for (const item of page.Items ?? []) {
			report.holdingText += 1;
			if (!options.execute) continue;
			await deps.client.send(
				new UpdateItemCommand({
					TableName: deps.messagingTableName,
					Key: { pk: item.pk!, sk: item.sk! },
					UpdateExpression: `REMOVE ${TEXT_ATTRIBUTES.join(", ")}`,
					ConditionExpression: "attribute_exists(body)",
				}),
			);
			report.scrubbed += 1;
		}
		startKey = page.LastEvaluatedKey;
	} while (startKey !== undefined);
	return report;
}
