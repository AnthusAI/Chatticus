import { createHmac, timingSafeEqual } from "node:crypto";

/** What a session token says about the one turn attempt it was minted for. */
export type SessionTokenClaims = {
	readonly tenantId: string;
	readonly botId: string;
	readonly turnId: string;
	/** The owner the start generated and the claimed attempt records; another owner taking over makes this token useless. */
	readonly ownerId: string;
	/** Expiry in seconds since the Unix epoch. */
	readonly expiresAtSeconds: number;
};

/** Why a token was not accepted. The reason is for logs and tests; callers never learn it. */
export type SessionTokenRefusal = "malformed" | "signature" | "expired";

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
 * @param claims The tenant, bot, turn and owner the token is bound to, and when it expires.
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
	const { tenantId, botId, turnId, ownerId, expiresAtSeconds } = parsed as Record<string, unknown>;
	if (
		typeof tenantId !== "string" ||
		typeof botId !== "string" ||
		typeof turnId !== "string" ||
		typeof ownerId !== "string" ||
		typeof expiresAtSeconds !== "number" ||
		!Number.isFinite(expiresAtSeconds)
	) {
		return null;
	}
	return { tenantId, botId, turnId, ownerId, expiresAtSeconds };
}

/**
 * Verify a token: well formed, signed with `signingKey`, and not past its expiry.
 *
 * @param signingKey Secret the token was minted with.
 * @param token The token a caller presented.
 * @param now The current time.
 * @returns The claims when valid, otherwise the reason the token was refused.
 */
export function verifySessionToken(signingKey: string, token: string, now: Date): SessionTokenVerification {
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
	if (claims.expiresAtSeconds * 1000 <= now.getTime()) return { valid: false, reason: "expired" };
	return { valid: true, claims };
}
