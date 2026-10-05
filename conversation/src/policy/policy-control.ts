/**
 * The approval, auto-review rule, member standing, and authorized connection operations of the control plane.
 *
 * Ported from python/src/chatticus/control_plane.py lines 1357-1382 (capability policies),
 * 1527-1567 (member standing), 1830-2212 (rules, standing ceilings, approvals, connections,
 * overnight gating) and 2802-2824 (action evaluation). Python kept rules, connections and the
 * approval binding in memory; here they are read from and written to the policy store.
 */

import { ceilingForMemberRole } from "../domain/roles.ts";
import type { IdSource } from "../domain/organizations.ts";
import { MemberStandingRequiredError } from "../http/errors.ts";
import type { Clock } from "../storage/storage-support.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import type { PolicyStore } from "../store/policy-store.ts";
import { ApprovalBindingGate } from "./approval-binding.ts";
import type {
	ApprovedOperation,
	BoundExecutionResult,
	OperationProposal,
	StructuredConsequentialOperation,
} from "./approval-binding.ts";
import {
	GRANT_STANDING_ACTION_TYPE,
	MemberStanding,
	autoReviewRuleExceedsMemberAuthorityCeiling,
	memberAuthorityCeilingFromGrantTable,
	memberAuthorityCeilingFromStructuredArguments,
	structuredOperationExceedsMemberAuthorityCeiling,
	type MemberAuthorityCeiling,
} from "./authorization-ceiling.ts";
import { CapabilityPolicy, type ApprovalDecision, type TaskCapabilityGrant } from "./capability-policy.ts";
import {
	ConnectionProposalStatus,
	authorizeConnectionFromProposal,
	findEscalationTargetUserId,
	newConnectionProposal,
	proposerMayAuthorizeImmediately,
	type AuthorizedConnection,
	type ConnectionProposal,
	type ConnectionProposalResult,
	type ConnectionProposalRoute,
} from "./connections.ts";
import {
	ActorKind,
	AutoReviewRuleKind,
	CONNECTION_STANDING_ACTION_TYPE,
	CONSEQUENTIAL_ACTION_TYPES,
	KERNEL_HUMAN_AUTHOR,
	botIdentity,
	humanIdentity,
	sortedBindingPairs,
	type AuthorizationIdentity,
} from "./models.ts";
import type { OvernightGatedResult } from "./overnight.ts";
import {
	POLICY_KERNEL_TENANT,
	POLICY_KERNEL_TURN,
	attemptAuthenticatedBrowserActionAtSink,
	executeApprovedOperationAtSink,
	resolveUnattendedGatedActionAtSink,
} from "./sinks.ts";

/** What the policy control needs from the rest of the system. */
export interface PolicyControlDependencies {
	readonly policyStore: PolicyStore;
	readonly store: MessagingStore;
	readonly clock: Clock;
	readonly ids: IdSource;
	/** Resolves the human who posted the turn prompt; required only for turns inside a real organization. */
	readonly actingMemberUserIdForTurn?: (tenantId: string, turnId: string) => Promise<string>;
}

/** Rules, approvals, standing, and connections for every tenant, backed by the policy store. */
export class PolicyControl {
	private readonly deps: PolicyControlDependencies;
	private readonly capabilityPolicies = new Map<string, CapabilityPolicy>();

	constructor(deps: PolicyControlDependencies) {
		this.deps = deps;
	}

	/** Return the capability policy for one turn, creating it if needed. */
	capabilityPolicyFor(tenantId: string, turnId: string): CapabilityPolicy {
		const key = `${tenantId}\u0000${turnId}`;
		let policy = this.capabilityPolicies.get(key);
		if (policy === undefined) {
			policy = new CapabilityPolicy(() => this.deps.clock.now());
			this.capabilityPolicies.set(key, policy);
		}
		return policy;
	}

	/** Attach one closed task grant to a turn for sink enforcement. */
	setTurnCapabilityGrant(tenantId: string, turnId: string, grant: TaskCapabilityGrant): void {
		this.capabilityPolicyFor(tenantId, turnId).setGrant(grant);
	}

