/**
 * Codec for the turn capability grant item, `{tenant}#turn#{turn}` / `grant`.
 * Item shape unchanged from python/src/chatticus/messaging/store.py: the grant is one compact JSON string with sorted keys.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { type TaskCapabilityGrant, grantFromPayload, grantToPayload } from "../../policy/capability-policy.ts";
import { turnItemPartitionKey } from "../turn-events.ts";

/** Sort key of a turn's grant item. */
export const TURN_GRANT_SORT_KEY = "grant";

/**
 * The grant as the compact JSON text Python stored: keys sorted, no spaces.
 *
 * @param grant The closed task grant.
 * @returns The stored text.
 */
export function encodeGrantText(grant: TaskCapabilityGrant): string {
	const payload = grantToPayload(grant);
	const sorted = Object.fromEntries(Object.entries(payload).sort(([left], [right]) => (left < right ? -1 : 1)));
	return JSON.stringify(sorted);
}

/**
 * Encode a turn's grant to a DynamoDB item.
 *
 * @param tenantId Organization.
 * @param turnId Turn.
 * @param grant The closed task grant.
 * @returns The item attributes.
 */
export function encodeGrant(tenantId: string, turnId: string, grant: TaskCapabilityGrant): Record<string, AttributeValue> {
	return {
		pk: { S: turnItemPartitionKey(tenantId, turnId) },
		sk: { S: TURN_GRANT_SORT_KEY },
		tenant_id: { S: tenantId },
		turn_id: { S: turnId },
		grant: { S: encodeGrantText(grant) },
	};
}

/**
 * Decode a turn's grant from its DynamoDB item.
 *
 * @param item The item.
 * @returns The closed task grant.
 * @throws Error If the item has no grant text.
 */
export function decodeGrant(item: Record<string, AttributeValue>): TaskCapabilityGrant {
	const text = item.grant?.S;
	if (text === undefined) {
		throw new Error("malformed turn grant item: grant");
	}
	return grantFromPayload(JSON.parse(text) as Record<string, unknown>);
}
