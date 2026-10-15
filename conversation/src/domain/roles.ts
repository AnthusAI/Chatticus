import type { MemberRole } from "./organizations.ts";

/** Ceiling represents standing authority for one member role. */
export interface Ceiling {
	actionTypes: ReadonlySet<string>;
	origins: ReadonlySet<string>;
	recipients: ReadonlySet<string>;
	fileScopes: ReadonlySet<string>;
	egressClasses: ReadonlySet<string>;
	ingestClasses: ReadonlySet<string>;
	spendLimit: number | null;
}

/** Consequential action types. */
export const CONSEQUENTIAL_ACTION_TYPES = new Set([
	"send",
	"publish",
	"purchase",
	"delete",
	"production_change",
]);

const MEMBER_EXCLUDED_ACTION_TYPES = new Set(["purchase", "production_change"]);

const FULL_ROLE_CEILING: Ceiling = {
	actionTypes: CONSEQUENTIAL_ACTION_TYPES,
	origins: new Set(),
	recipients: new Set(),
	fileScopes: new Set(),
	egressClasses: new Set(),
	ingestClasses: new Set(),
	spendLimit: null,
};

const MEMBER_ROLE_CEILING: Ceiling = {
	actionTypes: new Set(
		[...CONSEQUENTIAL_ACTION_TYPES].filter((actionType) => !MEMBER_EXCLUDED_ACTION_TYPES.has(actionType)),
	),
	origins: new Set(),
	recipients: new Set(),
	fileScopes: new Set(),
	egressClasses: new Set(),
	ingestClasses: new Set(),
	spendLimit: null,
};

const ROLE_CEILINGS: Record<MemberRole, Ceiling> = {
	owner: FULL_ROLE_CEILING,
	member: MEMBER_ROLE_CEILING,
};

/** Return the standing authority ceiling preset for one member role. */
export function ceilingForMemberRole(role: MemberRole): Ceiling {
	return ROLE_CEILINGS[role];
}
