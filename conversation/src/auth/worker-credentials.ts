import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Return a new random worker bearer credential. */
export function mintWorkerToken(): string {
	return randomBytes(32).toString("base64url");
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
