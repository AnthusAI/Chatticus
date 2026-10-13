/**
 * Codec for the file request item: one request a member's file route leaves in the table for the live owner, with its
 * delivery state. See docs/LIVE_FILES_PROTOCOL.md section 7.1.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { liveFileOperationKey } from "../keys.ts";

/** Where a request is: queued, handed to the owner, answered, or given up on by the waiting handler. */
export type LiveFileOperationStatus = "pending" | "delivered" | "done" | "abandoned";

/** The kinds of request the owner receives. */
export type LiveFileOperationKind = "list" | "stat" | "read" | "write" | "delete" | "move" | "mkdir";

/** One file request item. */
export interface LiveFileOperation {
	operationId: string;
	tenantId: string;
	computerId: string;
	userId: string;
	/** The owner and host start generation the request was queued for; no other owner ever holds it. */
	ownerId: string;
	generation: number;
	kind: LiveFileOperationKind;
	status: LiveFileOperationStatus;
	/** The request as the owner receives it, as JSON, without `operation_id` and `expires_in_ms`; removed when abandoned. */
	request?: string;
	queuedAt: Date;
	deliveredAt?: Date;
	/** The poll sequence that delivered the request. */
	deliveredSequence?: number;
	/** The owner's answer as JSON; set when done. */
	outcome?: string;
	/** The waiting handler gave up while the request was delivered; the result route deletes the item. */
	waiterGone?: boolean;
	/** The epoch milliseconds of the audit record written for this request, when it has one. */
	auditAtMilliseconds?: number;
	/** After this time every reader treats the item as absent. */
	expiresAt: Date;
}

export type Item = Record<string, AttributeValue>;

const epochSeconds = (moment: Date): { N: string } => ({ N: String(Math.floor(moment.getTime() / 1000)) });

/**
 * Encode a file request to a DynamoDB item.
 * @param value The request item.
 * @returns The DynamoDB item.
 */
export function encode(value: LiveFileOperation): Item {
	const key = liveFileOperationKey(value.tenantId, value.operationId);
	const item: Item = {
		pk: { S: key.pk },
		sk: { S: key.sk },
		operation_id: { S: value.operationId },
		tenant_id: { S: value.tenantId },
		computer_id: { S: value.computerId },
		user_id: { S: value.userId },
		owner_id: { S: value.ownerId },
		generation: { N: String(value.generation) },
		kind: { S: value.kind },
		status: { S: value.status },
		queued_at: { S: value.queuedAt.toISOString() },
		expires_at: epochSeconds(value.expiresAt),
	};
	if (value.request !== undefined) item.request = { S: value.request };
	if (value.deliveredAt !== undefined) item.delivered_at = { S: value.deliveredAt.toISOString() };
	if (value.deliveredSequence !== undefined) item.delivered_sequence = { N: String(value.deliveredSequence) };
	if (value.outcome !== undefined) item.outcome = { S: value.outcome };
	if (value.waiterGone === true) item.waiter_gone = { BOOL: true };
	if (value.auditAtMilliseconds !== undefined) item.audit_at_ms = { N: String(value.auditAtMilliseconds) };
	return item;
}

function required(item: Item, name: string): string {
	const value = item[name]?.S;
	if (value === undefined || value === "") throw new Error(`malformed file request item: ${name}`);
	return value;
}

/**
 * Decode a file request from a DynamoDB item.
 * @param item The DynamoDB item.
 * @returns The request item.
 * @throws Error When a required attribute is missing.
 */
export function decode(item: Item): LiveFileOperation {
	const generation = item.generation?.N;
	const expiresAt = item.expires_at?.N;
	if (generation === undefined) throw new Error("malformed file request item: generation");
	if (expiresAt === undefined) throw new Error("malformed file request item: expires_at");
	return {
		operationId: required(item, "operation_id"),
		tenantId: required(item, "tenant_id"),
		computerId: required(item, "computer_id"),
		userId: required(item, "user_id"),
		ownerId: required(item, "owner_id"),
		generation: Number(generation),
		kind: required(item, "kind") as LiveFileOperationKind,
		status: required(item, "status") as LiveFileOperationStatus,
		...(item.request?.S === undefined ? {} : { request: item.request.S }),
		queuedAt: new Date(required(item, "queued_at")),
		...(item.delivered_at?.S === undefined ? {} : { deliveredAt: new Date(item.delivered_at.S) }),
		...(item.delivered_sequence?.N === undefined ? {} : { deliveredSequence: Number(item.delivered_sequence.N) }),
		...(item.outcome?.S === undefined ? {} : { outcome: item.outcome.S }),
		...(item.waiter_gone?.BOOL === true ? { waiterGone: true } : {}),
		...(item.audit_at_ms?.N === undefined ? {} : { auditAtMilliseconds: Number(item.audit_at_ms.N) }),
		expiresAt: new Date(Number(expiresAt) * 1000),
	};
}

/**
 * Whether the item is past its expiry. Every reader treats such an item as absent: the table deletes it only lazily.
 * @param operation The request item.
 * @param now The current time.
 * @returns True when the item is expired.
 */
export function isExpired(operation: LiveFileOperation, now: Date): boolean {
	return operation.expiresAt.getTime() <= now.getTime();
}
