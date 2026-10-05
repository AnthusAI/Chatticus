/**
 * Bind human approval to one immutable consequential operation.
 *
 * When a user approves a structured operation, only the exact destination
 * and payload they reviewed may execute. A model cannot substitute a
 * different target after approval. Completion evidence comes from the
 * target system, not from the agent.
 *
 * Ported from python/src/chatticus/approval_binding.py lines 1-164.
 * Proposals and approvals are durable APPROVAL# items instead of in-memory dicts.
 */

import type { IdSource } from "../domain/organizations.ts";
import type { PolicyStore } from "../store/policy-store.ts";
import { PolicyItemAlreadyExistsError } from "../store/policy-store.ts";
import {
	CONSEQUENTIAL_ACTION_TYPES,
	KERNEL_HUMAN_AUTHOR,
	humanIdentity,
	type AuthorizationIdentity,
} from "./models.ts";

export const DESTINATION_CHANGED = "destination_changed";
export const PAYLOAD_CHANGED = "payload_changed";
export const NOT_APPROVED = "not_approved";

/** One structured consequential action with concrete destination and payload. */
export interface StructuredConsequentialOperation {
	readonly actionType: string;
	readonly destination: string;
	readonly payload: string;
}

/** A bot-proposed operation awaiting human review. */
export interface OperationProposal {
	readonly proposalId: string;
	readonly operation: StructuredConsequentialOperation;
}

/** Human approval bound to exactly one reviewed operation. */
export interface ApprovedOperation {
	readonly approvalId: string;
	readonly operation: StructuredConsequentialOperation;
	readonly approver: AuthorizationIdentity;
}

/** Outcome of executing against an approved binding. */
export interface BoundExecutionResult {
	readonly executed: boolean;
	readonly reason: string | null;
	readonly completionEvidence: string | null;
	readonly requiresNewApproval: boolean;
}

function operationsEqual(left: StructuredConsequentialOperation, right: StructuredConsequentialOperation): boolean {
	return (
		left.actionType === right.actionType && left.destination === right.destination && left.payload === right.payload
	);
}

function notExecuted(reason: string): BoundExecutionResult {
	return { executed: false, reason, completionEvidence: null, requiresNewApproval: true };
}

/** Propose, approve, and execute one immutable consequential operation for one tenant. */
export class ApprovalBindingGate {
	private readonly tenantId: string;
	private readonly store: PolicyStore;
	private readonly ids: IdSource;
	private lastExecutionResult: BoundExecutionResult | null = null;

	constructor(tenantId: string, deps: { store: PolicyStore; ids: IdSource }) {
		this.tenantId = tenantId;
		this.store = deps.store;
		this.ids = deps.ids;
	}

	/** Return the most recent execution attempt. */
	get lastExecution(): BoundExecutionResult | null {
		return this.lastExecutionResult;
	}

	/** Record a bot proposal with concrete destination and payload. */
	async proposeStructuredOperation(
		actionType: string,
		destination: string,
		payload: string,
	): Promise<OperationProposal> {
		if (!CONSEQUENTIAL_ACTION_TYPES.has(actionType)) {
			throw new Error(`Action type ${JSON.stringify(actionType)} is not consequential.`);
		}
		const operation: StructuredConsequentialOperation = { actionType, destination, payload };
		const proposalId = this.ids.next();
		await this.store.createApproval({
			approvalId: proposalId,
			tenantId: this.tenantId,
			kind: "proposal",
			actionType,
			destination,
			payload,
			approverKind: null,
			approverId: null,
		});
		return { proposalId, operation };
	}

	/** Bind human approval to the reviewed proposal. */
	async approveOperation(
		proposal: OperationProposal,
		approver: AuthorizationIdentity | null = null,
	): Promise<ApprovedOperation> {
		const stored = await this.store.getApproval(this.tenantId, proposal.proposalId);
		if (stored === null || stored.kind !== "proposal" || !operationsEqual(stored, proposal.operation)) {
			throw new Error(`Unknown or stale proposal ${JSON.stringify(proposal.proposalId)}.`);
		}
		const approvalId = this.ids.next();
		const resolvedApprover = approver ?? humanIdentity(KERNEL_HUMAN_AUTHOR);
		try {
			await this.store.createApproval({
				approvalId,
				tenantId: this.tenantId,
				kind: "approval",
				actionType: stored.actionType,
				destination: stored.destination,
				payload: stored.payload,
				approverKind: resolvedApprover.kind,
				approverId: resolvedApprover.actorId,
			});
		} catch (error) {
			if (error instanceof PolicyItemAlreadyExistsError) {
				throw new Error(`Approval ${JSON.stringify(approvalId)} already exists.`);
			}
			throw error;
		}
		return {
			approvalId,
			operation: { actionType: stored.actionType, destination: stored.destination, payload: stored.payload },
			approver: resolvedApprover,
		};
	}

	/** Execute only when the attempt matches the approved binding. */
	async executeApprovedOperation(
		approval: ApprovedOperation,
		attempted: StructuredConsequentialOperation,
		completionEvidence: string,
	): Promise<BoundExecutionResult> {
		const stored = await this.store.getApproval(this.tenantId, approval.approvalId);
		const bound: StructuredConsequentialOperation | null =
			stored === null || stored.kind !== "approval"
				? null
				: { actionType: stored.actionType, destination: stored.destination, payload: stored.payload };
		if (bound === null || !operationsEqual(bound, approval.operation)) {
			return this.remember(notExecuted(NOT_APPROVED));
		}
		if (attempted.actionType !== bound.actionType) {
			return this.remember(notExecuted(NOT_APPROVED));
		}
		if (attempted.destination !== bound.destination) {
			return this.remember(notExecuted(DESTINATION_CHANGED));
		}
		if (attempted.payload !== bound.payload) {
			return this.remember(notExecuted(PAYLOAD_CHANGED));
		}
		return this.remember({
			executed: true,
			reason: null,
			completionEvidence,
			requiresNewApproval: false,
		});
	}

	private remember(result: BoundExecutionResult): BoundExecutionResult {
		this.lastExecutionResult = result;
		return result;
	}
}
