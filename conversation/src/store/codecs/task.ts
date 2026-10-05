/**
 * Codecs for Task items.
 * Ported from python/src/chatticus/messaging/store.py lines 2997-3040.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb";

export interface Task {
	taskId: string;
	tenantId: string;
	userId: string;
	title: string;
	status: string;
	evidence?: string;
	closeReason?: string;
	createdByBotId?: string;
	updatedByBotId?: string;
}

export type Item = Record<string, AttributeValue>;

/**
 * Encode a Task to a DynamoDB item.
 * @param value Task to encode.
 * @returns DynamoDB item.
 */
export function encode(value: Task): Item {
	const item: Item = {
		pk: { S: `${value.tenantId}#task#${value.taskId}` },
		sk: { S: "meta" },
		tenant_id: { S: value.tenantId },
		user_id: { S: value.userId },
		task_id: { S: value.taskId },
		title: { S: value.title },
		status: { S: value.status },
	};

	if (value.evidence !== undefined) {
		item.evidence = { S: value.evidence };
	}
	if (value.closeReason !== undefined) {
		item.close_reason = { S: value.closeReason };
	}
	if (value.createdByBotId !== undefined) {
		item.created_by_bot_id = { S: value.createdByBotId };
	}
	if (value.updatedByBotId !== undefined) {
		item.updated_by_bot_id = { S: value.updatedByBotId };
	}

	return item;
}

/**
 * Decode a Task from a DynamoDB item.
 * @param item DynamoDB item.
 * @returns Decoded Task.
 * @throws Error if required attributes are missing.
 */
export function decode(item: Item): Task {
	const taskId = item.task_id?.S;
	if (!taskId) {
		throw new Error("malformed task item: task_id");
	}

	const tenantId = item.tenant_id?.S;
	if (!tenantId) {
		throw new Error("malformed task item: tenant_id");
	}

	const userId = item.user_id?.S;
	if (!userId) {
		throw new Error("malformed task item: user_id");
	}

	const title = item.title?.S;
	if (!title) {
		throw new Error("malformed task item: title");
	}

	const status = item.status?.S;
	if (!status) {
		throw new Error("malformed task item: status");
	}

	return {
		taskId,
		tenantId,
		userId,
		title,
		status,
		evidence: item.evidence?.S,
		closeReason: item.close_reason?.S,
		createdByBotId: item.created_by_bot_id?.S,
		updatedByBotId: item.updated_by_bot_id?.S,
	};
}