	/** Return the approval binding gate for one tenant. */
	approvalBinding(tenantId: string): ApprovalBindingGate {
		return new ApprovalBindingGate(tenantId, { store: this.deps.policyStore, ids: this.deps.ids });
	}

	/** Evaluate a proposed action against defaults and tenant rules. */
	async evaluateAction(actionType: string, tenantId: string, userId: string | null = null): Promise<ApprovalDecision> {
		const rules = await this.deps.policyStore.listRules(tenantId);
		const matching = rules.filter(
			(rule) =>
				rule.actionType === actionType &&
				rule.tenantId === tenantId &&
				(rule.userId === null || rule.userId === userId),
		);
		if (matching.some((rule) => rule.kind === AutoReviewRuleKind.NeverAllow)) {
			return "DENY";
		}
		if (matching.some((rule) => rule.kind === AutoReviewRuleKind.RequireApproval)) {
			return "REQUIRE_APPROVAL";
		}
		if (matching.some((rule) => rule.kind === AutoReviewRuleKind.AlwaysAllow)) {
			return "ALLOW";
		}
		if (CONSEQUENTIAL_ACTION_TYPES.has(actionType)) {
			return "REQUIRE_APPROVAL";
		}
		return "ALLOW";
	}

	/**
	 * Add an auto-review rule scoped to a tenant, optionally one user.
	 *
	 * A bot cannot create an always-allow that loosens a consequential
	 * action. A human cannot write a rule broader than their standing
	 * ceiling. Returns whether the rule was recorded.
	 */
	async addAutoReviewRule(
		kind: AutoReviewRuleKind,
		actionType: string,
		tenantId: string,
		userId: string | null = null,
		options: {
			arguments?: Record<string, string>;
			createdBy?: string;
			creator?: AuthorizationIdentity | null;
			creatorBotId?: string | null;
		} = {},
	): Promise<boolean> {
		const createdBy = options.createdBy ?? "human";
		let resolvedCreator = options.creator ?? null;
		if (resolvedCreator === null) {
			if (createdBy === "bot") {
				resolvedCreator = botIdentity(options.creatorBotId ?? "bot");
			} else {
				resolvedCreator = humanIdentity(KERNEL_HUMAN_AUTHOR);
			}
		}
		if (resolvedCreator.kind === ActorKind.Bot && kind === AutoReviewRuleKind.AlwaysAllow) {
			await this.recordRefusal(tenantId, "bot_auto_review", [tenantId, actionType]);
			return false;
		}
		const bindings = options.arguments ?? {};
		const memberCeiling = await this.memberAuthorityCeiling(tenantId, resolvedCreator.actorId, actionType);
		if (autoReviewRuleExceedsMemberAuthorityCeiling(actionType, bindings, memberCeiling)) {
			await this.recordRefusal(tenantId, "authority_ceiling", [tenantId, actionType, resolvedCreator.actorId]);
			return false;
		}
		await this.deps.policyStore.createRule({
			ruleId: this.deps.ids.next(),
			kind,
			actionType,
			tenantId,
			userId,
			argumentBindings: sortedBindingPairs(bindings),
			creator: resolvedCreator,
		});
		return true;
	}

	/** Record one member's standing authority for a structured action. */
	async setMemberAuthorityCeiling(
		tenantId: string,
		memberUserId: string,
		actionType: string,
		options: { arguments: Record<string, string> },
	): Promise<void> {
		await this.deps.policyStore.putMemberCeiling(
			tenantId,
			memberUserId,
			actionType,
			memberAuthorityCeilingFromStructuredArguments(actionType, options.arguments),
		);
	}

	/** Record one member's closed grant-table standing for replacement checks. */
	async setMemberGrantBoundsCeiling(
		tenantId: string,
		memberUserId: string,
		options: { grantTable: Record<string, string> },
	): Promise<void> {
		await this.deps.policyStore.putMemberCeiling(
			tenantId,
			memberUserId,
			GRANT_STANDING_ACTION_TYPE,
			memberAuthorityCeilingFromGrantTable(options.grantTable),
		);
	}

