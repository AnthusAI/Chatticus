/**
 * Validate rules and approvals against a member authority ceiling.
 * Ported from python/src/chatticus/authorization_ceiling.py lines 1-312.
 */

import { ceilingForMemberRole } from "../domain/roles.ts";
import {
	EgressClass,
	TaskCapabilityGrant,
	parseGrantTable,
	type RequestedCapability,
} from "./capability-policy.ts";
import { Ceiling, grantExceedsCeiling } from "./ceiling.ts";
import type { StructuredConsequentialOperation } from "./approval-binding.ts";
import { CONNECTION_STANDING_ACTION_TYPE, CONSEQUENTIAL_ACTION_TYPES } from "./models.ts";

export const STRUCTURED_ARGUMENT_ALIASES: Readonly<Record<string, string>> = {
	recipient: "destination",
	destination: "destination",
	body: "payload",
	payload: "payload",
};

export const GRANT_STANDING_ACTION_TYPE = "_grant_bounds";

/** Standing authority one member holds for one consequential class. */
export interface MemberAuthorityCeiling {
	readonly grantCeiling: Ceiling;
	readonly structuredArgumentBindings: ReadonlyArray<readonly [string, string]>;
}

/** Resolved standing for one member at a capability sink. */
export class MemberStanding {
	readonly roleCeiling: { readonly actionTypes: ReadonlySet<string> };
	readonly perActionCeiling: MemberAuthorityCeiling | null;

	constructor(
		roleCeiling: { readonly actionTypes: ReadonlySet<string> },
		perActionCeiling: MemberAuthorityCeiling | null = null,
	) {
		this.roleCeiling = roleCeiling;
		this.perActionCeiling = perActionCeiling;
	}

	/** Return unrestricted owner standing for kernel-only sink tests. */
	static owner(): MemberStanding {
		return new MemberStanding(ceilingForMemberRole("owner"));
	}
}

function emptyOrSingle(value: string | null | undefined): Set<string> {
	return value ? new Set([value]) : new Set();
}

/** Build the task grant one sink request represents. */
export function taskGrantForRequestedCapability(request: RequestedCapability): TaskCapabilityGrant {
	return new TaskCapabilityGrant(
		emptyOrSingle(request.tool),
		emptyOrSingle(request.origin),
		emptyOrSingle(request.recipient),
		emptyOrSingle(request.filePath),
		emptyOrSingle(request.egressClass),
		new Set(),
	);
}

/** Return whether one sink request exceeds the member's standing. */
export function requestExceedsMemberStanding(
	request: RequestedCapability,
	standing: MemberStanding,
	structuredArguments: Record<string, string> | null = null,
): boolean {
	if (CONSEQUENTIAL_ACTION_TYPES.has(request.tool)) {
		if (!standing.roleCeiling.actionTypes.has(request.tool)) {
			return true;
		}
	}
	const perAction = standing.perActionCeiling;
	if (perAction === null) {
		return false;
	}
	const grant = taskGrantForRequestedCapability(request);
	if (grantExceedsMemberAuthorityCeiling(grant, perAction)) {
		return true;
	}
	if (perAction.structuredArgumentBindings.length > 0 && structuredArguments !== null && Object.keys(structuredArguments).length > 0) {
		const ceilingBindings = Object.fromEntries(perAction.structuredArgumentBindings);
		return !structuredBindingsWithinCeilingBindings(structuredArguments, ceilingBindings);
	}
	return false;
}

/** Map structured argument names to one canonical vocabulary. */
export function normalizeStructuredArguments(arguments_: Record<string, string>): Record<string, string> {
	const normalized: Record<string, string> = {};
	for (const [key, value] of Object.entries(arguments_)) {
		const canonical = STRUCTURED_ARGUMENT_ALIASES[key] ?? key;
		normalized[canonical] = value;
	}
	return normalized;
}

function egressForAction(actionType: string): string | null {
	if (actionType === "send") {
		return EgressClass.StructuredSend;
	}
	if (CONSEQUENTIAL_ACTION_TYPES.has(actionType)) {
		return EgressClass.FileTransfer;
	}
	return null;
}

/** Build the task grant one structured consequential action requests. */
export function taskGrantForStructuredArguments(
	actionType: string,
	arguments_: Record<string, string>,
): TaskCapabilityGrant {
	const normalized = normalizeStructuredArguments(arguments_);
	const recipient = normalized["destination"];
	const egress = egressForAction(actionType);
	const tools = CONSEQUENTIAL_ACTION_TYPES.has(actionType) ? new Set([actionType]) : new Set<string>();
	return new TaskCapabilityGrant(
		tools,
		new Set(),
		emptyOrSingle(recipient),
		new Set(),
		emptyOrSingle(egress),
		new Set(),
	);
}

/** Build the task grant one immutable approval authorizes. */
export function taskGrantForStructuredOperation(operation: StructuredConsequentialOperation): TaskCapabilityGrant {
	return taskGrantForStructuredArguments(operation.actionType, {
		destination: operation.destination,
		payload: operation.payload,
	});
}

/** Return whether attempted bindings stay within the ceiling argument bindings. */
export function structuredBindingsWithinCeilingBindings(
	attempted: Record<string, string>,
	ceilingBindings: Record<string, string>,
): boolean {
	if (Object.keys(ceilingBindings).length === 0) {
		return true;
	}
	const normalizedAttempted = normalizeStructuredArguments(attempted);
	const normalizedCeiling = normalizeStructuredArguments(ceilingBindings);
	return Object.entries(normalizedCeiling).every(([key, value]) => normalizedAttempted[key] === value);
}

