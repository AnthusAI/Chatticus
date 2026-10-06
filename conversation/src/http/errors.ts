/**
 * Domain errors for the Chatticus control plane.
 * Errors are thrown during request handling and mapped to HTTP status codes.
 */

/**
 * Base class for all domain errors.
 * Has a code for programmatic error categorization and a message for the client.
 */
export class DomainError extends Error {
	code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
		this.name = this.constructor.name;
	}
}

export class WorkerTenantMismatchError extends DomainError {
	constructor(message: string) {
		super("worker_tenant_mismatch", message);
	}
}

export class DuplicateBotNameError extends DomainError {
	constructor(message: string) {
		super("duplicate_bot_name", message);
	}
}

export class SnapshotRequiredError extends DomainError {
	constructor(message: string) {
		super("snapshot_required", message);
	}
}

export class ComputerDirtyError extends DomainError {
	constructor(message: string) {
		super("computer_dirty", message);
	}
}

export class WorkerDoesNotHostComputerError extends DomainError {
	constructor(message: string) {
		super("worker_does_not_host_computer", message);
	}
}

export class ComputerNotHydratedError extends DomainError {
	constructor(message: string) {
		super("computer_not_hydrated", message);
	}
}

export class WorkspaceHostOnlyError extends DomainError {
	constructor(message: string) {
		super("workspace_host_only", message);
	}
}

export class ChannelNotFoundError extends DomainError {
	constructor(message: string) {
		super("channel_not_found", message);
	}
}

export class ChannelTenantMismatchError extends DomainError {
	constructor(message: string) {
		super("channel_tenant_mismatch", message);
	}
}

export class InvalidChannelIdentityError extends DomainError {
	constructor(message: string) {
		super("invalid_channel_identity", message);
	}
}

export class ActorNotInChannelError extends DomainError {
	constructor(message: string) {
		super("actor_not_in_channel", message);
	}
}

export class TurnNotFoundError extends DomainError {
	constructor(message: string) {
		super("turn_not_found", message);
	}
}

export class TurnAccessDeniedError extends DomainError {
	constructor(message: string) {
		super("turn_access_denied", message);
	}
}

export class StaleAttemptError extends DomainError {
	constructor(message: string) {
		super("stale_attempt", message);
	}
}

export class TurnClaimDeniedError extends DomainError {
	constructor(message: string) {
		super("turn_claim_denied", message);
	}
}

export class TurnReconcilingError extends DomainError {
	constructor(message: string) {
		super("turn_reconciling", message);
	}
}

export class TurnTerminalError extends DomainError {
	constructor(message: string) {
		super("turn_terminal", message);
	}
}

export class TurnNotWaitingError extends DomainError {
	constructor(message: string) {
		super("turn_not_waiting", message);
	}
}

export class ComputerNotReadyError extends DomainError {
	constructor(message: string) {
		super("computer_not_ready", message);
	}
}

export class ComputerlessCannotExecuteComputerJob extends DomainError {
	constructor(message: string) {
		super("computerless_cannot_execute_computer_job", message);
	}
}

export class ComputerWorkerRequiresComputerCapability extends DomainError {
	constructor(message: string) {
		super("computer_worker_requires_computer_capability", message);
	}
}

export class OrganizationComputerProvisioningError extends DomainError {
	constructor(message: string) {
		super("organization_computer_provisioning", message);
	}
}

export class ComputerWorkerHostNotReady extends DomainError {
	constructor(message: string) {
		super("computer_worker_host_not_ready", message);
	}
}

export class TaskNotFoundError extends DomainError {
	constructor(message: string) {
		super("task_not_found", message);
	}
}

export class TaskAccessDeniedError extends DomainError {
	constructor(message: string) {
		super("task_access_denied", message);
	}
}

export class TaskEvidenceRequiredError extends DomainError {
	constructor(message: string) {
		super("task_evidence_required", message);
	}
}

export class TaskCloseReasonRequiredError extends DomainError {
	constructor(message: string) {
		super("task_close_reason_required", message);
	}
}

export class IdentityNotFoundError extends DomainError {
	constructor(message: string) {
		super("identity_not_found", message);
	}
}

export class IdentityUserIdMismatchError extends DomainError {
	constructor(message: string) {
		super("identity_user_id_mismatch", message);
	}
}

