import {
	OrgAccessDeniedError,
	PrincipalHttpError,
	parseBearerToken,
	verifyOrgAccess,
	type Principal,
	type PrincipalDirectory,
} from "./principal.ts";

/** Map one bearer token to a worker principal for `tenantId`. */
export async function resolveWorkerPrincipalFromToken(
	directory: PrincipalDirectory,
	tenantId: string,
	token: string,
): Promise<Principal> {
	const workerId = await directory.verifyWorkerToken(tenantId, token);
	if (workerId === null) {
		throw new PrincipalHttpError(403, "invalid worker credential");
	}
	return {
		kind: "worker",
		tenantId,
		userId: null,
		workerId,
		organizationStatus: null,
		role: null,
	};
}

/** Require a valid worker bearer credential for one org-scoped worker route. */
export async function enforceWorkerPrincipal(
	request: Request,
	tenantId: string,
	directory: PrincipalDirectory,
): Promise<Principal> {
	const token = parseBearerToken(request.headers.get("Authorization"));
	if (token === null) {
		throw new PrincipalHttpError(403, "worker credential required");
	}
	const principal = await resolveWorkerPrincipalFromToken(directory, tenantId, token);
	await requireEnabledOrganization(principal, tenantId, directory);
	return principal;
}

async function requireEnabledOrganization(principal: Principal, tenantId: string, directory: PrincipalDirectory): Promise<void> {
	try {
		await verifyOrgAccess(principal, tenantId, { directory, requireEnabledMember: true });
	} catch (error) {
		if (error instanceof OrgAccessDeniedError) {
			throw new PrincipalHttpError(403, error.message);
		}
		throw error;
	}
}

/**
 * The worker principal of a container owner whose signed token the front door already verified: the owner id is the
 * worker id, and the organization must still be enabled exactly as for a worker bearer credential.
 *
 * @param tenantId The organization of the path.
 * @param ownerId The owner id the token names.
 * @param directory Reads the organization's standing.
 * @returns The worker principal.
 */
export async function enforceOwnerPrincipal(tenantId: string, ownerId: string, directory: PrincipalDirectory): Promise<Principal> {
	const principal: Principal = { kind: "worker", tenantId, userId: null, workerId: ownerId, organizationStatus: null, role: null };
	await requireEnabledOrganization(principal, tenantId, directory);
	return principal;
}
