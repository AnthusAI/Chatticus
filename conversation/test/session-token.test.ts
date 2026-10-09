import { describe, expect, it } from "vitest";
import { mintSessionToken, verifySessionToken, type SessionTokenClaims } from "../src/gateway/session-token.ts";

const KEY = "unit-test-signing-key-0123456789abcdef";
const NOW = new Date("2026-10-07T12:00:00Z");
const claims: SessionTokenClaims = {
	tenantId: "anthus",
	botId: "bot-1",
	turnId: "turn-1",
	ownerId: "owner-1",
	expiresAtSeconds: Math.floor(NOW.getTime() / 1000) + 300,
};

describe("session token", () => {
	it("round-trips its claims", () => {
		expect(verifySessionToken(KEY, mintSessionToken(KEY, claims), NOW)).toEqual({ valid: true, claims });
	});

	it("expires exactly at the expiry second", () => {
		const token = mintSessionToken(KEY, claims);
		expect(verifySessionToken(KEY, token, new Date((claims.expiresAtSeconds - 1) * 1000)).valid).toBe(true);
		expect(verifySessionToken(KEY, token, new Date(claims.expiresAtSeconds * 1000))).toEqual({ valid: false, reason: "expired" });
	});

	it("rejects a signature made with another key", () => {
		const token = mintSessionToken("another-signing-key-0123456789abcdef", claims);
		expect(verifySessionToken(KEY, token, NOW)).toEqual({ valid: false, reason: "signature" });
	});

	it("rejects changed claims", () => {
		const [version, , signature] = mintSessionToken(KEY, claims).split(".");
		const changed = Buffer.from(JSON.stringify({ ...claims, tenantId: "other" })).toString("base64url");
		expect(verifySessionToken(KEY, `${version}.${changed}.${signature}`, NOW)).toEqual({ valid: false, reason: "signature" });
	});

	it.each(["", "not-a-token", "ct1.only-two", "ct2.a.b", "ct1.a.b.c"])("rejects the malformed token %j", (token) => {
		expect(verifySessionToken(KEY, token, NOW).valid).toBe(false);
	});

	it("rejects a correctly signed token whose claims are not claims", () => {
		const encoded = Buffer.from(JSON.stringify({ tenantId: 7 })).toString("base64url");
		const signed = `ct1.${encoded}`;
		const forged = `${signed}.${mintSessionToken(KEY, claims).split(".")[2]}`;
		expect(verifySessionToken(KEY, forged, NOW).valid).toBe(false);
	});

	it("refuses to sign or verify with a weak key", () => {
		expect(() => mintSessionToken("short", claims)).toThrow("at least 32 characters");
		expect(() => verifySessionToken("short", "ct1.a.b", NOW)).toThrow("at least 32 characters");
	});
});
