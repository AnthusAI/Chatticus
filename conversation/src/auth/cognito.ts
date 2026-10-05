import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { Jwks } from "aws-jwt-verify/jwk";

/** Raised when a Cognito JWT is invalid or unusable for user resolution. */
export class CognitoTokenError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CognitoTokenError";
	}
}

/** Verified claims of a Cognito id token; identity is the email, never the sub. */
export type Claims = {
	email: string;
	emailVerified: true;
	sub: string;
};

/** Identifies one Cognito user pool and the app client allowed as audience. */
export type CognitoConfig = {
	userPoolId: string;
	clientId: string;
};

/** Verifies Cognito id tokens. */
export type IdTokenVerifier = {
	verifyIdToken(token: string): Promise<Claims>;
};

/** Lowercase and strip surrounding whitespace only, as the Python normalize_email does. */
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/**
 * Build a verifier for one user pool. Pass `jwks` to seed the key cache so no
 * network request is made (tests); omit it to fetch the pool JWKS on demand.
 */
export function createIdTokenVerifier(config: CognitoConfig, jwks?: Jwks): IdTokenVerifier {
	const verifier = CognitoJwtVerifier.create({
		userPoolId: config.userPoolId,
		tokenUse: "id",
		clientId: config.clientId,
	});
	if (jwks !== undefined) {
		verifier.cacheJwks(jwks);
	}
	return {
		async verifyIdToken(token: string): Promise<Claims> {
			let payload;
			try {
				payload = await verifier.verify(token);
			} catch (error) {
				throw new CognitoTokenError(error instanceof Error ? error.message : String(error));
			}
			const email = payload["email"];
			if (typeof email !== "string" || email.trim() === "") {
				throw new CognitoTokenError("id_token is missing email claim.");
			}
			if (payload["email_verified"] !== true) {
				throw new CognitoTokenError("id_token email is not verified.");
			}
			return { email: normalizeEmail(email), emailVerified: true, sub: payload.sub };
		},
	};
}
