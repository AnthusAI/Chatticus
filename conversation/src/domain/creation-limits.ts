import { OrganizationNameTooLongError, OrganizationOwnerCapError } from "../http/errors.ts";
import type { Clock } from "../storage/storage-support.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import type { Identity, IdSource, Organization } from "./organizations.ts";
import { OrganizationsKernelImpl } from "./organizations.ts";

export const ORGANIZATION_NAME_MAX_LENGTH = 128;
export const ORGANIZATION_CREATION_RATE_LIMIT = 5;
export const ORGANIZATION_CREATION_RATE_WINDOW_HOURS = 1;
export const ORGANIZATION_CREATION_RATE_WINDOW_MILLISECONDS =
	ORGANIZATION_CREATION_RATE_WINDOW_HOURS * 60 * 60 * 1000;

/**
 * Validate organization name and return stripped version or throw when too long.
 */
export function validateOrganizationName(name: string): string {
	const stripped = name.trim();
	if (stripped.length > ORGANIZATION_NAME_MAX_LENGTH) {
		throw new OrganizationNameTooLongError(
			`Organization name must be at most ${ORGANIZATION_NAME_MAX_LENGTH} characters after trimming whitespace.`,
		);
	}
	return stripped;
}

/**
 * Create a pending organization on the product path: record the creation
 * attempt against the rate limit, validate the name, refuse a second owned
 * organization, then create. Operators lift the cap with adminCreateOrganization.
 */
export async function createOrganizationUnderCaps(
	owner: Identity,
	name: string,
	deps: { store: MessagingStore; clock: Clock; ids: IdSource; rateLimit: number },
): Promise<Organization> {
	await deps.store.recordOrganizationCreationAttempt(
		owner.userId,
		deps.clock.now(),
		deps.rateLimit,
		ORGANIZATION_CREATION_RATE_WINDOW_MILLISECONDS,
	);
	const strippedName = validateOrganizationName(name);
	const kernel = new OrganizationsKernelImpl();
	const organizations = await kernel.listOrganizationsForUser(owner.userId, { store: deps.store });
	if (organizations.some((organization) => organization.ownerUserId === owner.userId)) {
		throw new OrganizationOwnerCapError(`User ${JSON.stringify(owner.userId)} already owns an organization.`);
	}
	return kernel.createOrganization(owner, strippedName, deps);
}
