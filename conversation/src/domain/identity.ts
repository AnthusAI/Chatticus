import type { Identity } from "./organizations.ts";
import type { MessagingStore } from "../store/messaging-store.ts";

/** Identity-related functions. */
export interface IdentityKernel {
	getIdentityByEmail(email: string, deps: { store: MessagingStore }): Promise<Identity | null>;
}

/** Implementation of the identity kernel. */
export class IdentityKernelImpl implements IdentityKernel {
	async getIdentityByEmail(email: string, deps: { store: MessagingStore }): Promise<Identity | null> {
		return deps.store.getIdentityByEmail(email);
	}
}
