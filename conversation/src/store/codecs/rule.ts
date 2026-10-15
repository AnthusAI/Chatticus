/**
 * Codecs for auto-review rule items and for the refusals the kernel records when it declines to write one.
 * Ported from python/src/chatticus/models.py lines 443-465 and
 * python/src/chatticus/control_plane.py lines 1898-1953.
 * Item keys: pk `{tenant}#rules`, sk `RULE#<id>` and `REFUSAL#<id>`.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { ruleKey, refusalKey } from "../keys.ts";
import type { ActorKind, AutoReviewRule, AutoReviewRuleKind } from "../../policy/models.ts";
import { decodePairs, encodePairs, requireString } from "./list-util.ts";

export type Item = Record<string, AttributeValue>;

/** Which attempt the kernel declined. */
export type RefusalKind = "bot_auto_review" | "authority_ceiling" | "connection";

/** One declined attempt, kept in the order of its fields for audit. */
export interface Refusal {
	refusalId: string;
	tenantId: string;
	kind: RefusalKind;
	fields: string[];
}

/**
 * Encode an auto-review rule to a DynamoDB item.
 * @param value Rule to encode.
 * @returns DynamoDB item.
 */
export function encode(value: AutoReviewRule): Item {
	const key = ruleKey(value.tenantId, value.ruleId);
	const item: Item = {
		pk: { S: key.pk },
		sk: { S: key.sk },
		tenant_id: { S: value.tenantId },
		rule_id: { S: value.ruleId },
		kind: { S: value.kind },
		action_type: { S: value.actionType },
		argument_bindings: encodePairs(value.argumentBindings),
		creator_kind: { S: value.creator.kind },
		creator_id: { S: value.creator.actorId },
	};
	if (value.userId !== null) {
		item.user_id = { S: value.userId };
	}
	return item;
}

/**
 * Decode an auto-review rule from a DynamoDB item.
 * @param item DynamoDB item.
 * @returns Decoded rule.
 * @throws Error if required attributes are missing.
 */
export function decode(item: Item): AutoReviewRule {
	return {
		ruleId: requireString(item, "rule_id", "rule"),
		tenantId: requireString(item, "tenant_id", "rule"),
		kind: requireString(item, "kind", "rule") as AutoReviewRuleKind,
		actionType: requireString(item, "action_type", "rule"),
		userId: item.user_id?.S ?? null,
		argumentBindings: decodePairs(item.argument_bindings),
		creator: {
			kind: requireString(item, "creator_kind", "rule") as ActorKind,
			actorId: requireString(item, "creator_id", "rule"),
		},
	};
}

/**
 * Encode a refusal to a DynamoDB item.
 * @param value Refusal to encode.
 * @returns DynamoDB item.
 */
export function encodeRefusal(value: Refusal): Item {
	const key = refusalKey(value.tenantId, value.refusalId);
	return {
		pk: { S: key.pk },
		sk: { S: key.sk },
		tenant_id: { S: value.tenantId },
		refusal_id: { S: value.refusalId },
		kind: { S: value.kind },
		fields: { L: value.fields.map((field) => ({ S: field })) },
	};
}

/**
 * Decode a refusal from a DynamoDB item.
 * @param item DynamoDB item.
 * @returns Decoded refusal.
 * @throws Error if required attributes are missing.
 */
export function decodeRefusal(item: Item): Refusal {
	return {
		refusalId: requireString(item, "refusal_id", "refusal"),
		tenantId: requireString(item, "tenant_id", "refusal"),
		kind: requireString(item, "kind", "refusal") as RefusalKind,
		fields: (item.fields?.L ?? []).map((entry) => entry.S ?? ""),
	};
}
