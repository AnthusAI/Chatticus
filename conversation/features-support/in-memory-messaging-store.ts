import type { Identity, Invitation, Membership, Organization, OrganizationStatus } from "../src/domain/organizations.ts";
import { OrganizationCreationRateLimitedError } from "../src/http/errors.ts";
import type { MessagingStore } from "../src/store/messaging-store.ts";

/** In-memory messaging store for scenarios that do not need DynamoDB. */
export class InMemoryMessagingStore implements MessagingStore {
	private readonly identities = new Map<string, Identity>();
	private readonly organizations = new Map<string, Organization>();
	private readonly memberships = new Map<string, Map<string, Membership>>();
	private readonly invitations = new Map<string, Invitation>();
	private readonly creationAttempts = new Map<string, Date[]>();

	async getIdentityByEmail(email: string): Promise<Identity | null> {
		return this.identities.get(email) ?? null;
	}

	async putIdentity(identity: Identity): Promise<void> {
		this.identities.set(identity.email, identity);
	}

	async getOrganization(tenantId: string): Promise<Organization | null> {
		return this.organizations.get(tenantId) ?? null;
	}

	async putOrganization(organization: Organization): Promise<void> {
		this.organizations.set(organization.tenantId, organization);
	}

	async getMembership(tenantId: string, userId: string): Promise<Membership | null> {
		return this.memberships.get(tenantId)?.get(userId) ?? null;
	}

	async putMembership(membership: Membership): Promise<void> {
		let tenantMemberships = this.memberships.get(membership.tenantId);
		if (tenantMemberships === undefined) {
			tenantMemberships = new Map();
			this.memberships.set(membership.tenantId, tenantMemberships);
		}
		tenantMemberships.set(membership.userId, membership);
	}

	async listMemberships(tenantId: string): Promise<Membership[]> {
		return Array.from(this.memberships.get(tenantId)?.values() ?? []);
	}

	async getInvitation(invitationId: string): Promise<Invitation | null> {
		return this.invitations.get(invitationId) ?? null;
	}

	async putInvitation(invitation: Invitation): Promise<void> {
		this.invitations.set(invitation.invitationId, invitation);
	}

	async listOrganizationsForUser(userId: string): Promise<Organization[]> {
		const result: Organization[] = [];
		for (const organization of this.organizations.values()) {
			if (this.memberships.get(organization.tenantId)?.has(userId)) {
				result.push(organization);
			}
		}
		return result;
	}

	async listOrganizationsByStatus(status: OrganizationStatus): Promise<Organization[]> {
		return Array.from(this.organizations.values())
			.filter((organization) => organization.status === status)
			.sort((left, right) => (left.tenantId < right.tenantId ? -1 : left.tenantId > right.tenantId ? 1 : 0));
	}

	async recordOrganizationCreationAttempt(
		userId: string,
		now: Date,
		limit: number,
		windowMilliseconds: number,
	): Promise<void> {
		const cutoff = now.getTime() - windowMilliseconds;
		const attempts = (this.creationAttempts.get(userId) ?? []).filter((timestamp) => timestamp.getTime() > cutoff);
		attempts.push(now);
		this.creationAttempts.set(userId, attempts);
		if (attempts.length > limit) {
			throw new OrganizationCreationRateLimitedError(
				`User ${JSON.stringify(userId)} exceeded the organization creation rate limit of ${limit} attempts per 1:00:00.`,
			);
		}
	}

	async listPendingInvitationsForEmail(email: string): Promise<Invitation[]> {
		return Array.from(this.invitations.values()).filter(
			(invitation) => invitation.email === email && invitation.status === "pending",
		);
	}
}
