import type { Membership, MemberRole } from "./organizations.ts";
import type { MessagingStore } from "../store/messaging-store.ts";

/** Membership-related functions. */
export interface MembershipKernel {
	getMembership(tenantId: string, userId: string, deps: { store: MessagingStore }): Promise<Membership | null>;
	listMemberships(tenantId: string, deps: { store: MessagingStore }): Promise<Membership[]>;
}

/** Implementation of the membership kernel. */
export class MembershipKernelImpl implements MembershipKernel {
	async getMembership(tenantId: string, userId: string, deps: { store: MessagingStore }): Promise<Membership | null> {
		return deps.store.getMembership(tenantId, userId);
	}

	async listMemberships(tenantId: string, deps: { store: MessagingStore }): Promise<Membership[]> {
		return deps.store.listMemberships(tenantId);
	}
}