export class OrganizationSeedConflictError extends DomainError {
	constructor(message: string) {
		super("organization_seed_conflict", message);
	}
}

export class MemberStandingRequiredError extends DomainError {
	constructor(message: string) {
		super("member_standing_required", message);
	}
}

export class GrantExceedsMemberStandingError extends DomainError {
	constructor(message: string) {
		super("grant_exceeds_member_standing", message);
	}
}

export class OrganizationNotFoundError extends DomainError {
	constructor(message: string) {
		super("organization_not_found", message);
	}
}

export class OrganizationNotEnabledError extends DomainError {
	constructor(message: string) {
		super("organization_not_enabled", message);
	}
}

export class OrganizationStatusTransitionError extends DomainError {
	constructor(message: string) {
		super("organization_status_transition", message);
	}
}

export class InvitationNotFoundError extends DomainError {
	constructor(message: string) {
		super("invitation_not_found", message);
	}
}

export class InvitationEmailMismatchError extends DomainError {
	constructor(message: string) {
		super("invitation_email_mismatch", message);
	}
}

export class DuplicateMembershipError extends DomainError {
	constructor(message: string) {
		super("duplicate_membership", message);
	}
}

export class MembershipNotFoundError extends DomainError {
	constructor(message: string) {
		super("membership_not_found", message);
	}
}

export class NotOrganizationOwnerError extends DomainError {
	constructor(message: string) {
		super("not_organization_owner", message);
	}
}

export class InvitationExpiredError extends DomainError {
	constructor(message: string) {
		super("invitation_expired", message);
	}
}

export class InvitationNotPendingError extends DomainError {
	constructor(message: string) {
		super("invitation_not_pending", message);
	}
}

export class LastOwnerCannotBeDemotedError extends DomainError {
	constructor(message: string) {
		super("last_owner_cannot_be_demoted", message);
	}
}

export class OrganizationOwnerCapError extends DomainError {
	constructor(message: string) {
		super("organization_owner_cap", message);
	}
}

export class OrganizationCreationRateLimitedError extends DomainError {
	constructor(message: string) {
		super("organization_creation_rate_limited", message);
	}
}

export class OrganizationNameTooLongError extends DomainError {
	constructor(message: string) {
		super("organization_name_too_long", message);
	}
}

export class WaitlistRateLimitedError extends DomainError {
	constructor(message: string) {
		super("waitlist_rate_limited", message);
	}
}

export class CapabilitySinkDenied extends DomainError {
	constructor(message: string) {
		super("capability_sink_denied", message);
	}
}

/**
 * Map a DomainError to its HTTP status code.
 * Mirrors the Python _status_for_error function.
 */
export function statusFor(error: unknown): number {
	if (error instanceof CapabilitySinkDenied) {
		return 403;
	}
	if (error instanceof ChannelTenantMismatchError ||
		error instanceof TurnAccessDeniedError ||
		error instanceof ActorNotInChannelError) {
		return 403;
	}
	if (error instanceof TaskAccessDeniedError) {
		return 403;
	}
	if (error instanceof MemberStandingRequiredError || error instanceof GrantExceedsMemberStandingError) {
		return 403;
	}
	if (error instanceof TaskNotFoundError) {
		return 404;
	}
	if (error instanceof StaleAttemptError ||
		error instanceof TurnClaimDeniedError) {
		return 409;
	}
	if (error instanceof TurnReconcilingError ||
		error instanceof TurnTerminalError ||
		error instanceof TurnNotWaitingError ||
		error instanceof ComputerNotReadyError) {
		return 409;
	}
	if (error instanceof ChannelNotFoundError ||
		error instanceof TurnNotFoundError) {
		return 404;
	}
	if (error instanceof OrganizationNotFoundError) {
		return 404;
	}
	if (error instanceof OrganizationOwnerCapError) {
		return 409;
	}
	if (error instanceof OrganizationStatusTransitionError) {
		return 409;
	}
	if (error instanceof OrganizationCreationRateLimitedError) {
		return 429;
	}
	if (error instanceof WaitlistRateLimitedError) {
		return 429;
	}
	if (error instanceof OrganizationNameTooLongError) {
		return 400;
	}
	if (error instanceof NotOrganizationOwnerError) {
		return 403;
	}
	return 400;
}
