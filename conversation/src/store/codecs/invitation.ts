/**
 * Codecs for Invitation items.
 * Ported from python/src/chatticus/messaging/store.py lines 3170-3215.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { formatIsoDateTime } from "./util.ts";

export interface Invitation {
	invitationId: string;
	tenantId: string;
	email: string;
	invitedByUserId: string;
	role: string;
	status: string;
	expiresAt: Date;
	createdAt: Date;
}

export type Item = Record<string, AttributeValue>;

/**
 * Encode an Invitation to a DynamoDB item.
 * @param value Invitation to encode.
 * @returns DynamoDB item.
 */
export function encode(value: Invitation): Item {
	return {
		pk: { S: `${value.tenantId}#org` },
		sk: { S: `invite#${value.invitationId}` },
		invitation_id: { S: value.invitationId },
		tenant_id: { S: value.tenantId },
		email: { S: value.email },
		invited_by_user_id: { S: value.invitedByUserId },
		role: { S: value.role },
		status: { S: value.status },
		expires_at: { N: String(Math.floor(value.expiresAt.getTime() / 1000)) },
		created_at: { S: formatIsoDateTime(value.createdAt) },
	};
}

/**
 * Decode an Invitation from a DynamoDB item.
 * @param item DynamoDB item.
 * @returns Decoded Invitation.
 * @throws Error if required attributes are missing.
 */
export function decode(item: Item): Invitation {
	const invitationId = item.invitation_id?.S;
	if (!invitationId) {
		throw new Error("malformed invitation item: invitation_id");
	}

	const tenantId = item.tenant_id?.S;
	if (!tenantId) {
		throw new Error("malformed invitation item: tenant_id");
	}

	const email = item.email?.S;
	if (!email) {
		throw new Error("malformed invitation item: email");
	}

	const invitedByUserId = item.invited_by_user_id?.S;
	if (!invitedByUserId) {
		throw new Error("malformed invitation item: invited_by_user_id");
	}

	const role = item.role?.S;
	if (!role) {
		throw new Error("malformed invitation item: role");
	}

	const status = item.status?.S;
	if (!status) {
		throw new Error("malformed invitation item: status");
	}

	const expiresEpoch = item.expires_at?.N;
	if (!expiresEpoch) {
		throw new Error("malformed invitation item: expires_at");
	}

	const createdAtStr = item.created_at?.S;
	if (!createdAtStr) {
		throw new Error("malformed invitation item: created_at");
	}

	return {
		invitationId,
		tenantId,
		email,
		invitedByUserId,
		role,
		status,
		expiresAt: new Date(Number(expiresEpoch) * 1000),
		createdAt: new Date(createdAtStr),
	};
}
