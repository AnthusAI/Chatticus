/**
 * Authorization vocabulary shared by the policy kernel and its durable items.
 * Ported from python/src/chatticus/models.py lines 34-64, 107-140 and 443-465.
 */

export { CONSEQUENTIAL_ACTION_TYPES } from "../domain/roles.ts";

/** The member standing action type that bounds connection proposals. */
export const CONNECTION_STANDING_ACTION_TYPE = "connection";

/** The author recorded when a human acts without a named identity. */
export const KERNEL_HUMAN_AUTHOR = "kernel";

/** Personal auto-review rule kinds. Never-allow wins over require-approval, which wins over always-allow. */
export const AutoReviewRuleKind = {
	RequireApproval: "require_approval",
	AlwaysAllow: "always_allow",
	NeverAllow: "never_allow",
} as const;
export type AutoReviewRuleKind = (typeof AutoReviewRuleKind)[keyof typeof AutoReviewRuleKind];

/** Who can author a rule or an approval. */
export const ActorKind = {
	Human: "human",
	Bot: "bot",
} as const;
export type ActorKind = (typeof ActorKind)[keyof typeof ActorKind];

/** A human member or bot that authored a rule or approval. */
export interface AuthorizationIdentity {
	readonly kind: ActorKind;
	readonly actorId: string;
}

/** Return the identity of a human member. */
export function humanIdentity(userId: string): AuthorizationIdentity {
	return { kind: ActorKind.Human, actorId: userId };
}

/** Return the identity of a bot. */
export function botIdentity(botId: string): AuthorizationIdentity {
	return { kind: ActorKind.Bot, actorId: botId };
}

/**
 * A narrow auto-review rule matching an action type for one tenant.
 * Overnight pre-authorization requires a human creator and argument bindings
 * that equal the concrete operation.
 */
export interface AutoReviewRule {
	readonly ruleId: string;
	readonly kind: AutoReviewRuleKind;
	readonly actionType: string;
	readonly tenantId: string;
	readonly userId: string | null;
	readonly argumentBindings: ReadonlyArray<readonly [string, string]>;
	readonly creator: AuthorizationIdentity;
}

/** Return the creator kind for callers that only need human versus bot. */
export function ruleCreatedBy(rule: AutoReviewRule): string {
	return rule.creator.kind;
}

/** Return sorted key and value pairs, the canonical form of one binding table. */
export function sortedBindingPairs(bindings: Record<string, string>): Array<readonly [string, string]> {
	return Object.entries(bindings)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([key, value]) => [key, value] as const);
}
