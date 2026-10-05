/**
 * Codecs for Membership items.
 * Ported from python/src/chatticus/messaging/store.py lines 3110-3126.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb";

export interface Membership {
	tenantId: string;
	userId: string;
	role: string;
	joinedAt: Date;
}

export type Item = Record<string, AttributeValue>;

/**
 * Encode a Membership to a DynamoDB item.
 * @param value Membership to encode.
 * @returns DynamoDB item.
 */
export function encode(value: Membership): Item {
	return {
		pk: { S: `${value.tenantId}#org` },
		sk: { S: `member#${value.userId}` },
		tenant_id: { S: value.tenantId },
		user_id: { S: value.userId },
		role: { S: value.role },
		joined_at: { S: value.joinedAt.toISOString() },
	};
}

/**
 * Decode a Membership from a DynamoDB item.
 * @param item DynamoDB item.
 * @returns Decoded Membership.
 * @throws Error if required attributes are missing.
 */
export function decode(item: Item): Membership {
	const tenantId = item.tenant_id?.S;
	if (!tenantId) {
		throw new Error("malformed membership item: tenant_id");
	}

	const userId = item.user_id?.S;
	if (!userId) {
		throw new Error("malformed membership item: user_id");
	}

	const role = item.role?.S;
	if (!role) {
		throw new Error("malformed membership item: role");
	}

	const joinedAtStr = item.joined_at?.S;
	if (!joinedAtStr) {
		throw new Error("malformed membership item: joined_at");
	}

	return {
		tenantId,
		userId,
		role,
		joinedAt: new Date(joinedAtStr),
	};
}
