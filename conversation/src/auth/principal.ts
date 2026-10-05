import { CognitoTokenError, type IdTokenVerifier } from "./cognito.ts";
import { MembershipCache } from "./membership-cache.ts";

/** Role of one member inside an organization. */
export type Role = "owner" | "member";

/** Lifecycle of one organization. */
export type OrganizationStatus = "pending" | "enabled" | "suspended";

/** Kind of authenticated caller. */
export type PrincipalKind = "user" | "operator" | "worker" | "integration";

/** Resolved caller for one HTTP request. */
export type Principal = {
	kind: PrincipalKind;
	tenantId: string;
	userId: string | null;
	workerId: string | null;
	organizationStatus: OrganizationStatus | null;
	role: Role | null;
};

/** The user id or email is unknown. */
export class IdentityNotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IdentityNotFoundError";
	}
}

/** The user is not a member of the organization. */
export class MembershipNotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MembershipNotFoundError";
	}
}

/** Raised when a principal may not access the organization in the path. */
export class OrgAccessDeniedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OrgAccessDeniedError";
	}
}

/** Raised when the principal kind does not match the route audience. */
export class PrincipalAudienceDeniedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PrincipalAudienceDeniedError";
	}
}

/** An HTTP-shaped refusal raised while resolving a principal. */
export class PrincipalHttpError extends Error {
	readonly status: number;
	readonly detail: string;

	constructor(status: number, detail: string) {
		super(detail);
		this.status = status;
		this.detail = detail;
		this.name = "PrincipalHttpError";
	}
}

/** One organization membership row. */
export type Membership = {
	tenantId: string;
	userId: string;
	role: Role;
};

/** Reads that principal resolution needs from the control plane. */
export type PrincipalDirectory = {
	getIdentityByEmail(email: string): Promise<{ userId: string } | null>;
	getMembership(tenantId: string, userId: string): Promise<Membership | null>;
	getOrganizationStatus(tenantId: string): Promise<OrganizationStatus>;
	verifyWorkerToken(tenantId: string, token: string): Promise<string | null>;
};

/** Exchanges an integration-test bearer token for a principal, or returns null when it is not one. */
export type IntegrationTestAuthenticator = (
	tenantId: string,
	token: string,
) => Promise<Principal | null>;

/** Everything `resolvePrincipal` depends on. */
export type PrincipalDependencies = {
	verifier: IdTokenVerifier;
	directory: PrincipalDirectory;
	membershipCache: MembershipCache<CachedMembership>;
	requireEnabledMember: boolean;
	integrationTestAuthenticator?: IntegrationTestAuthenticator;
};

/** Membership facts cached for the warm life of the process. */
export type CachedMembership = {
	membership: Membership;
	organizationStatus: OrganizationStatus;
	role: Role;
};

const orgPathPattern = /^\/orgs\/([^/]+)(?:\/|$)/;

/** Extract the bearer token from an Authorization header value. */
export function parseBearerToken(authorization: string | null): string | null {
	if (authorization === null) {
		return null;
	}
	const separatorIndex = authorization.indexOf(" ");
	const scheme = separatorIndex === -1 ? authorization : authorization.slice(0, separatorIndex);
	if (scheme.toLowerCase() !== "bearer") {
		return null;
	}
	const token = separatorIndex === -1 ? "" : authorization.slice(separatorIndex + 1).trim();
	return token === "" ? null : token;
}

/** Return the tenant id embedded in one /orgs/{tenantId}/... path. */
export function orgTenantIdFromPath(path: string): string | null {
	const match = orgPathPattern.exec(path);
	return match === null ? null : (match[1] ?? null);
}

/**
 * Map one Cognito id token to a user principal for `tenantId`. Identity is
 * keyed on the verified email, never the Cognito sub; organization status and
 * role come from membership rows, not token claims.
 */
