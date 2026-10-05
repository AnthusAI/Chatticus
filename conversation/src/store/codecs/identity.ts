/**
 * Codecs for Identity items.
 * Ported from python/src/chatticus/messaging/store.py lines 3043-3055.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb";

export interface Identity {
	userId: string;
	email: string;
	createdAt: Date;
}

export type Item = Record<string, AttributeValue>;

/**
 * Encode an Identity to a DynamoDB item.
 * @param value Identity to encode.
 * @returns DynamoDB item.
 */
export function encode(value: Identity): Item {
	return {
		pk: { S: `user#${value.userId}` },
		sk: { S: "identity" },
		user_id: { S: value.userId },
		email: { S: value.email },
		created_at: { S: value.createdAt.toISOString() },
	};
}

/**
 * Decode an Identity from a DynamoDB item.
 * @param item DynamoDB item.
 * @returns Decoded Identity.
 * @throws Error if required attributes are missing.
 */
export function decode(item: Item): Identity {
	const userId = item.user_id?.S;
	if (!userId) {
		throw new Error("malformed identity item: user_id");
	}

	const email = item.email?.S;
	if (!email) {
		throw new Error("malformed identity item: email");
	}

	const createdAtStr = item.created_at?.S;
	if (!createdAtStr) {
		throw new Error("malformed identity item: created_at");
	}

	return {
		userId,
		email,
		createdAt: new Date(createdAtStr),
	};
}
