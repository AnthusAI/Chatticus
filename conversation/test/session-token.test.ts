import { describe, expect, it } from "vitest";
import { mintSessionToken, verifySessionToken, type SessionTokenClaims } from "../src/gateway/session-token.ts";

const KEY = "unit-test-signing-key-0123456789abcdef";
const NOW = new Date("2026-10-07T12:00:00Z");
const claims: SessionTokenClaims = {
	audience: "model-gateway",
	startGeneration: 3,
	tenantId: "anthus",
	botId: "bot-1",
	turnId: "turn-1",
	ownerId: "owner-1",
	expiresAtSeconds: Math.floor(NOW.getTime() / 1000) + 300,
};

describe("session token", () => {
	it("round-trips its claims", () => {
		expect(verifySessionToken(KEY, mintSessionToken(KEY, claims), NOW, "model-gateway")).toEqual({ valid: true, claims });
	});

	it("expires exactly at the expiry second", () => {
		const token = mintSessionToken(KEY, claims);
		expect(verifySessionToken(KEY, token, new Date((claims.expiresAtSeconds - 1) * 1000), "model-gateway").valid).toBe(true);
		expect(verifySessionToken(KEY, token, new Date(claims.expiresAtSeconds * 1000), "model-gateway")).toEqual({ valid: false, reason: "expired" });
	});

	it("rejects a signature made with another key", () => {
		const token = mintSessionToken("another-signing-key-0123456789abcdef", claims);
		expect(verifySessionToken(KEY, token, NOW, "model-gateway")).toEqual({ valid: false, reason: "signature" });
	});

	it("rejects changed claims", () => {
		const [version, , signature] = mintSessionToken(KEY, claims).split(".");
		const changed = Buffer.from(JSON.stringify({ ...claims, tenantId: "other" })).toString("base64url");
		expect(verifySessionToken(KEY, `${version}.${changed}.${signature}`, NOW, "model-gateway")).toEqual({ valid: false, reason: "signature" });
	});

	it.each(["", "not-a-token", "ct1.only-two", "ct2.a.b", "ct1.a.b.c"])("rejects the malformed token %j", (token) => {
		expect(verifySessionToken(KEY, token, NOW, "model-gateway").valid).toBe(false);
	});

	it("rejects a correctly signed token whose claims are not claims", () => {
		const encoded = Buffer.from(JSON.stringify({ tenantId: 7 })).toString("base64url");
		const signed = `ct1.${encoded}`;
		const forged = `${signed}.${mintSessionToken(KEY, claims).split(".")[2]}`;
		expect(verifySessionToken(KEY, forged, NOW, "model-gateway").valid).toBe(false);
	});

	it("refuses a validly signed token minted for the other audience", () => {
		const token = mintSessionToken(KEY, claims);
		expect(verifySessionToken(KEY, token, NOW, "owner-host")).toEqual({ valid: false, reason: "audience" });
		const hostToken = mintSessionToken(KEY, { ...claims, audience: "owner-host" });
		expect(verifySessionToken(KEY, hostToken, NOW, "owner-host")).toEqual({ valid: true, claims: { ...claims, audience: "owner-host" } });
		expect(verifySessionToken(KEY, hostToken, NOW, "model-gateway")).toEqual({ valid: false, reason: "audience" });
	});

	it("rejects a token with an unknown audience or a fractional start generation", () => {
		const unknownAudience = mintSessionToken(KEY, { ...claims, audience: "anything" as never });
		const fractionalGeneration = mintSessionToken(KEY, { ...claims, startGeneration: 1.5 });
		expect(verifySessionToken(KEY, unknownAudience, NOW, "model-gateway")).toEqual({ valid: false, reason: "malformed" });
		expect(verifySessionToken(KEY, fractionalGeneration, NOW, "model-gateway")).toEqual({ valid: false, reason: "malformed" });
	});

	it("refuses to sign or verify with a weak key", () => {
		expect(() => mintSessionToken("short", claims)).toThrow("at least 32 characters");
		expect(() => verifySessionToken("short", "ct1.a.b", NOW, "model-gateway")).toThrow("at least 32 characters");
	});
});
