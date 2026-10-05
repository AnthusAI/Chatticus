import type { Identity, Invitation, Organization } from "./organizations.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import type { Clock } from "../storage/storage-support.ts";
import {
	DuplicateMembershipError,
	InvitationEmailMismatchError,
	InvitationExpiredError,
	InvitationNotFoundError,
	InvitationNotPendingError,
	OrganizationNotEnabledError,
	OrganizationNotFoundError,
} from "../http/errors.ts";

/** Invitations kernel for accepting and reconciling pending invitations. */
export interface InvitationsKernel {
	reconcilePendingInvitations(
		acceptor: Identity,
		deps: { store: MessagingStore; clock: Clock },
	): Promise<void>;
}

/** Implementation of the invitations kernel. */
export class InvitationsKernelImpl implements InvitationsKernel {
	async reconcilePendingInvitations(
		acceptor: Identity,
		deps: { store: MessagingStore; clock: Clock },
	): Promise<void> {
		const invitations = await deps.store.listPendingInvitationsForEmail(acceptor.email);
		const now = deps.clock.now();

		for (const invitation of invitations) {
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
				const existing = await deps.store.getMembership(invitation.tenantId, acceptor.userId);
				if (existing !== null) {
					continue;
				}

				const membership = {
					tenantId: invitation.tenantId,
					userId: acceptor.userId,
					role: invitation.role,
					joinedAt: now,
				};

				await deps.store.putMembership(membership);
				const accepted: Invitation = {
					...invitation,
					status: "accepted",
				};
				await deps.store.putInvitation(accepted);
			} catch {
				continue;
			}
		}
	}
}
