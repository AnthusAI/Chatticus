import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_SEPARATOR = ".";

/**
 * Return a new random worker bearer credential, `<workerId>.<secret>`. The id in front lets the front door read the one
 * worker record the credential claims instead of comparing it with every worker of the organization; the secret is 32
 * random bytes and is the only part the stored hash protects.
 *
 * @param workerId The worker the credential is for.
 */
export function mintWorkerToken(workerId: string): string {
	return `${workerId}${TOKEN_SEPARATOR}${randomBytes(32).toString("base64url")}`;
}

/**
 * The worker id a credential claims, or null when the credential has no id in front. The secret never contains the
 * separator, so the id is everything before the last one.
 *
 * @param token The bearer credential.
 */
export function workerIdOfToken(token: string): string | null {
	const index = token.lastIndexOf(TOKEN_SEPARATOR);
	return index <= 0 ? null : token.slice(0, index);
}

/** Return the SHA-256 hex digest of `token`. */
export function hashWorkerToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/** Return whether `token` matches the stored `tokenHash`, comparing in constant time. */
export function verifyWorkerTokenHash(token: string, tokenHash: string): boolean {
	const expected = Buffer.from(hashWorkerToken(token));
	const actual = Buffer.from(tokenHash);
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}
