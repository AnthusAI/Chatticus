import { createHmac, timingSafeEqual } from "node:crypto";
import {
	COMPUTER_OWNER_AUDIENCE,
	OWNER_BOOTSTRAP_AUDIENCE,
	computerOwnerTokenClaimsSchema,
	ownerBootstrapTokenClaimsSchema,
	type ComputerOwnerTokenClaims,
	type OwnerBootstrapTokenClaims,
} from "@chatticus/host-protocol/supervisor";

/**
 * What a token may be presented to. The starter mints one token per audience for each owner, so the token that reaches
 * the model gateway cannot be replayed on the host routes and the host token cannot be replayed on the gateway: a stolen
 * token is useful for one surface only, and each surface checks the audience itself.
 */
export type SessionTokenAudience = "model-gateway" | "owner-host";

const AUDIENCES: ReadonlySet<string> = new Set<SessionTokenAudience>(["model-gateway", "owner-host"]);

/** What a session token says about the one turn attempt it was minted for. */
export type SessionTokenClaims = {
	/** The only surface that accepts this token. */
	readonly audience: SessionTokenAudience;
	readonly tenantId: string;
	readonly botId: string;
	readonly turnId: string;
	/** The owner the start generated and the claimed attempt records; another owner taking over makes this token useless. */
	readonly ownerId: string;
	/** The host start generation the starter launched this owner for; the owner's stopped report may release only this generation's lease. */
	readonly startGeneration: number;
	/** Expiry in seconds since the Unix epoch. */
	readonly expiresAtSeconds: number;
};

/** Why a token was not accepted. The reason is for logs and tests; callers never learn it. */
export type SessionTokenRefusal = "malformed" | "signature" | "expired" | "audience";

/** The outcome of verifying a token. */
export type SessionTokenVerification =
	| { readonly valid: true; readonly claims: SessionTokenClaims }
	| { readonly valid: false; readonly reason: SessionTokenRefusal };

const TOKEN_VERSION = "ct1";
const SEPARATOR = ".";
const MINIMUM_KEY_LENGTH = 32;

const base64Url = (bytes: Uint8Array | string): string => Buffer.from(bytes).toString("base64url");

function signatureOf(signingKey: string, signedPart: string): Buffer {
	return createHmac("sha256", signingKey).update(signedPart).digest();
}

function requireStrongKey(signingKey: string): void {
	if (signingKey.length < MINIMUM_KEY_LENGTH) {
		throw new Error(`The session token signing key must be at least ${MINIMUM_KEY_LENGTH} characters.`);
	}
}

/**
 * Mint a signed, expiring token for one turn owner: `ct1.<claims>.<signature>`, claims as base64url JSON and the
 * signature an HMAC-SHA-256 over the version and claims.
 *
 * @param signingKey Secret of the control plane, at least 32 characters; it never leaves the control plane.
 * @param claims The audience, tenant, bot, turn, owner and start generation the token is bound to, and when it expires.
 * @returns The token the container sends in place of a model key.
 */
export function mintSessionToken(signingKey: string, claims: SessionTokenClaims): string {
	requireStrongKey(signingKey);
	const signedPart = `${TOKEN_VERSION}${SEPARATOR}${base64Url(JSON.stringify(claims))}`;
	return `${signedPart}${SEPARATOR}${base64Url(signatureOf(signingKey, signedPart))}`;
}

function claimsFrom(encoded: string): SessionTokenClaims | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const { audience, tenantId, botId, turnId, ownerId, startGeneration, expiresAtSeconds } = parsed as Record<string, unknown>;
	if (
		typeof audience !== "string" ||
		!AUDIENCES.has(audience) ||
		typeof startGeneration !== "number" ||
		!Number.isInteger(startGeneration) ||
		typeof tenantId !== "string" ||
		typeof botId !== "string" ||
		typeof turnId !== "string" ||
		typeof ownerId !== "string" ||
		typeof expiresAtSeconds !== "number" ||
		!Number.isFinite(expiresAtSeconds)
	) {
		return null;
	}
	return { audience: audience as SessionTokenAudience, tenantId, botId, turnId, ownerId, startGeneration, expiresAtSeconds };
}

/**
 * Verify a token: well formed, signed with `signingKey`, minted for `audience`, and not past its expiry.
 *
 * @param signingKey Secret the token was minted with.
 * @param token The token a caller presented.
 * @param now The current time.
 * @param audience The surface verifying; a validly signed token minted for another audience is refused.
 * @returns The claims when valid, otherwise the reason the token was refused.
 */
export function verifySessionToken(signingKey: string, token: string, now: Date, audience: SessionTokenAudience): SessionTokenVerification {
	requireStrongKey(signingKey);
	const parts = token.split(SEPARATOR);
	if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return { valid: false, reason: "malformed" };
	const [version, encodedClaims, encodedSignature] = parts as [string, string, string];
	const presented = Buffer.from(encodedSignature, "base64url");
	const expected = signatureOf(signingKey, `${version}${SEPARATOR}${encodedClaims}`);
	if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
		return { valid: false, reason: "signature" };
	}
	const claims = claimsFrom(encodedClaims);
	if (claims === null) return { valid: false, reason: "malformed" };
	if (claims.audience !== audience) return { valid: false, reason: "audience" };
	if (claims.expiresAtSeconds * 1000 <= now.getTime()) return { valid: false, reason: "expired" };
	return { valid: true, claims };
}

/**
 * The audiences of the owner supervisor protocol. A bootstrap token opens the one-time exchange; a supervisor token opens
 * the owner routes of one computer. The per-turn gateway token keeps its own claims and its own functions above.
 *
 * Phase 2a intent: once the combined server step lands, the `owner-host` audience and the per-turn host token are deleted
 * and these two audiences are the only tokens a container presents to the Front Door. They are additive until then.
 */
