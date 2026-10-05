import type { TaskCapabilityGrant } from "./capability-policy.ts";

/**
 * Standing authority a member holds, not one a task receives.
 */
export class Ceiling {
	actionTypes: ReadonlySet<string>;
	origins: ReadonlySet<string>;
	recipients: ReadonlySet<string>;
	fileScopes: ReadonlySet<string>;
	egressClasses: ReadonlySet<string>;
	ingestClasses: ReadonlySet<string>;
	spendLimit?: number | null;

	constructor(
		actionTypes: ReadonlySet<string>,
		origins: ReadonlySet<string>,
		recipients: ReadonlySet<string>,
		fileScopes: ReadonlySet<string>,
		egressClasses: ReadonlySet<string>,
		ingestClasses: ReadonlySet<string>,
		spendLimit?: number | null,
	) {
		this.actionTypes = actionTypes;
		this.origins = origins;
		this.recipients = recipients;
		this.fileScopes = fileScopes;
		this.egressClasses = egressClasses;
		this.ingestClasses = ingestClasses;
		this.spendLimit = spendLimit;
	}
}

function clipSpendLimit(left: number | null | undefined, right: number | null | undefined): number | null | undefined {
	if (left === null || left === undefined) {
		return right;
	}
	if (right === null || right === undefined) {
		return left;
	}
	return Math.min(left, right);
}

/**
 * Return grant intersected with ceiling.
 * The same operation applies to task grants, delegations, rules, and approvals: no field may extend beyond the bounding ceiling.
 */
export function clip(grant: TaskCapabilityGrant | Ceiling, ceiling: Ceiling): TaskCapabilityGrant | Ceiling {
	if (grant instanceof Ceiling) {
		return new Ceiling(
			new Set([...grant.actionTypes].filter((x) => ceiling.actionTypes.has(x))),
			new Set([...grant.origins].filter((x) => ceiling.origins.has(x))),
			new Set([...grant.recipients].filter((x) => ceiling.recipients.has(x))),
			new Set([...grant.fileScopes].filter((x) => ceiling.fileScopes.has(x))),
			new Set([...grant.egressClasses].filter((x) => ceiling.egressClasses.has(x))),
			new Set([...grant.ingestClasses].filter((x) => ceiling.ingestClasses.has(x))),
			clipSpendLimit(grant.spendLimit, ceiling.spendLimit),
		);
	}
	return {
		tools: new Set([...grant.tools].filter((x) => ceiling.actionTypes.has(x))),
		origins: new Set([...grant.origins].filter((x) => ceiling.origins.has(x))),
		recipients: new Set([...grant.recipients].filter((x) => ceiling.recipients.has(x))),
		fileScopes: new Set([...grant.fileScopes].filter((x) => ceiling.fileScopes.has(x))),
		egressClasses: new Set([...grant.egressClasses].filter((x) => ceiling.egressClasses.has(x))),
		ingestClasses: new Set([...grant.ingestClasses].filter((x) => ceiling.ingestClasses.has(x))),
	} as TaskCapabilityGrant;
}

/**
 * Return whether grant requests authority outside ceiling.
 */
export function grantExceedsCeiling(grant: TaskCapabilityGrant, ceiling: Ceiling): boolean {
	const clipped = clip(grant, ceiling);
	if (clipped instanceof Ceiling) {
		return false;
	}
	return (
		!setsEqual(clipped.tools, grant.tools) ||
		!setsEqual(clipped.origins, grant.origins) ||
		!setsEqual(clipped.recipients, grant.recipients) ||
		!setsEqual(clipped.fileScopes, grant.fileScopes) ||
		!setsEqual(clipped.egressClasses, grant.egressClasses) ||
		!setsEqual(clipped.ingestClasses, grant.ingestClasses)
	);
}

function setsEqual<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
	if (a.size !== b.size) {
		return false;
	}
	for (const item of a) {
		if (!b.has(item)) {
			return false;
		}
	}
	return true;
}
