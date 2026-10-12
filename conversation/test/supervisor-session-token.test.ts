import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	mintComputerOwnerToken,
	mintOwnerBootstrapToken,
	mintSessionToken,
	mintSupervisorToken,
	verifyComputerOwnerToken,
	verifyOwnerBootstrapToken,
	verifySessionToken,
	verifySupervisorToken,
	type SupervisorTokenClaims,
} from "../src/gateway/session-token.ts";

const KEY = "unit-test-signing-key-0123456789abcdef";
const NOW = new Date("2026-10-07T12:00:00Z");
const nowSeconds = Math.floor(NOW.getTime() / 1000);

const bootstrapClaims = {
	audience: "owner-bootstrap",
	tenantId: "anthus",
	computerId: "computer-1",
	ownerId: "owner-1",
	startGeneration: 3,
	issuedAtSeconds: nowSeconds,
	expiresAtSeconds: nowSeconds + 300,
} as const;

const supervisorClaims = { ...bootstrapClaims, audience: "computer-owner", expiresAtSeconds: nowSeconds + 3600 } as const;

function forge(claims: Record<string, unknown>): string {
	const signed = `ct1.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
	return `${signed}.${createHmac("sha256", KEY).update(signed).digest("base64url")}`;
}

describe("supervisor protocol tokens", () => {
	it("round-trips the bootstrap claims", () => {
		const token = mintOwnerBootstrapToken(KEY, bootstrapClaims);
		expect(verifyOwnerBootstrapToken(KEY, token, NOW)).toEqual({ valid: true, claims: bootstrapClaims });
	});

	it("round-trips the supervisor claims", () => {
		const token = mintComputerOwnerToken(KEY, supervisorClaims);
		expect(verifyComputerOwnerToken(KEY, token, NOW)).toEqual({ valid: true, claims: supervisorClaims });
	});

	it("verifies by audience through the generic functions", () => {
		const token = mintSupervisorToken(KEY, supervisorClaims satisfies SupervisorTokenClaims);
		const verification = verifySupervisorToken(KEY, token, NOW, "computer-owner");
		expect(verification.valid && verification.claims.computerId).toBe("computer-1");
	});

	it("refuses a bootstrap token on the supervisor surface and a supervisor token on the bootstrap surface", () => {
		const bootstrap = mintOwnerBootstrapToken(KEY, bootstrapClaims);
		const supervisor = mintComputerOwnerToken(KEY, supervisorClaims);
		expect(verifyComputerOwnerToken(KEY, bootstrap, NOW)).toEqual({ valid: false, reason: "audience" });
		expect(verifyOwnerBootstrapToken(KEY, supervisor, NOW)).toEqual({ valid: false, reason: "audience" });
	});

	it("refuses a gateway token on the supervisor surfaces", () => {
		const turnClaims = { tenantId: "anthus", botId: "bot-1", turnId: "turn-1", ownerId: "owner-1", startGeneration: 3, expiresAtSeconds: nowSeconds + 300 };
		const gateway = mintSessionToken(KEY, { ...turnClaims, audience: "model-gateway" });
		expect(verifyComputerOwnerToken(KEY, gateway, NOW)).toEqual({ valid: false, reason: "audience" });
		expect(verifyOwnerBootstrapToken(KEY, gateway, NOW)).toEqual({ valid: false, reason: "audience" });
	});

	it("is refused by the gateway token verification for every supervisor audience", () => {
		for (const token of [mintOwnerBootstrapToken(KEY, bootstrapClaims), mintComputerOwnerToken(KEY, supervisorClaims)]) {
			expect(verifySessionToken(KEY, token, NOW, "model-gateway")).toEqual({ valid: false, reason: "audience" });
		}
	});

	it("expires exactly at the expiry second", () => {
		const token = mintOwnerBootstrapToken(KEY, bootstrapClaims);
		expect(verifyOwnerBootstrapToken(KEY, token, new Date((bootstrapClaims.expiresAtSeconds - 1) * 1000)).valid).toBe(true);
		expect(verifyOwnerBootstrapToken(KEY, token, new Date(bootstrapClaims.expiresAtSeconds * 1000))).toEqual({ valid: false, reason: "expired" });
	});

	it("rejects a signature made with another key and changed claims", () => {
		const other = mintComputerOwnerToken("another-signing-key-0123456789abcdef", supervisorClaims);
		expect(verifyComputerOwnerToken(KEY, other, NOW)).toEqual({ valid: false, reason: "signature" });
		const [version, , signature] = mintComputerOwnerToken(KEY, supervisorClaims).split(".");
		const changed = Buffer.from(JSON.stringify({ ...supervisorClaims, computerId: "computer-2" })).toString("base64url");
		expect(verifyComputerOwnerToken(KEY, `${version}.${changed}.${signature}`, NOW)).toEqual({ valid: false, reason: "signature" });
	});

	it.each(["", "not-a-token", "ct1.only-two", "ct2.a.b", "ct1.a.b.c"])("rejects the malformed token %j", (token) => {
		expect(verifyComputerOwnerToken(KEY, token, NOW)).toEqual({ valid: false, reason: "malformed" });
	});

	it("rejects a correctly signed supervisor token that carries a turn or bot claim", () => {
		expect(verifyComputerOwnerToken(KEY, forge({ ...supervisorClaims, turnId: "turn-1" }), NOW)).toEqual({ valid: false, reason: "malformed" });
		expect(verifyComputerOwnerToken(KEY, forge({ ...supervisorClaims, botId: "bot-1" }), NOW)).toEqual({ valid: false, reason: "malformed" });
	});

	it.each([
		["a missing owner", { ...supervisorClaims, ownerId: undefined }],
		["a numeric tenant", { ...supervisorClaims, tenantId: 7 }],
		["a fractional generation", { ...supervisorClaims, startGeneration: 1.5 }],
		["a zero generation", { ...supervisorClaims, startGeneration: 0 }],
		["an empty computer", { ...supervisorClaims, computerId: "" }],
		["a string expiry", { ...supervisorClaims, expiresAtSeconds: "9999999999" }],
	])("rejects a correctly signed token with %s", (_name, claims) => {
		expect(verifyComputerOwnerToken(KEY, forge(claims), NOW)).toEqual({ valid: false, reason: "malformed" });
	});

	it("rejects a correctly signed token with an unknown audience as malformed", () => {
		expect(verifyComputerOwnerToken(KEY, forge({ ...supervisorClaims, audience: "anything" }), NOW)).toEqual({ valid: false, reason: "malformed" });
	});

	it("refuses to mint claims the schema refuses", () => {
		expect(() => mintComputerOwnerToken(KEY, { ...supervisorClaims, turnId: "turn-1" } as never)).toThrow();
		expect(() => mintOwnerBootstrapToken(KEY, { ...bootstrapClaims, startGeneration: 0 })).toThrow();
		expect(() => mintSupervisorToken(KEY, { ...supervisorClaims, audience: "model-gateway" } as never)).toThrow(/not a supervisor protocol audience/);
	});

	it("refuses a weak signing key", () => {
		expect(() => mintOwnerBootstrapToken("short", bootstrapClaims)).toThrow(/at least 32/);
		expect(() => verifyOwnerBootstrapToken("short", "ct1.a.b", NOW)).toThrow(/at least 32/);
	});
});