export async function resolveUserPrincipalFromToken(
	dependencies: PrincipalDependencies,
	tenantId: string,
	token: string,
): Promise<Principal> {
	const claims = await dependencies.verifier.verifyIdToken(token);
	const identity = await dependencies.directory.getIdentityByEmail(claims.email);
	if (identity === null) {
		throw new IdentityNotFoundError(`No identity is registered for email '${claims.email}'.`);
	}
	let cached = dependencies.membershipCache.get(tenantId, identity.userId);
	if (cached === undefined) {
		const membership = await dependencies.directory.getMembership(tenantId, identity.userId);
		if (membership === null) {
			throw new MembershipNotFoundError(
				`User '${identity.userId}' is not a member of organization '${tenantId}'.`,
			);
		}
		const organizationStatus = await dependencies.directory.getOrganizationStatus(tenantId);
		cached = { membership, organizationStatus, role: membership.role };
		dependencies.membershipCache.set(tenantId, identity.userId, cached);
	}
	return {
		kind: "user",
		tenantId,
		userId: identity.userId,
		workerId: null,
		organizationStatus: cached.organizationStatus,
		role: cached.role,
	};
}

/** Check that `principal` may access `pathTenantId`; only enabled members pass unless waitlist-safe. */
export async function verifyOrgAccess(
	principal: Principal,
	pathTenantId: string,
	dependencies: Pick<PrincipalDependencies, "directory" | "requireEnabledMember">,
): Promise<void> {
	if (principal.kind === "worker") {
		if (principal.tenantId !== pathTenantId) {
			throw new OrgAccessDeniedError(
				`Worker '${principal.workerId}' is not registered for organization '${pathTenantId}'.`,
			);
		}
		return;
	}
	if (principal.userId === null) {
		throw new OrgAccessDeniedError("User principal is missing user_id.");
	}
	const membership = await dependencies.directory.getMembership(pathTenantId, principal.userId);
	if (membership === null) {
		throw new OrgAccessDeniedError(
			`User '${principal.userId}' is not a member of organization '${pathTenantId}'.`,
		);
	}
	const status = await dependencies.directory.getOrganizationStatus(pathTenantId);
	if (dependencies.requireEnabledMember && status !== "enabled") {
		throw new OrgAccessDeniedError(
			`Organization '${pathTenantId}' has status '${status}'; enabled membership is required.`,
		);
	}
}

function forbidden(detail: string): PrincipalHttpError {
	return new PrincipalHttpError(403, detail);
}

/**
 * Resolve the user principal of an org-scoped request. Order: bearer present,
 * worker token refused, integration-test token, Cognito verification,
 * identity by email, membership for the path tenant, organization status.
 * Every refusal is a 403, as in the Python seam.
 */
export async function resolvePrincipal(
	request: Request,
	dependencies: PrincipalDependencies,
): Promise<Principal> {
	const tenantId = orgTenantIdFromPath(new URL(request.url).pathname);
	if (tenantId === null) {
		throw forbidden("user credential required");
	}
	const token = parseBearerToken(request.headers.get("Authorization"));
	if (token === null) {
		throw forbidden("user credential required");
	}
	if ((await dependencies.directory.verifyWorkerToken(tenantId, token)) !== null) {
		throw forbidden("worker credential not accepted on this route");
	}
	let principal: Principal | null = null;
	if (dependencies.integrationTestAuthenticator !== undefined) {
		principal = await dependencies.integrationTestAuthenticator(tenantId, token);
	}
	try {
		if (principal === null) {
			principal = await resolveUserPrincipalFromToken(dependencies, tenantId, token);
		}
		await verifyOrgAccess(principal, tenantId, dependencies);
	} catch (error) {
		if (
			error instanceof CognitoTokenError ||
			error instanceof IdentityNotFoundError ||
			error instanceof MembershipNotFoundError ||
			error instanceof OrgAccessDeniedError ||
			error instanceof PrincipalAudienceDeniedError
		) {
			throw forbidden(error.message);
		}
		throw error;
	}
	return principal;
}
