import type { Clock } from "../storage/storage-support.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import {
	DuplicateMembershipError,
	InvitationEmailMismatchError,
	InvitationExpiredError,
	InvitationNotFoundError,
	InvitationNotPendingError,
	OrganizationNotEnabledError,
	OrganizationNotFoundError,
	OrganizationsKernelImpl,
} from "./organizations.ts";
import type { Identity } from "./organizations.ts";

/** Invitations kernel for reconciling pending invitations at sign-in. */
export interface InvitationsKernel {
	reconcilePendingInvitations(acceptor: Identity, deps: { store: MessagingStore; clock: Clock }): Promise<void>;
}

const SKIPPABLE_ACCEPT_ERRORS = [
	DuplicateMembershipError,
	InvitationEmailMismatchError,
	InvitationExpiredError,
	InvitationNotFoundError,
	InvitationNotPendingError,
	OrganizationNotEnabledError,
	OrganizationNotFoundError,
];

/** Implementation of the invitations kernel. */
export class InvitationsKernelImpl implements InvitationsKernel {
	/**
	 * Accept eligible pending invitations for one verified email. Expired
	 * invitations and invitations to non-enabled organizations are skipped
	 * without failing the caller.
	 */
	async reconcilePendingInvitations(
		acceptor: Identity,
		deps: { store: MessagingStore; clock: Clock },
	): Promise<void> {
		const organizations = new OrganizationsKernelImpl();
		const now = deps.clock.now();
		for (const invitation of await deps.store.listPendingInvitationsForEmail(acceptor.email)) {
			if (invitation.expiresAt <= now) {
				continue;
			}
			const organization = await deps.store.getOrganization(invitation.tenantId);
			if (organization === null) {
				continue;
			}
			if (organization.status !== "enabled") {
				continue;
			}
			try {
				await organizations.acceptInvitation(invitation.invitationId, acceptor, deps);
			} catch (error) {
				if (SKIPPABLE_ACCEPT_ERRORS.some((skippable) => error instanceof skippable)) {
					continue;
				}
				throw error;
			}
		}
	}
}
