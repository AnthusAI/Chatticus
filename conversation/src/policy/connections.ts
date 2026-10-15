/**
 * Authorized connections between organizations as channel-scoped clips.
 *
 * A connection grants borrowed standing on one named channel in the granting
 * organization. It is not a consequential tool and is not part of the receiver's
 * authority ceiling.
 *
 * Ported from python/src/chatticus/authorized_connections.py lines 1-207.
 */

import type { IdSource } from "../domain/organizations.ts";
import { DomainError } from "../http/errors.ts";
import {
	connectionProposalExceedsMemberAuthorityCeiling,
	structuredBindingsWithinCeilingBindings,
	type MemberAuthorityCeiling,
} from "./authorization-ceiling.ts";

export const CONNECTION_PERMISSION_READ = "read";

/** Lifecycle of one connection proposal. */
export const ConnectionProposalStatus = {
	Authorized: "authorized",
	Refused: "refused",
	PendingEscalation: "pending_escalation",
	Blocked: "blocked",
} as const;
export type ConnectionProposalStatus = (typeof ConnectionProposalStatus)[keyof typeof ConnectionProposalStatus];

/** A connection may reach a channel only, never the workplace. */
export class InvalidConnectionTargetError extends DomainError {
	constructor(message: string) {
		super("invalid_connection_target", message);
	}
}

/** One member-proposed cross-organization channel read clip. */
export interface ConnectionProposal {
	readonly proposalId: string;
	readonly grantingTenantId: string;
	readonly receivingTenantId: string;
	readonly channelId: string;
	readonly channelName: string;
	readonly permission: string;
	readonly proposerUserId: string;
}

/** Borrowed standing one receiving tenant holds on one channel. */
export interface AuthorizedConnection {
	readonly connectionId: string;
	readonly grantingTenantId: string;
	readonly receivingTenantId: string;
	readonly channelId: string;
	readonly channelName: string;
	readonly permission: string;
	readonly clippedByUserId: string;
	readonly createdAt: Date;
}

/** Routing outcome for one connection proposal. */
export interface ConnectionProposalRoute {
	readonly proposalId: string;
	readonly status: ConnectionProposalStatus;
	readonly escalationTargetUserId: string | null;
}

/** Outcome of proposing or trying to propose one connection. */
export interface ConnectionProposalResult {
	readonly proposal: ConnectionProposal | null;
	readonly route: ConnectionProposalRoute | null;
	readonly authorized: AuthorizedConnection | null;
	readonly refused: boolean;
}

/** Return the structured bindings one connection proposal carries. */
export function connectionArgumentBindings(options: {
	channelName: string;
	receivingTenantId: string;
}): Record<string, string> {
	return {
		channel: options.channelName,
		receiving_tenant: options.receivingTenantId,
	};
}

/** Refuse workplace-level or unsupported connection targets. */
export function validateConnectionTarget(options: { permission: string; channelName: string }): void {
	if (options.permission !== CONNECTION_PERMISSION_READ) {
		throw new InvalidConnectionTargetError(`Unsupported connection permission ${pythonRepr(options.permission)}.`);
	}
	if (options.channelName.startsWith("/")) {
		throw new InvalidConnectionTargetError("Connections may reach a channel only, never the workplace.");
	}
}

function pythonRepr(value: string): string {
	return `'${value}'`;
}

/** Return whether one member ceiling covers the proposal bindings. */
export function memberCoversConnectionProposal(
	proposal: ConnectionProposal,
	memberCeiling: MemberAuthorityCeiling | null,
): boolean {
	if (memberCeiling === null) {
		return false;
	}
	const bindings = connectionArgumentBindings({
		channelName: proposal.channelName,
		receivingTenantId: proposal.receivingTenantId,
	});
	const ceilingBindings = Object.fromEntries(memberCeiling.structuredArgumentBindings);
	return structuredBindingsWithinCeilingBindings(bindings, ceilingBindings);
}

/** Return whether the granting tenant permits this connection to leave. */
export function orgEgressAllowsConnection(
	proposal: ConnectionProposal,
	orgEgressCeiling: MemberAuthorityCeiling | null,
): boolean {
	if (orgEgressCeiling === null) {
		return true;
	}
	return memberCoversConnectionProposal(proposal, orgEgressCeiling);
}

/** Return the nearest member whose ceiling covers the proposal. */
export async function findEscalationTargetUserId(
	proposal: ConnectionProposal,
	options: {
		memberUserIds: string[];
		ceilingForMember: (userId: string) => Promise<MemberAuthorityCeiling | null>;
	},
): Promise<string | null> {
	const covering: string[] = [];
	for (const userId of options.memberUserIds) {
		const ceiling = await options.ceilingForMember(userId);
		if (memberCoversConnectionProposal(proposal, ceiling)) {
			covering.push(userId);
		}
	}
	if (covering.length === 0) {
		return null;
	}
	const others = covering.filter((userId) => userId !== proposal.proposerUserId).sort(compareStrings);
	if (others.length > 0) {
		return others[0];
	}
	return [...covering].sort(compareStrings)[0];
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** Build one validated connection proposal. */
export function newConnectionProposal(
	options: {
		grantingTenantId: string;
		receivingTenantId: string;
		channelId: string;
		channelName: string;
		permission: string;
		proposerUserId: string;
	},
	ids: IdSource,
): ConnectionProposal {
	validateConnectionTarget({ permission: options.permission, channelName: options.channelName });
	return {
		proposalId: ids.next(),
		grantingTenantId: options.grantingTenantId,
		receivingTenantId: options.receivingTenantId,
		channelId: options.channelId,
		channelName: options.channelName,
		permission: options.permission,
		proposerUserId: options.proposerUserId,
	};
}

/** Build one authorized clip from a covered proposal. */
export function authorizeConnectionFromProposal(
	proposal: ConnectionProposal,
	options: { clippedByUserId: string; createdAt: Date },
	ids: IdSource,
): AuthorizedConnection {
	return {
		connectionId: ids.next(),
		grantingTenantId: proposal.grantingTenantId,
		receivingTenantId: proposal.receivingTenantId,
		channelId: proposal.channelId,
		channelName: proposal.channelName,
		permission: proposal.permission,
		clippedByUserId: options.clippedByUserId,
		createdAt: options.createdAt,
	};
}

/** Return whether the proposer may self-authorize this connection. */
export function proposerMayAuthorizeImmediately(
	proposal: ConnectionProposal,
	proposerCeiling: MemberAuthorityCeiling | null,
	orgEgressCeiling: MemberAuthorityCeiling | null,
): boolean {
	if (
		connectionProposalExceedsMemberAuthorityCeiling(
			proposal.channelName,
			proposal.receivingTenantId,
			proposerCeiling,
		)
	) {
		return false;
	}
	return orgEgressAllowsConnection(proposal, orgEgressCeiling);
}
