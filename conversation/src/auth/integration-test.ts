import { createHmac, timingSafeEqual } from "node:crypto";
import { OrganizationsKernelImpl, normalizeEmail } from "../domain/organizations.ts";
import type { Clock, IdSource } from "../http/app.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import { STS_GET_CALLER_IDENTITY_QUERY, STS_GET_CALLER_IDENTITY_URL } from "../acceptance/sigv4.ts";
import {
	PrincipalHttpError,
	type IntegrationTestAuthenticator,
	type Principal,
	type PrincipalDirectory,
} from "./principal.ts";

/** Path of the development-only session exchange. */
export const INTEGRATION_TEST_SESSION_PATH = "/integration-test/session";
export const DEFAULT_INTEGRATION_TEST_TENANT_ID = "integration-test";
export const DEFAULT_INTEGRATION_TEST_USER_ID = "integration-test-runner";
export const DEFAULT_INTEGRATION_TEST_OWNER_EMAIL = "integration-test@chattic.us";
export const DEFAULT_TOKEN_TTL_SECONDS = 900;

const STS_FORWARD_HEADERS = new Set(["authorization", "x-amz-date", "x-amz-security-token"]);

/** Resolves the IAM role ARN of the caller of a session exchange, or null when the caller is not verified. */
export type CallerVerifier = (request: Request) => Promise<string | null>;

/** Reads one named configuration parameter (SSM in the deployed stack); an unset parameter is the empty string. */
export type ParameterReader = (name: string) => Promise<string>;

/** Runtime configuration for integration-test session exchange. */
export type IntegrationTestAuthConfig = {
	enabled: boolean;
	environment: string;
	allowedRoleArn: string;
	tenantId: string;
	userId: string;
	hmacSecret: Buffer;
	tokenTtlSeconds: number;
	callerVerifier: CallerVerifier | null;
	now: (() => Date) | null;
};

/** Return whether integration-test auth is enabled in this process. */
export function integrationTestEnabledFromEnvironment(environmentVariables: NodeJS.ProcessEnv = process.env): boolean {
	return environmentVariables["CHATTICUS_INTEGRATION_TEST_ENABLED"] === "true";
}

/** Derive the integration bearer signing secret from the invoke key. */
export function integrationTestHmacSecret(invokeKey: string): Buffer {
	return createHmac("sha256", "chatticus-integration-test-v1").update(invokeKey).digest();
}

/** Options for `loadIntegrationTestAuthConfig`. */
export type LoadIntegrationTestAuthConfigOptions = {
	environment: string;
	invokeKey: string;
	allowedRoleArn?: string;
	tenantId?: string;
	userId?: string;
	enabled?: boolean;
	callerVerifier?: CallerVerifier;
	now?: () => Date;
	environmentVariables?: NodeJS.ProcessEnv;
	readParameter?: ParameterReader;
};

async function firstConfigured(
	explicit: string | undefined,
	environmentValue: string | undefined,
	readParameter: ParameterReader,
	parameterName: string,
): Promise<string> {
	return (explicit || environmentValue || (await readParameter(parameterName)) || "").trim();
}

/** Build config when integration-test auth is active for `environment`, or null when it is not. */
export async function loadIntegrationTestAuthConfig(
	options: LoadIntegrationTestAuthConfigOptions,
): Promise<IntegrationTestAuthConfig | null> {
	const environmentVariables = options.environmentVariables ?? process.env;
	const resolvedEnabled = options.enabled ?? integrationTestEnabledFromEnvironment(environmentVariables);
	if (!resolvedEnabled || options.environment === "production") {
		return null;
	}
	const readParameter = options.readParameter ?? (async () => "");
	const prefix = `/chatticus/${options.environment}/integration-test`;
	const resolvedRole = await firstConfigured(
		options.allowedRoleArn,
		environmentVariables["CHATTICUS_INTEGRATION_TEST_ALLOWED_ROLE_ARN"],
		readParameter,
		`${prefix}/allowed-role-arn`,
	);
	const resolvedTenant =
		(await firstConfigured(
			options.tenantId,
			environmentVariables["CHATTICUS_INTEGRATION_TEST_TENANT_ID"],
			readParameter,
			`${prefix}/tenant-id`,
		)) || DEFAULT_INTEGRATION_TEST_TENANT_ID;
	const resolvedUser =
		(await firstConfigured(
			options.userId,
			environmentVariables["CHATTICUS_INTEGRATION_TEST_USER_ID"],
			readParameter,
			`${prefix}/user-id`,
		)) || DEFAULT_INTEGRATION_TEST_USER_ID;
	if (resolvedRole === "") {
		return null;
	}
	return {
		enabled: true,
		environment: options.environment,
		allowedRoleArn: resolvedRole,
		tenantId: resolvedTenant,
		userId: resolvedUser,
		hmacSecret: integrationTestHmacSecret(options.invokeKey),
		tokenTtlSeconds: DEFAULT_TOKEN_TTL_SECONDS,
		callerVerifier: options.callerVerifier ?? null,
		now: options.now ?? null,
	};
}

