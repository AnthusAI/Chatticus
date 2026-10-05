import type { Membership, OrganizationStatus, PrincipalDirectory } from "../../src/auth/principal.ts";

/** In-memory control-plane reads for principal scenarios. */
export class FakePrincipalDirectory implements PrincipalDirectory {
	private readonly identitiesByEmail = new Map<string, { userId: string }>();
	private readonly memberships = new Map<string, Membership>();
	private readonly statuses = new Map<string, OrganizationStatus>();

	seedOrganization(tenantId: string, ownerEmail: string, status: OrganizationStatus): void {
		const userId = `user-${ownerEmail}`;
		this.identitiesByEmail.set(ownerEmail, { userId });
		this.memberships.set(`${tenantId}:${userId}`, { tenantId, userId, role: "owner" });
		this.statuses.set(tenantId, status);
	}

	async getIdentityByEmail(email: string): Promise<{ userId: string } | null> {
		return this.identitiesByEmail.get(email) ?? null;
	}

	async getMembership(tenantId: string, userId: string): Promise<Membership | null> {
		return this.memberships.get(`${tenantId}:${userId}`) ?? null;
	}

	async getOrganizationStatus(tenantId: string): Promise<OrganizationStatus> {
		const status = this.statuses.get(tenantId);
		if (status === undefined) {
			throw new Error(`Unknown organization ${tenantId}`);
		}
		return status;
	}

	async verifyWorkerToken(): Promise<string | null> {
		return null;
	}
}