	/** Return the recorded standing ceiling for one member and action. */
	async memberAuthorityCeiling(
		tenantId: string,
		memberUserId: string,
		actionType: string,
	): Promise<MemberAuthorityCeiling | null> {
		return this.deps.policyStore.getMemberCeiling(tenantId, memberUserId, actionType);
	}

	/** Approve one structured operation when the approver is within standing. */
	async approveStructuredOperation(
		tenantId: string,
		proposal: OperationProposal,
		options: { approver: AuthorizationIdentity },
	): Promise<ApprovedOperation | null> {
		const approver = options.approver;
		if (approver.kind !== ActorKind.Human) {
			await this.recordRefusal(tenantId, "authority_ceiling", [
				tenantId,
				proposal.operation.actionType,
				approver.actorId,
			]);
			return null;
		}
		const memberCeiling = await this.memberAuthorityCeiling(tenantId, approver.actorId, proposal.operation.actionType);
		if (structuredOperationExceedsMemberAuthorityCeiling(proposal.operation, memberCeiling)) {
			await this.recordRefusal(tenantId, "authority_ceiling", [
				tenantId,
				proposal.operation.actionType,
				approver.actorId,
			]);
			return null;
		}
		return this.approvalBinding(tenantId).approveOperation(proposal, approver);
	}

	/** Return always-allow attempts the kernel rejected from a bot, as tenant and action pairs. */
	async refusedBotAutoReview(tenantId: string): Promise<Array<[string, string]>> {
		const refusals = await this.deps.policyStore.listRefusals(tenantId, "bot_auto_review");
		return refusals.map((refusal) => [refusal.fields[0], refusal.fields[1]]);
	}

	/** Return rule or approval attempts refused outside standing, as tenant, action and member triples. */
	async refusedAuthorityCeiling(tenantId: string): Promise<Array<[string, string, string]>> {
		const refusals = await this.deps.policyStore.listRefusals(tenantId, "authority_ceiling");
		return refusals.map((refusal) => [refusal.fields[0], refusal.fields[1], refusal.fields[2]]);
	}

	/** Return connection proposals refused outside standing. */
	async refusedConnections(tenantId: string): Promise<Array<[string, string, string, string]>> {
		const refusals = await this.deps.policyStore.listRefusals(tenantId, "connection");
		return refusals.map((refusal) => [refusal.fields[0], refusal.fields[1], refusal.fields[2], refusal.fields[3]]);
	}

	/** Propose one connection; authorize when the proposer is within standing. */
	async proposeConnection(
		grantingTenantId: string,
		proposerUserId: string,
		receivingTenantId: string,
		channelId: string,
		channelName: string,
		permission: string = "read",
	): Promise<ConnectionProposalResult> {
		const proposal = newConnectionProposal(
			{ grantingTenantId, receivingTenantId, channelId, channelName, permission, proposerUserId },
			this.deps.ids,
		);
		const proposerCeiling = await this.memberAuthorityCeiling(
			grantingTenantId,
			proposerUserId,
			CONNECTION_STANDING_ACTION_TYPE,
		);
		const orgEgress = await this.deps.policyStore.getTenantConnectionEgress(grantingTenantId);
		if (proposerMayAuthorizeImmediately(proposal, proposerCeiling, orgEgress)) {
			return this.authorizeAndRecord(proposal, proposerUserId);
		}
		await this.deps.policyStore.createConnectionRecord({
			proposal,
			status: null,
			escalationTargetUserId: null,
			authorized: null,
		});
		return { proposal, route: null, authorized: null, refused: false };
	}