function sortedPairs(arguments_: Record<string, string>): Array<readonly [string, string]> {
	return Object.entries(arguments_)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([key, value]) => [key, value] as const);
}

/** Build a member ceiling from one structured binding table. */
export function memberAuthorityCeilingFromStructuredArguments(
	actionType: string,
	arguments_: Record<string, string>,
): MemberAuthorityCeiling {
	if (actionType === CONNECTION_STANDING_ACTION_TYPE) {
		return {
			grantCeiling: new Ceiling(
				new Set([CONNECTION_STANDING_ACTION_TYPE]),
				new Set(),
				new Set(),
				new Set(),
				new Set(),
				new Set(),
			),
			structuredArgumentBindings: sortedPairs(arguments_),
		};
	}
	const normalized = normalizeStructuredArguments(arguments_);
	const recipient = normalized["destination"];
	const egress = egressForAction(actionType);
	return {
		grantCeiling: new Ceiling(
			new Set([actionType]),
			new Set(),
			emptyOrSingle(recipient),
			new Set(),
			emptyOrSingle(egress),
			new Set(),
		),
		structuredArgumentBindings: sortedPairs(arguments_),
	};
}

/** Return whether a connection proposal exceeds one member's standing. */
export function connectionProposalExceedsMemberAuthorityCeiling(
	channelName: string,
	receivingTenantId: string,
	memberCeiling: MemberAuthorityCeiling | null,
): boolean {
	if (memberCeiling === null) {
		return true;
	}
	const attempted = {
		channel: channelName,
		receiving_tenant: receivingTenantId,
	};
	const ceilingBindings = Object.fromEntries(memberCeiling.structuredArgumentBindings);
	return !structuredBindingsWithinCeilingBindings(attempted, ceilingBindings);
}

/** Return whether `grant` exceeds the member standing ceiling. */
export function grantExceedsMemberAuthorityCeiling(
	grant: TaskCapabilityGrant,
	memberCeiling: MemberAuthorityCeiling | null,
): boolean {
	if (memberCeiling === null) {
		return false;
	}
	return grantExceedsCeiling(grant, memberCeiling.grantCeiling);
}

/** Return whether an auto-review rule exceeds the author's standing. */
export function autoReviewRuleExceedsMemberAuthorityCeiling(
	actionType: string,
	argumentBindings: Record<string, string>,
	memberCeiling: MemberAuthorityCeiling | null,
): boolean {
	if (memberCeiling === null) {
		return false;
	}
	const grant = taskGrantForStructuredArguments(actionType, argumentBindings);
	if (grantExceedsMemberAuthorityCeiling(grant, memberCeiling)) {
		return true;
	}
	if (memberCeiling.structuredArgumentBindings.length > 0) {
		const ceilingBindings = Object.fromEntries(memberCeiling.structuredArgumentBindings);
		return !structuredBindingsWithinCeilingBindings(argumentBindings, ceilingBindings);
	}
	return false;
}

/** Return whether an approval would exceed the approver's standing. */
export function structuredOperationExceedsMemberAuthorityCeiling(
	operation: StructuredConsequentialOperation,
	memberCeiling: MemberAuthorityCeiling | null,
): boolean {
	if (memberCeiling === null) {
		return false;
	}
	const grant = taskGrantForStructuredOperation(operation);
	if (grantExceedsMemberAuthorityCeiling(grant, memberCeiling)) {
		return true;
	}
	if (memberCeiling.structuredArgumentBindings.length > 0) {
		const attempted = {
			destination: operation.destination,
			payload: operation.payload,
		};
		const ceilingBindings = Object.fromEntries(memberCeiling.structuredArgumentBindings);
		return !structuredBindingsWithinCeilingBindings(attempted, ceilingBindings);
	}
	return false;
}

/** Build one member standing ceiling from a closed grant table. */
export function memberAuthorityCeilingFromGrantTable(rows: Record<string, string>): MemberAuthorityCeiling {
	const grant = parseGrantTable(rows);
	return {
		grantCeiling: new Ceiling(
			new Set(grant.tools),
			grant.origins,
			grant.recipients,
			grant.fileScopes,
			grant.egressClasses,
			grant.ingestClasses,
		),
		structuredArgumentBindings: [],
	};
}

/** Return whether one replacement grant exceeds the acting member's standing. */
export async function grantReplaceExceedsActingMemberStanding(
	grant: TaskCapabilityGrant,
	options: {
		roleCeiling: { readonly actionTypes: ReadonlySet<string> };
		grantBoundsCeiling: MemberAuthorityCeiling | null;
		memberAuthorityCeilingFor: (actionType: string) => Promise<MemberAuthorityCeiling | null>;
	},
): Promise<boolean> {
	const consequential = [...grant.tools].filter((tool) => CONSEQUENTIAL_ACTION_TYPES.has(tool));
	if (!consequential.every((tool) => options.roleCeiling.actionTypes.has(tool))) {
		return true;
	}
	if (
		options.grantBoundsCeiling !== null &&
		grantExceedsMemberAuthorityCeiling(grant, options.grantBoundsCeiling)
	) {
		return true;
	}
	for (const tool of consequential) {
		const perAction = await options.memberAuthorityCeilingFor(tool);
		if (perAction === null) {
			continue;
		}
		if (grantExceedsMemberAuthorityCeiling(grant, perAction)) {
			return true;
		}
	}
	return false;
}
