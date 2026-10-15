/**
 * Codec utilities for sets and ordered pairs stored as DynamoDB lists.
 * Lists are used instead of string sets because a string set cannot be empty.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb";

/**
 * Encode a set of strings as a sorted DynamoDB list.
 */
export function encodeStringSet(values: ReadonlySet<string>): AttributeValue {
	return { L: [...values].sort().map((value) => ({ S: value })) };
}

/**
 * Decode a DynamoDB list of strings into a set; a missing attribute is empty.
 */
export function decodeStringSet(attribute: AttributeValue | undefined): Set<string> {
	return new Set((attribute?.L ?? []).map((entry) => entry.S ?? ""));
}

/**
 * Encode ordered key and value pairs as a DynamoDB list of two-element lists.
 */
export function encodePairs(pairs: ReadonlyArray<readonly [string, string]>): AttributeValue {
	return { L: pairs.map(([key, value]) => ({ L: [{ S: key }, { S: value }] })) };
}

/**
 * Decode a DynamoDB list of two-element lists into ordered key and value pairs.
 */
export function decodePairs(attribute: AttributeValue | undefined): Array<readonly [string, string]> {
	return (attribute?.L ?? []).map((entry) => [entry.L?.[0]?.S ?? "", entry.L?.[1]?.S ?? ""] as const);
}

/**
 * Read a required string attribute or throw the malformed-item error for its kind.
 */
export function requireString(item: Record<string, AttributeValue>, attribute: string, kind: string): string {
	const value = item[attribute]?.S;
	if (value === undefined || value === "") {
		throw new Error(`malformed ${kind} item: ${attribute}`);
	}
	return value;
}