/** Verify SigV4 STS credentials by relaying GetCallerIdentity, returning the caller ARN or null. */
export async function relayStsGetCallerIdentityArn(request: Request): Promise<string | null> {
	const forwarded: Record<string, string> = {};
	request.headers.forEach((value, key) => {
		if (STS_FORWARD_HEADERS.has(key.toLowerCase())) {
			forwarded[key] = value;
		}
	});
	if (!Object.keys(forwarded).some((key) => key.toLowerCase() === "authorization")) {
		return null;
	}
	let response: Response;
	try {
		response = await fetch(`${STS_GET_CALLER_IDENTITY_URL}?${STS_GET_CALLER_IDENTITY_QUERY}`, {
			headers: forwarded,
			signal: AbortSignal.timeout(10000),
		});
	} catch {
		return null;
	}
	if (response.status !== 200) {
		return null;
	}
	const match = /<Arn>([^<]+)<\/Arn>/.exec(await response.text());
	if (match === null || match[1] === undefined || match[1].trim() === "") {
		return null;
	}
	return match[1].trim();
}

/** The partition, account and role name an IAM role ARN or an STS assumed-role ARN identifies; the path and session are ignored. */
export type RoleIdentity = { readonly partition: string; readonly account: string; readonly roleName: string };

const IAM_ROLE_ARN = /^arn:([a-z-]+):iam::([0-9]{12}):role\/(?:[^/]+\/)*([^/]+)$/;
const STS_ASSUMED_ROLE_ARN = /^arn:([a-z-]+):sts::([0-9]{12}):assumed-role\/([^/]+)\/[^/]+$/;

/** Parse an IAM role ARN (with or without a path) or an STS assumed-role ARN into the role it names, or null for anything else. */
export function roleIdentityOf(arn: string): RoleIdentity | null {
	const match = IAM_ROLE_ARN.exec(arn) ?? STS_ASSUMED_ROLE_ARN.exec(arn);
	if (match === null) {
		return null;
	}
	return { partition: match[1]!, account: match[2]!, roleName: match[3]! };
}

/**
 * Whether a caller ARN is the allowed role. Both sides are reduced to partition, account and role name, so an SSO role
 * (IAM ARN with the aws-reserved/sso.amazonaws.com/REGION/ path) matches the assumed-role ARN STS reports for its
 * sessions. An ARN that is neither shape matches only by exact equality.
 */
export function callerMatchesAllowedRole(callerArn: string, allowedRoleArn: string): boolean {
	const caller = roleIdentityOf(callerArn);
	const allowed = roleIdentityOf(allowedRoleArn);
	if (caller === null || allowed === null) {
		return callerArn === allowedRoleArn;
	}
	return (
		caller.partition === allowed.partition && caller.account === allowed.account && caller.roleName === allowed.roleName
	);
}

/** Return the verified caller role ARN or throw a 403. */
export async function verifySessionCaller(request: Request, config: IntegrationTestAuthConfig): Promise<string> {
	const verifier = config.callerVerifier ?? relayStsGetCallerIdentityArn;
	const roleArn = await verifier(request);
	if (roleArn === null) {
		throw new PrincipalHttpError(403, "integration test caller required");
	}
	if (!callerMatchesAllowedRole(roleArn, config.allowedRoleArn)) {
		throw new PrincipalHttpError(403, "integration test caller not allowed");
	}
	return roleArn;
}

function currentTime(config: IntegrationTestAuthConfig): Date {
	return config.now === null ? new Date() : config.now();
}

function tokenFor(config: IntegrationTestAuthConfig, issuedAt: Date, expiresAt: Date): string {
	const payload = {
		exp: Math.floor(expiresAt.getTime() / 1000),
		iat: Math.floor(issuedAt.getTime() / 1000),
		kind: "integration_test",
		tenant_id: config.tenantId,
		user_id: config.userId,
	};
	const payloadSegment = Buffer.from(JSON.stringify(payload)).toString("base64url");
	const signature = createHmac("sha256", config.hmacSecret).update(payloadSegment).digest("hex");
	return `${payloadSegment}.${signature}`;
}

/** Mint one short-lived integration bearer token. */
export function mintIntegrationTestToken(config: IntegrationTestAuthConfig): string {
	const issuedAt = currentTime(config);
	return tokenFor(config, issuedAt, new Date(issuedAt.getTime() + config.tokenTtlSeconds * 1000));
}

/** Mint an already-expired integration bearer token for negative tests. */
export function mintIntegrationTestTokenExpired(config: IntegrationTestAuthConfig): string {
	const issuedAt = new Date(currentTime(config).getTime() - 2 * 60 * 60 * 1000);
	return tokenFor(config, issuedAt, new Date(issuedAt.getTime() + 5 * 60 * 1000));
}