	/** Try to propose one connection; refuse synchronously when outside standing. */
	async tryProposeConnection(
		grantingTenantId: string,
		proposerUserId: string,
		receivingTenantId: string,
		channelId: string,
		channelName: string,
		permission: string = "read",
	): Promise<ConnectionProposalResult> {
		const proposal = newConnectionProposal(
			{ grantingTenantId, receivingTenantId, channelId, channelName, permission, proposerUserId },
			this.deps.ids,
		);
		const proposerCeiling = await this.memberAuthorityCeiling(
			grantingTenantId,
			proposerUserId,
			CONNECTION_STANDING_ACTION_TYPE,
		);
		const orgEgress = await this.deps.policyStore.getTenantConnectionEgress(grantingTenantId);
		if (!proposerMayAuthorizeImmediately(proposal, proposerCeiling, orgEgress)) {
			await this.recordRefusal(grantingTenantId, "connection", [
				grantingTenantId,
				proposerUserId,
				channelName,
				receivingTenantId,
			]);
			const route: ConnectionProposalRoute = {
				proposalId: proposal.proposalId,
				status: ConnectionProposalStatus.Refused,
				escalationTargetUserId: null,
			};
			await this.deps.policyStore.createConnectionRecord({
				proposal,
				status: route.status,
				escalationTargetUserId: null,
				authorized: null,
			});
			return { proposal, route, authorized: null, refused: true };
		}
		return this.authorizeAndRecord(proposal, proposerUserId);
	}

	/** Escalate or block one pending connection proposal. */
	async routeConnectionProposal(grantingTenantId: string, proposalId: string): Promise<ConnectionProposalRoute> {
		const record = await this.deps.policyStore.getConnectionRecord(grantingTenantId, proposalId);
		if (record === null) {
			throw new Error(`Unknown connection proposal ${pythonRepr(proposalId)}.`);
		}
		const proposal = record.proposal;
		const memberships = await this.deps.store.listMemberships(proposal.grantingTenantId);
		const memberUserIds = memberships.map((membership) => membership.userId);
		const targetUserId = await findEscalationTargetUserId(proposal, {
			memberUserIds,
			ceilingForMember: (userId) =>
				this.memberAuthorityCeiling(proposal.grantingTenantId, userId, CONNECTION_STANDING_ACTION_TYPE),
		});
		const route: ConnectionProposalRoute =
			targetUserId === null
				? { proposalId, status: ConnectionProposalStatus.Blocked, escalationTargetUserId: null }
				: {
						proposalId,
						status: ConnectionProposalStatus.PendingEscalation,
						escalationTargetUserId: targetUserId,
					};
		await this.deps.policyStore.replaceConnectionRecord({
			proposal,
			status: route.status,
			escalationTargetUserId: route.escalationTargetUserId,
			authorized: record.authorized,
		});
		return route;
	}

	/** Return every authorized connection clip one granting tenant holds. */
	async authorizedConnections(grantingTenantId: string): Promise<AuthorizedConnection[]> {
		const records = await this.deps.policyStore.listConnectionRecords(grantingTenantId);
		return records.flatMap((record) => (record.authorized === null ? [] : [record.authorized]));
	}

	/** Return the routing outcome for one connection proposal. */
	async connectionRoute(grantingTenantId: string, proposalId: string): Promise<ConnectionProposalRoute | null> {
		const record = await this.deps.policyStore.getConnectionRecord(grantingTenantId, proposalId);
		if (record === null || record.status === null) {
			return null;
		}
		return { proposalId, status: record.status, escalationTargetUserId: record.escalationTargetUserId };
	}

	/** Record what one granting tenant permits to leave via connections. */
	async setTenantConnectionEgress(tenantId: string, options: { arguments: Record<string, string> }): Promise<void> {
		await this.deps.policyStore.putTenantConnectionEgress(
			tenantId,
			memberAuthorityCeilingFromStructuredArguments(CONNECTION_STANDING_ACTION_TYPE, options.arguments),
		);
	}

	/** Execute one human-approved connector operation at the sink. */
	async executeApprovedStructuredOperation(
		tenantId: string,
		turnId: string,
		approval: ApprovedOperation,
		attempted: StructuredConsequentialOperation,
		completionEvidence: string,
	): Promise<BoundExecutionResult> {
		const memberStanding = await this.memberStandingForTurn(tenantId, turnId, attempted.actionType);
		return executeApprovedOperationAtSink(
			this.capabilityPolicyFor(tenantId, turnId),
			this.approvalBinding(tenantId),
			approval,
			attempted,
			completionEvidence,
			memberStanding,
		);
	}

