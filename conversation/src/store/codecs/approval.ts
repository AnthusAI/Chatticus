/**
 * Codecs for Approval items: one reviewed proposal or one approval bound to a reviewed operation.
 * Ported from python/src/chatticus/approval_binding.py lines 29-75.
 * Item keys: pk `{tenant}#approvals`, sk `APPROVAL#<id>`.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { approvalKey } from "../keys.ts";
import { requireString } from "./list-util.ts";

/** Whether the item is an operation awaiting review or an approval bound to a reviewed operation. */
export type ApprovalKind = "proposal" | "approval";

export interface ApprovalItem {
	approvalId: string;
	tenantId: string;
	kind: ApprovalKind;
	actionType: string;
	destination: string;
	payload: string;
	approverKind: string | null;
	approverId: string | null;
}

export type Item = Record<string, AttributeValue>;

/**
 * Encode an approval or proposal to a DynamoDB item.
 * @param value Approval item to encode.
 * @returns DynamoDB item.
 */
export function encode(value: ApprovalItem): Item {
	const key = approvalKey(value.tenantId, value.approvalId);
	const item: Item = {
		pk: { S: key.pk },
		sk: { S: key.sk },
		tenant_id: { S: value.tenantId },
		approval_id: { S: value.approvalId },
		kind: { S: value.kind },
		action_type: { S: value.actionType },
		destination: { S: value.destination },
		payload: { S: value.payload },
	};
	if (value.approverKind !== null) {
		item.approver_kind = { S: value.approverKind };
	}
	if (value.approverId !== null) {
		item.approver_id = { S: value.approverId };
	}
	return item;
}

/**
 * Decode an approval or proposal from a DynamoDB item.
 * @param item DynamoDB item.
 * @returns Decoded approval item.
 * @throws Error if required attributes are missing.
 */
export function decode(item: Item): ApprovalItem {
	const kind = requireString(item, "kind", "approval");
	if (kind !== "proposal" && kind !== "approval") {
		throw new Error("malformed approval item: kind");
	}
	return {
		approvalId: requireString(item, "approval_id", "approval"),
		tenantId: requireString(item, "tenant_id", "approval"),
		kind,
		actionType: requireString(item, "action_type", "approval"),
		destination: item.destination?.S ?? "",
		payload: item.payload?.S ?? "",
		approverKind: item.approver_kind?.S ?? null,
		approverId: item.approver_id?.S ?? null,
	};
}