export type SupervisorTokenAudience = typeof OWNER_BOOTSTRAP_AUDIENCE | typeof COMPUTER_OWNER_AUDIENCE;

/** The claims of a supervisor protocol token: a discriminated union on the audience. Neither names a bot, channel or turn. */
export type SupervisorTokenClaims = OwnerBootstrapTokenClaims | ComputerOwnerTokenClaims;

/** The claims type for one supervisor protocol audience. */
export type SupervisorTokenClaimsFor<Audience extends SupervisorTokenAudience> = Extract<SupervisorTokenClaims, { readonly audience: Audience }>;

/** The outcome of verifying a supervisor protocol token, typed by the audience that was asked for. */
export type SupervisorTokenVerification<Audience extends SupervisorTokenAudience> =
	| { readonly valid: true; readonly claims: SupervisorTokenClaimsFor<Audience> }
	| { readonly valid: false; readonly reason: SessionTokenRefusal };

const SUPERVISOR_CLAIM_SCHEMAS = {
	[OWNER_BOOTSTRAP_AUDIENCE]: ownerBootstrapTokenClaimsSchema,
	[COMPUTER_OWNER_AUDIENCE]: computerOwnerTokenClaimsSchema,
} as const;

const KNOWN_AUDIENCES: ReadonlySet<string> = new Set<string>([...AUDIENCES, OWNER_BOOTSTRAP_AUDIENCE, COMPUTER_OWNER_AUDIENCE]);

/**
 * Mint a supervisor protocol token, `ct1.<claims>.<signature>`, signed like every other token.
 *
 * @param signingKey Secret of the control plane, at least 32 characters.
 * @param claims The bootstrap or supervisor claims; claims the strict schema refuses (an extra turn claim, a zero generation) are not signed.
 * @returns The token.
 * @throws When the key is weak or the claims do not match the schema of their audience.
 */
export function mintSupervisorToken(signingKey: string, claims: SupervisorTokenClaims): string {
	requireStrongKey(signingKey);
	const schema = SUPERVISOR_CLAIM_SCHEMAS[claims.audience as SupervisorTokenAudience];
	if (schema === undefined) throw new Error(`The audience ${JSON.stringify(claims.audience)} is not a supervisor protocol audience.`);
	const checked = schema.parse(claims);
	const signedPart = `${TOKEN_VERSION}${SEPARATOR}${base64Url(JSON.stringify(checked))}`;
	return `${signedPart}${SEPARATOR}${base64Url(signatureOf(signingKey, signedPart))}`;
}

/**
 * Verify a supervisor protocol token: signed with `signingKey`, minted for `audience`, claims exactly the schema of that
 * audience, and not past its expiry. A token of any other audience, including the gateway and host tokens, is refused with
 * the reason `audience`.
 *
 * @param signingKey Secret the token was minted with.
 * @param token The token a caller presented.
 * @param now The current time.
 * @param audience The surface verifying.
 * @returns The claims typed for the audience when valid, otherwise the reason.
 */
export function verifySupervisorToken<Audience extends SupervisorTokenAudience>(
	signingKey: string,
	token: string,
	now: Date,
	audience: Audience,
): SupervisorTokenVerification<Audience> {
	requireStrongKey(signingKey);
	const parts = token.split(SEPARATOR);
	if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return { valid: false, reason: "malformed" };
	const [version, encodedClaims, encodedSignature] = parts as [string, string, string];
	const presented = Buffer.from(encodedSignature, "base64url");
	const expected = signatureOf(signingKey, `${version}${SEPARATOR}${encodedClaims}`);
	if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return { valid: false, reason: "signature" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8"));
	} catch {
		return { valid: false, reason: "malformed" };
	}
	if (typeof parsed !== "object" || parsed === null) return { valid: false, reason: "malformed" };
	const presentedAudience = (parsed as Record<string, unknown>).audience;
	if (typeof presentedAudience !== "string" || !KNOWN_AUDIENCES.has(presentedAudience)) return { valid: false, reason: "malformed" };
	if (presentedAudience !== audience) return { valid: false, reason: "audience" };
	const result = SUPERVISOR_CLAIM_SCHEMAS[audience].safeParse(parsed);
	if (!result.success) return { valid: false, reason: "malformed" };
	const claims = result.data as SupervisorTokenClaimsFor<Audience>;
	if (claims.expiresAtSeconds * 1000 <= now.getTime()) return { valid: false, reason: "expired" };
	return { valid: true, claims };
}

/** Mint the bootstrap token the starter signs: one owner of one computer start generation, for five minutes, once. */
export function mintOwnerBootstrapToken(signingKey: string, claims: OwnerBootstrapTokenClaims): string {
	return mintSupervisorToken(signingKey, claims);
}

/** Verify a bootstrap token for `POST /host/owner/bootstrap`, the only surface that accepts it. */
export function verifyOwnerBootstrapToken(signingKey: string, token: string, now: Date): SupervisorTokenVerification<typeof OWNER_BOOTSTRAP_AUDIENCE> {
	return verifySupervisorToken(signingKey, token, now, OWNER_BOOTSTRAP_AUDIENCE);
}

/** Mint the supervisor token the credential broker signs. */
export function mintComputerOwnerToken(signingKey: string, claims: ComputerOwnerTokenClaims): string {
	return mintSupervisorToken(signingKey, claims);
}

/** Verify a supervisor token for the owner routes, the only surface that accepts it. */
export function verifyComputerOwnerToken(signingKey: string, token: string, now: Date): SupervisorTokenVerification<typeof COMPUTER_OWNER_AUDIENCE> {
	return verifySupervisorToken(signingKey, token, now, COMPUTER_OWNER_AUDIENCE);
}