	/** Stop or pre-authorize a consequential action with no screen. */
	async resolveUnattendedGatedAction(
		actionType: string,
		tenantId: string,
		options: {
			arguments: Record<string, string>;
			channel: string;
			userId?: string | null;
			completionEvidence?: string;
			turnId?: string;
		},
	): Promise<OvernightGatedResult> {
		const userId = options.userId ?? null;
		const turnId = options.turnId ?? POLICY_KERNEL_TURN;
		const memberStanding =
			userId !== null
				? await this.memberStandingForUser(tenantId, userId, actionType)
				: await this.memberStandingForTurn(tenantId, turnId, actionType);
		return resolveUnattendedGatedActionAtSink(this.capabilityPolicyFor(tenantId, turnId), {
			actionType,
			arguments: options.arguments,
			channel: options.channel,
			rules: await this.deps.policyStore.listRules(tenantId),
			tenantId,
			memberStanding,
			userId,
			completionEvidence: options.completionEvidence ?? "system-accepted",
		});
	}

	/** Refuse unbound consequential browser actions. */
	attemptAuthenticatedBrowserAction(
		action: string,
		options: {
			tenantId?: string;
			turnId?: string;
			structuredConnector?: boolean;
			takeoverControl?: boolean;
		} = {},
	): OvernightGatedResult {
		return attemptAuthenticatedBrowserActionAtSink(
			this.capabilityPolicyFor(options.tenantId ?? POLICY_KERNEL_TENANT, options.turnId ?? POLICY_KERNEL_TURN),
			action,
			{
				structuredConnector: options.structuredConnector ?? false,
				takeoverControl: options.takeoverControl ?? false,
			},
		);
	}

	/** Resolve one member's standing at a sink; a tenant that is not an organization is the kernel-only owner. */
	async memberStandingForUser(tenantId: string, userId: string, actionType: string | null = null): Promise<MemberStanding> {
		const organization = await this.deps.store.getOrganization(tenantId);
		if (organization === null) {
			return MemberStanding.owner();
		}
		const membership = await this.deps.store.getMembership(tenantId, userId);
		if (membership === null) {
			throw new MemberStandingRequiredError(
				`Member ${pythonRepr(userId)} has no standing in tenant ${pythonRepr(tenantId)}.`,
			);
		}
		const perAction = actionType === null ? null : await this.memberAuthorityCeiling(tenantId, userId, actionType);
		return new MemberStanding(ceilingForMemberRole(membership.role), perAction);
	}

	/** Resolve the standing of the member who posted the turn prompt. */
	async memberStandingForTurn(tenantId: string, turnId: string, actionType: string | null = null): Promise<MemberStanding> {
		const organization = await this.deps.store.getOrganization(tenantId);
		if (organization === null) {
			return MemberStanding.owner();
		}
		const resolver = this.deps.actingMemberUserIdForTurn;
		if (resolver === undefined) {
			throw new Error(`Turn ${pythonRepr(turnId)} has no prompt message.`);
		}
		return this.memberStandingForUser(tenantId, await resolver(tenantId, turnId), actionType);
	}

	private async authorizeAndRecord(
		proposal: ConnectionProposal,
		proposerUserId: string,
	): Promise<ConnectionProposalResult> {
		const authorized = authorizeConnectionFromProposal(
			proposal,
			{ clippedByUserId: proposerUserId, createdAt: this.deps.clock.now() },
			this.deps.ids,
		);
		const route: ConnectionProposalRoute = {
			proposalId: proposal.proposalId,
			status: ConnectionProposalStatus.Authorized,
			escalationTargetUserId: null,
		};
		await this.deps.policyStore.createConnectionRecord({
			proposal,
			status: route.status,
			escalationTargetUserId: null,
			authorized,
		});
		return { proposal, route, authorized, refused: false };
	}

	private async recordRefusal(
		tenantId: string,
		kind: "bot_auto_review" | "authority_ceiling" | "connection",
		fields: string[],
	): Promise<void> {
		await this.deps.policyStore.createRefusal({ refusalId: this.deps.ids.next(), tenantId, kind, fields });
	}
}

function pythonRepr(value: string): string {
	return `'${value}'`;
}
