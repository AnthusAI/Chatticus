import type { Identity, Organization, Membership, Invitation, OrganizationStatus } from "../domain/organizations.ts";

/** MessagingStore provides storage operations for organizations, identities, and memberships. */
export interface MessagingStore {
	getIdentityByEmail(email: string): Promise<Identity | null>;
	putIdentity(identity: Identity): Promise<void>;
	getOrganization(tenantId: string): Promise<Organization | null>;
	putOrganization(organization: Organization): Promise<void>;
	getMembership(tenantId: string, userId: string): Promise<Membership | null>;
	putMembership(membership: Membership): Promise<void>;
	listMemberships(tenantId: string): Promise<Membership[]>;
	getInvitation(invitationId: string): Promise<Invitation | null>;
	putInvitation(invitation: Invitation): Promise<void>;
	listOrganizationsForUser(userId: string): Promise<Organization[]>;
	listOrganizationsByStatus(status: OrganizationStatus): Promise<Organization[]>;
	/**
	 * Record one organization creation attempt for the user and throw
	 * OrganizationCreationRateLimitedError when the attempts inside the window
	 * exceed the limit.
	 */
	recordOrganizationCreationAttempt(
		userId: string,
		now: Date,
		limit: number,
		windowMilliseconds: number,
	): Promise<void>;
	listPendingInvitationsForEmail(email: string): Promise<Invitation[]>;
}
