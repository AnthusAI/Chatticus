/**
 * Unattended consequential actions: stop honestly or match a human rule.
 *
 * v1 is a web tab. Device push can only say come back. A routine that
 * reaches send, publish, purchase, delete, or production change with no
 * human at a screen has no completable approval path. Overnight work may
 * run a consequential class only when a human, out of band, created an
 * always-allow rule that binds the exact structured operation. Generic
 * browser actions cannot be pre-authorized. A bot cannot loosen auto-review
 * on its own initiative.
 *
 * Ported from python/src/chatticus/overnight_gated.py lines 1-128.
 */

import {
	ActorKind,
	AutoReviewRuleKind,
	CONSEQUENTIAL_ACTION_TYPES,
	type AutoReviewRule,
} from "./models.ts";

export const WAITING_FOR_HUMAN = "waiting_for_human";
export const USER_CONTROLLED_COMPLETION_REQUIRED = "user_controlled_completion_required";
export const CHANNEL_STRUCTURED = "structured";
export const CHANNEL_BROWSER = "browser";

export const BROWSER_ACTION_ALIASES: Readonly<Record<string, string>> = {
	send: "send",
	publish: "publish",
	purchase: "purchase",
	delete: "delete",
	"change production": "production_change",
};

/** Outcome of one unattended consequential-action attempt. */
export interface OvernightGatedResult {
	executed: boolean;
	turn_status: string;
	reason: string | null;
	completion_evidence: string | null;
	retried_unattended: boolean;
}

function bindingsEqual(
	bindings: ReadonlyArray<readonly [string, string]>,
	arguments_: Record<string, string>,
): boolean {
	const bound = Object.fromEntries(bindings);
	const boundKeys = Object.keys(bound);
	const argumentKeys = Object.keys(arguments_);
	return boundKeys.length === argumentKeys.length && boundKeys.every((key) => bound[key] === arguments_[key]);
}

/** Decide whether an overnight consequential action may run. */
export function resolveUnattendedGatedAction(options: {
	actionType: string;
	arguments: Record<string, string>;
	channel: string;
	rules: readonly AutoReviewRule[];
	tenantId: string;
	userId?: string | null;
	completionEvidence?: string;
}): OvernightGatedResult {
	const userId = options.userId ?? null;
	const completionEvidence = options.completionEvidence ?? "system-accepted";
	if (!CONSEQUENTIAL_ACTION_TYPES.has(options.actionType)) {
		return { executed: true, turn_status: "completed", reason: null, completion_evidence: null, retried_unattended: false };
	}
	if (options.channel === CHANNEL_BROWSER) {
		return {
			executed: false,
			turn_status: "blocked",
			reason: USER_CONTROLLED_COMPLETION_REQUIRED,
			completion_evidence: null,
			retried_unattended: false,
		};
	}
	const matching = options.rules.filter(
		(rule) =>
			rule.kind === AutoReviewRuleKind.AlwaysAllow &&
			rule.creator.kind === ActorKind.Human &&
			rule.actionType === options.actionType &&
			rule.tenantId === options.tenantId &&
			(rule.userId === null || rule.userId === userId) &&
			rule.argumentBindings.length > 0 &&
			bindingsEqual(rule.argumentBindings, options.arguments),
	);
	if (matching.length > 0) {
		return { executed: true, turn_status: "completed", reason: null, completion_evidence: completionEvidence, retried_unattended: false };
	}
	return { executed: false, turn_status: "blocked", reason: WAITING_FOR_HUMAN, completion_evidence: null, retried_unattended: false };
}

/**
 * Stop a generic authenticated browser consequential action.
 *
 * A screenshot or click coordinate is not approval. Without a structured
 * connector or human takeover that can bind the exact operation, the
 * action does not execute.
 */
export function resolveUnboundAuthenticatedBrowserAction(
	action: string,
	options: { structuredConnector?: boolean; takeoverControl?: boolean } = {},
): OvernightGatedResult {
	if (options.structuredConnector || options.takeoverControl) {
		throw new Error("binding control is present; this path is for unbound actions");
	}
	const actionType = BROWSER_ACTION_ALIASES[action] ?? action;
	if (!CONSEQUENTIAL_ACTION_TYPES.has(actionType)) {
		return { executed: true, turn_status: "completed", reason: null, completion_evidence: null, retried_unattended: false };
	}
	return {
		executed: false,
		turn_status: "blocked",
		reason: USER_CONTROLLED_COMPLETION_REQUIRED,
		completion_evidence: null,
		retried_unattended: false,
	};
}