/** Split one integration bearer token into payload and signature segments. */
export function parseIntegrationTestToken(token: string): [string, string] | null {
	const separatorIndex = token.lastIndexOf(".");
	if (separatorIndex === -1) {
		return null;
	}
	return [token.slice(0, separatorIndex), token.slice(separatorIndex + 1)];
}

/** Return the token payload when `token` is a valid integration bearer, otherwise null. */
export function verifyIntegrationTestToken(
	token: string,
	config: IntegrationTestAuthConfig,
): Record<string, unknown> | null {
	const parsed = parseIntegrationTestToken(token);
	if (parsed === null) {
		return null;
	}
	const [payloadSegment, signature] = parsed;
	const expected = Buffer.from(createHmac("sha256", config.hmacSecret).update(payloadSegment).digest("hex"));
	const actual = Buffer.from(signature);
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		return null;
	}
	let payload: Record<string, unknown>;
	try {
		const decoded = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
		if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
			return null;
		}
		payload = decoded as Record<string, unknown>;
	} catch {
		return null;
	}
	if (payload["kind"] !== "integration_test") {
		return null;
	}
	if (payload["tenant_id"] !== config.tenantId) {
		return null;
	}
	if (payload["user_id"] !== config.userId) {
		return null;
	}
	const expiresAt = payload["exp"];
	if (typeof expiresAt !== "number" || !Number.isInteger(expiresAt)) {
		return null;
	}
	if (expiresAt <= Math.floor(currentTime(config).getTime() / 1000)) {
		return null;
	}
	return payload;
}

/** Return whether the session exchange route should be mounted. */
export function integrationTestSessionEnabled(config: IntegrationTestAuthConfig | null): boolean {
	return config !== null && config.enabled && config.environment !== "production";
}

/** Exchange one verified IAM caller for an integration bearer token. */
export async function createIntegrationTestSessionResponse(
	request: Request,
	config: IntegrationTestAuthConfig,
): Promise<{ token: string; token_type: string }> {
	await verifySessionCaller(request, config);
	return { token: mintIntegrationTestToken(config), token_type: "Bearer" };
}

/** Map one integration bearer token to a principal for `tenantId`. */
export async function resolveIntegrationTestPrincipal(
	directory: PrincipalDirectory,
	tenantId: string,
	token: string,
	config: IntegrationTestAuthConfig,
): Promise<Principal> {
	if (verifyIntegrationTestToken(token, config) === null) {
		throw new PrincipalHttpError(403, "invalid integration test credential");
	}
	if (tenantId !== config.tenantId) {
		throw new PrincipalHttpError(403, "integration test credential tenant mismatch");
	}
	const membership = await directory.getMembership(tenantId, config.userId);
	if (membership === null) {
		throw new PrincipalHttpError(
			403,
			`User '${config.userId}' is not a member of organization '${tenantId}'.`,
		);
	}
	return {
		kind: "integration",
		tenantId,
		userId: config.userId,
		workerId: null,
		organizationStatus: await directory.getOrganizationStatus(tenantId),
		role: membership.role,
	};
}

/** Build the authenticator `resolvePrincipal` consults before Cognito: null for anything that is not a valid integration bearer. */
export function integrationTestAuthenticator(
	directory: PrincipalDirectory,
	config: IntegrationTestAuthConfig,
): IntegrationTestAuthenticator {
	return async (tenantId, token) => {
		if (verifyIntegrationTestToken(token, config) === null) {
			return null;
		}
		return resolveIntegrationTestPrincipal(directory, tenantId, token, config);
	};
}

/** Seed one enabled organization for the dedicated integration-test user. */
export async function seedIntegrationTestOrganization(
	deps: { store: MessagingStore; clock: Clock; ids: IdSource },
	options: { tenantId?: string; userId?: string; ownerEmail?: string } = {},
): Promise<void> {
	const tenantId = options.tenantId ?? DEFAULT_INTEGRATION_TEST_TENANT_ID;
	const userId = options.userId ?? DEFAULT_INTEGRATION_TEST_USER_ID;
	const ownerEmail = options.ownerEmail ?? DEFAULT_INTEGRATION_TEST_OWNER_EMAIL;
	const normalized = normalizeEmail(ownerEmail);
	const existing = await deps.store.getIdentityByEmail(normalized);
	if (existing === null) {
		await deps.store.putIdentity({ userId, email: normalized, createdAt: deps.clock.now() });
	}
	await new OrganizationsKernelImpl().adminSeedOrganization(tenantId, ownerEmail, "Integration Test", deps);
}

/** Reject integration bearer calls that name a different user id in the body. */
export function assertIntegrationTestUserId(principal: Principal, actorUserId: string): void {
	if (principal.kind !== "integration") {
		return;
	}
	if (principal.userId === null || actorUserId !== principal.userId) {
		throw new PrincipalHttpError(403, "integration test credential user mismatch");
	}
}
