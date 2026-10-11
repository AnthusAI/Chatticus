import {
	ConditionalCheckFailedException,
	DeleteItemCommand,
	GetItemCommand,
	PutItemCommand,
	ScanCommand,
	type AttributeValue,
	type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { computerRecordKey } from "../store/keys.ts";

/** What the computer record move reads and writes. */
export type ComputerRecordMoveDependencies = {
	readonly client: DynamoDBClient;
	readonly messagingTableName: string;
};

/** Options of one pass. */
export type ComputerRecordMoveOptions = {
	/** Write for real; without it the pass only reports. */
	readonly execute: boolean;
	/** Limit the pass to one organization. */
	readonly tenantId?: string;
};

/** What happened, or would happen, to the computer record of one organization. */
export type ComputerRecordMove = {
	readonly tenantId: string;
	/**
	 * `moved`: copied to the new key and deleted from the roster. `already_moved`: the new key existed, so only the roster
	 * copy was deleted. The `would_` outcomes are the same two cases in a dry run.
	 */
	readonly outcome: "moved" | "already_moved" | "would_move" | "would_delete_old_copy";
};

const ROSTER_SUFFIX = "#roster";
const OLD_SORT_KEY = "computer";

/**
 * Move the computer record of every organization from the roster partition (`<tenant>#roster`, sort key `computer`) to its
 * own partition (`<tenant>#computer#record`), so a container owner's credentials can be denied the roster. The pass copies
 * the item with a conditional put that never overwrites a record already at the new key, then deletes the old item. Running
 * it twice, or after the new code has written the record at the new key, changes nothing further: the new key wins.
 *
 * @param deps The client and the Messaging table name.
 * @param options Whether to write, and an optional organization.
 * @returns One entry per organization that had a record at the old key.
 */
export async function moveComputerRecords(
	deps: ComputerRecordMoveDependencies,
	options: ComputerRecordMoveOptions,
): Promise<ComputerRecordMove[]> {
	const moves: ComputerRecordMove[] = [];
	let startKey: Record<string, AttributeValue> | undefined;
	do {
		const page = await deps.client.send(
			new ScanCommand({
				TableName: deps.messagingTableName,
				FilterExpression: "sk = :sk AND contains(pk, :roster)",
				ExpressionAttributeValues: { ":sk": { S: OLD_SORT_KEY }, ":roster": { S: ROSTER_SUFFIX } },
				ExclusiveStartKey: startKey,
			}),
		);
		for (const item of page.Items ?? []) {
			const oldPartition = item["pk"]?.S ?? "";
			if (!oldPartition.endsWith(ROSTER_SUFFIX)) continue;
			const tenantId = oldPartition.slice(0, -ROSTER_SUFFIX.length);
			if (options.tenantId !== undefined && options.tenantId !== tenantId) continue;
			moves.push(await moveOne(deps, item, tenantId, options.execute));
		}
		startKey = page.LastEvaluatedKey;
	} while (startKey !== undefined);
	return moves;
}

async function moveOne(
	deps: ComputerRecordMoveDependencies,
	item: Record<string, AttributeValue>,
	tenantId: string,
	execute: boolean,
): Promise<ComputerRecordMove> {
	const newKey = computerRecordKey(tenantId);
	if (!execute) {
		const existing = await deps.client.send(
			new GetItemCommand({
				TableName: deps.messagingTableName,
				Key: { pk: { S: newKey.pk }, sk: { S: newKey.sk } },
				ConsistentRead: true,
			}),
		);
		return { tenantId, outcome: existing.Item === undefined ? "would_move" : "would_delete_old_copy" };
	}
	let alreadyThere = false;
	try {
		await deps.client.send(
			new PutItemCommand({
				TableName: deps.messagingTableName,
				Item: { ...item, pk: { S: newKey.pk }, sk: { S: newKey.sk } },
				ConditionExpression: "attribute_not_exists(pk)",
			}),
		);
	} catch (error) {
		if (!(error instanceof ConditionalCheckFailedException)) throw error;
		alreadyThere = true;
	}
	await deps.client.send(new DeleteItemCommand({ TableName: deps.messagingTableName, Key: { pk: item["pk"]!, sk: item["sk"]! } }));
	return { tenantId, outcome: alreadyThere ? "already_moved" : "moved" };
}
