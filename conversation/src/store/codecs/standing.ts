/**
 * Codecs for standing items: one member's authority ceiling for one action type,
 * and what one granting tenant permits to leave through connections.
 * Ported from python/src/chatticus/authorization_ceiling.py lines 28-35 and
 * python/src/chatticus/control_plane.py lines 1955-1980 and 2199-2212.
 * Item keys: pk `{tenant}#rules`, sk `CEILING#<member>#<action type>` and `EGRESS#connection`.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { Ceiling } from "../../policy/ceiling.ts";
import type { MemberAuthorityCeiling } from "../../policy/authorization-ceiling.ts";
import { memberCeilingKey, tenantConnectionEgressKey } from "../keys.ts";
import { decodePairs, decodeStringSet, encodePairs, encodeStringSet } from "./list-util.ts";

export type Item = Record<string, AttributeValue>;

function encodeBody(value: MemberAuthorityCeiling): Item {
	const ceiling = value.grantCeiling;
	const item: Item = {
		action_types: encodeStringSet(ceiling.actionTypes),
		origins: encodeStringSet(ceiling.origins),
		recipients: encodeStringSet(ceiling.recipients),
		file_scopes: encodeStringSet(ceiling.fileScopes),
		egress_classes: encodeStringSet(ceiling.egressClasses),
		ingest_classes: encodeStringSet(ceiling.ingestClasses),
		structured_argument_bindings: encodePairs(value.structuredArgumentBindings),
	};
	if (ceiling.spendLimit !== null && ceiling.spendLimit !== undefined) {
		item.spend_limit = { N: String(ceiling.spendLimit) };
	}
	return item;
}

/**
 * Encode one member's standing ceiling for one action type to a DynamoDB item.
 * @param tenantId Organization tenant ID.
 * @param memberUserId Member user ID.
 * @param actionType Action type the ceiling bounds.
 * @param value Ceiling to encode.
 * @returns DynamoDB item.
 */
export function encodeMemberCeiling(
	tenantId: string,
	memberUserId: string,
	actionType: string,
	value: MemberAuthorityCeiling,
): Item {
	const key = memberCeilingKey(tenantId, memberUserId, actionType);
	return {
		pk: { S: key.pk },
		sk: { S: key.sk },
		tenant_id: { S: tenantId },
		member_user_id: { S: memberUserId },
		action_type: { S: actionType },
		...encodeBody(value),
	};
}

/**
 * Encode what one granting tenant permits to leave through connections to a DynamoDB item.
 * @param tenantId Granting organization tenant ID.
 * @param value Egress ceiling to encode.
 * @returns DynamoDB item.
 */
export function encodeTenantConnectionEgress(tenantId: string, value: MemberAuthorityCeiling): Item {
	const key = tenantConnectionEgressKey(tenantId);
	return {
		pk: { S: key.pk },
		sk: { S: key.sk },
		tenant_id: { S: tenantId },
		...encodeBody(value),
	};
}

/**
 * Decode a standing ceiling from either kind of standing item.
 * @param item DynamoDB item.
 * @returns Decoded member authority ceiling.
 */
export function decodeCeiling(item: Item): MemberAuthorityCeiling {
	const spend = item.spend_limit?.N;
	return {
		grantCeiling: new Ceiling(
			decodeStringSet(item.action_types),
			decodeStringSet(item.origins),
			decodeStringSet(item.recipients),
			decodeStringSet(item.file_scopes),
			decodeStringSet(item.egress_classes),
			decodeStringSet(item.ingest_classes),
			spend === undefined ? undefined : Number(spend),
		),
		structuredArgumentBindings: decodePairs(item.structured_argument_bindings),
	};
}
