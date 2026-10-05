import type { Identity, Organization, Membership, Invitation } from "../domain/organizations.ts";

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
	listPendingInvitationsForEmail(email: string): Promise<Invitation[]>;
}
