import { describe, expect, it } from "vitest";
import { CognitoTokenError } from "../src/auth/cognito.ts";
import { MembershipCache } from "../src/auth/membership-cache.ts";
import { CognitoTestKeys } from "../features-support/test-jwt.ts";

describe("Cognito id token verifier with an injected JWKS", () => {
	it("verifies a token and normalizes the email", async () => {
		const keys = await CognitoTestKeys.generate();
		const token = await keys.mintIdToken({ email: " Owner@Example.com ", sub: "s1" });
		expect(await keys.verifier().verifyIdToken(token)).toEqual({
			email: "owner@example.com",
			emailVerified: true,
			sub: "s1",
		});
	});

	it("rejects a token signed by another key with the same kid", async () => {
		const keys = await CognitoTestKeys.generate();
		const other = await CognitoTestKeys.generate();
		const token = await other.mintIdToken({ email: "a@b.c" });
		await expect(keys.verifier().verifyIdToken(token)).rejects.toBeInstanceOf(CognitoTokenError);
	});

	it("rejects an expired token", async () => {
		const keys = await CognitoTestKeys.generate();
		const token = await keys.mintIdToken({ email: "a@b.c", expiresAtSeconds: 1577836800 });
		await expect(keys.verifier().verifyIdToken(token)).rejects.toThrow(/expired/i);
	});

	it("rejects a wrong audience, an access token and an unverified email", async () => {
		const keys = await CognitoTestKeys.generate();
		const verifier = keys.verifier();
		const wrongAudience = await keys.mintIdToken({ email: "a@b.c", clientId: "other" });
		await expect(verifier.verifyIdToken(wrongAudience)).rejects.toThrow(/audience|client/i);
		const accessToken = await keys.mintIdToken({ email: "a@b.c", tokenUse: "access" });
		await expect(verifier.verifyIdToken(accessToken)).rejects.toBeInstanceOf(CognitoTokenError);
		const unverified = await keys.mintIdToken({ email: "a@b.c", emailVerified: false });
		await expect(verifier.verifyIdToken(unverified)).rejects.toThrow("id_token email is not verified.");
	});
});

describe("MembershipCache", () => {
	it("expires entries after 30000 ms and bounds size at 1000", () => {
		let now = 0;
		const cache = new MembershipCache<number>({ nowMilliseconds: () => now });
		cache.set("t", "u", 1);
		now = 29999;
		expect(cache.get("t", "u")).toBe(1);
		now = 30000;
		expect(cache.get("t", "u")).toBeUndefined();
		for (let index = 0; index < 1200; index += 1) {
			cache.set("t", String(index), index);
		}
		expect(cache.size).toBe(1000);
		expect(cache.get("t", "0")).toBeUndefined();
		expect(cache.get("t", "1199")).toBe(1199);
	});
});
