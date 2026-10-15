import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import type { Jwks } from "aws-jwt-verify/jwk";
import { createIdTokenVerifier, type IdTokenVerifier } from "../src/auth/cognito.ts";

export const TEST_USER_POOL_ID = "us-east-1_testpool";
export const TEST_CLIENT_ID = "test-spa-client-id";
export const TEST_KEY_ID = "test-key-id";

/** Options for minting one Cognito-shaped token. */
export type MintOptions = {
	email: string;
	tokenUse?: string;
	emailVerified?: boolean;
	expiresAtSeconds?: number;
	clientId?: string;
	sub?: string;
};

/** One RS256 keypair, its public JWKS, and a verifier seeded with that JWKS. */
export class CognitoTestKeys {
	private readonly privateKey: CryptoKey;
	readonly jwks: Jwks;

	private constructor(privateKey: CryptoKey, jwks: Jwks) {
		this.privateKey = privateKey;
		this.jwks = jwks;
	}

	static async generate(keyId: string = TEST_KEY_ID): Promise<CognitoTestKeys> {
		const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
		const publicJwk = await exportJWK(publicKey);
		const jwks = { keys: [{ ...publicJwk, kid: keyId, use: "sig", alg: "RS256" }] } as Jwks;
		return new CognitoTestKeys(privateKey, jwks);
	}

	verifier(): IdTokenVerifier {
		return createIdTokenVerifier({ userPoolId: TEST_USER_POOL_ID, clientId: TEST_CLIENT_ID }, this.jwks);
	}

	async mintIdToken(options: MintOptions): Promise<string> {
		const nowSeconds = Math.floor(Date.now() / 1000);
		return new SignJWT({
			email: options.email,
			email_verified: options.emailVerified ?? true,
			token_use: options.tokenUse ?? "id",
		})
			.setProtectedHeader({ alg: "RS256", kid: TEST_KEY_ID })
			.setSubject(options.sub ?? crypto.randomUUID())
			.setIssuer(`https://cognito-idp.us-east-1.amazonaws.com/${TEST_USER_POOL_ID}`)
			.setAudience(options.clientId ?? TEST_CLIENT_ID)
			.setIssuedAt(nowSeconds)
			.setExpirationTime(options.expiresAtSeconds ?? nowSeconds + 3600)
			.sign(this.privateKey);
	}
}
