import { verifyWorkerToken } from "../domain/workers.ts";
import { OrganizationNotFoundError } from "../http/errors.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import type { Membership, OrganizationStatus, PrincipalDirectory } from "./principal.ts";

/** Principal directory backed by the messaging store. */
export class StorePrincipalDirectory implements PrincipalDirectory {
	private readonly store: MessagingStore;

	constructor(store: MessagingStore) {
		this.store = store;
	}

	async getIdentityByEmail(email: string): Promise<{ userId: string } | null> {
		const identity = await this.store.getIdentityByEmail(email);
		if (identity === null) {
			return null;
		}
		return { userId: identity.userId };
	}

	async getMembership(tenantId: string, userId: string): Promise<Membership | null> {
		return this.store.getMembership(tenantId, userId);
	}

	async getOrganizationStatus(tenantId: string): Promise<OrganizationStatus> {
		const organization = await this.store.getOrganization(tenantId);
		if (organization === null) {
			throw new OrganizationNotFoundError(`Organization ${JSON.stringify(tenantId)} is unknown.`);
		}
		return organization.status;
	}

	async verifyWorkerToken(tenantId: string, token: string): Promise<string | null> {
		return verifyWorkerToken(tenantId, token, { store: this.store });
	}
}
