import { describe, expect, it } from "vitest";
import { FakeOwnerCredentialBroker } from "../features-support/fakes/fake-owner-credential-broker.ts";
import { FakeClock } from "../features-support/clock.ts";
import { OWNER_BROKER_MINIMUM_SESSION_SECONDS, OWNER_HARD_LIFETIME_SECONDS } from "@chatticus/host-protocol/supervisor";
import { mintComputerOwnerToken, mintOwnerBootstrapToken, verifyComputerOwnerToken, verifySessionToken } from "../src/gateway/session-token.ts";

const KEY = "unit-test-signing-key-0123456789abcdef";

function setup(): { broker: FakeOwnerCredentialBroker; clock: FakeClock; bootstrap: string; supervisor: string } {
	const clock = new FakeClock(new Date("2026-10-07T12:00:00Z"));
	const nowSeconds = Math.floor(clock.now().getTime() / 1000);
	const base = { tenantId: "anthus", computerId: "computer-1", ownerId: "owner-1", startGeneration: 2, issuedAtSeconds: nowSeconds };
	return {
		broker: new FakeOwnerCredentialBroker(KEY, clock),
		clock,
		bootstrap: mintOwnerBootstrapToken(KEY, { ...base, audience: "owner-bootstrap", expiresAtSeconds: nowSeconds + 300 }),
		supervisor: mintComputerOwnerToken(KEY, { ...base, audience: "computer-owner", ownerStartedAtSeconds: nowSeconds, expiresAtSeconds: nowSeconds + 3600 }),
	};
}

const identity = { version: 1, tenant_id: "anthus", computer_id: "computer-1", owner_id: "owner-1", generation: 2 } as const;
const turn = { turn_id: "turn-1", bot_id: "bot-1", channel_id: "channel-1" };

describe("FakeOwnerCredentialBroker", () => {
	it("issues a supervisor grant with a real supervisor token and records the two supervisor tags", async () => {
		const { broker, clock, bootstrap } = setup();
		const grant = await broker.issue({ ...identity, purpose: "supervisor", authorization: bootstrap });
		const verification = verifyComputerOwnerToken(KEY, grant.supervisor_token, clock.now());
		expect(verification).toMatchObject({ valid: true, claims: { computerId: "computer-1", ownerId: "owner-1", startGeneration: 2 } });
		expect(grant.supervisor_token_expires_at).toBe(grant.aws_credentials.expires_at);
		expect(broker.calls).toHaveLength(1);
		expect(broker.calls[0]!.tags).toEqual([
			{ Key: "tenant", Value: "anthus" },
			{ Key: "computer", Value: "computer-1" },
		]);
	});

	it("issues a turn grant with a real gateway token and records the five turn tags", async () => {
		const { broker, clock, supervisor } = setup();
		const grant = await broker.issue({ ...identity, purpose: "turn", authorization: supervisor, turn });
		expect(verifySessionToken(KEY, grant.gateway_token, clock.now(), "model-gateway")).toMatchObject({
			valid: true,
			claims: { botId: "bot-1", turnId: "turn-1", ownerId: "owner-1", startGeneration: 2 },
		});
		expect(broker.calls[0]!.tags.map((tag) => tag.Key)).toEqual(["tenant", "bot", "channel", "computer", "turn"]);
	});

	it("refuses an authorization of the wrong audience, an expired one and one that names another owner", async () => {
		const { broker, clock, bootstrap, supervisor } = setup();
		await expect(broker.issue({ ...identity, purpose: "turn", authorization: bootstrap, turn })).rejects.toMatchObject({ code: "invalid_authorization" });
		await expect(broker.issue({ ...identity, purpose: "supervisor", authorization: supervisor })).rejects.toMatchObject({ code: "invalid_authorization" });
		await expect(broker.issue({ ...identity, owner_id: "owner-2", purpose: "supervisor", authorization: bootstrap })).rejects.toMatchObject({
			code: "authorization_mismatch",
		});
		clock.advanceSeconds(301);
		await expect(broker.issue({ ...identity, purpose: "supervisor", authorization: bootstrap })).rejects.toMatchObject({ code: "invalid_authorization" });
	});

	it("refuses an unsafe id as the real broker does", async () => {
		const { broker, supervisor } = setup();
		await expect(
			broker.issue({ ...identity, purpose: "turn", authorization: supervisor, turn: { ...turn, bot_id: "bot*" } }),
		).rejects.toMatchObject({ code: "unsafe_tag_value" });
	});

	it("anchors the owner's start at the bootstrap and puts it in the supervisor token", async () => {
		const { broker, clock, bootstrap } = setup();
		const grant = await broker.issue({ ...identity, purpose: "supervisor", authorization: bootstrap });
		const verification = verifyComputerOwnerToken(KEY, grant.supervisor_token, clock.now());
		expect(verification).toMatchObject({ valid: true, claims: { ownerStartedAtSeconds: Math.floor(clock.now().getTime() / 1000) } });
	});

	it("renews supervisor credentials with the same tags, the same anchor and a new token", async () => {
		const { broker, clock, supervisor } = setup();
		const anchor = Math.floor(clock.now().getTime() / 1000);
		clock.advanceSeconds(2400);
		const grant = await broker.issue({ ...identity, purpose: "supervisor_renewal", authorization: supervisor });
		expect(grant.purpose).toBe("supervisor_renewal");
		const verification = verifyComputerOwnerToken(KEY, grant.supervisor_token, clock.now());
		expect(verification).toMatchObject({ valid: true, claims: { ownerStartedAtSeconds: anchor, issuedAtSeconds: anchor + 2400 } });
		expect(grant.supervisor_token_expires_at).toBe(grant.aws_credentials.expires_at);
		expect(grant.aws_credentials.expires_at).toBe(new Date((anchor + 2400 + 3600) * 1000).toISOString());
		expect(broker.calls[0]!.tags).toEqual([
			{ Key: "tenant", Value: "anthus" },
			{ Key: "computer", Value: "computer-1" },
		]);
	});

	it("refuses a renewal authorized by a bootstrap token or an expired supervisor token", async () => {
		const { broker, clock, bootstrap, supervisor } = setup();
		await expect(broker.issue({ ...identity, purpose: "supervisor_renewal", authorization: bootstrap })).rejects.toMatchObject({ code: "invalid_authorization" });
		clock.advanceSeconds(3601);
		await expect(broker.issue({ ...identity, purpose: "supervisor_renewal", authorization: supervisor })).rejects.toMatchObject({ code: "invalid_authorization" });
	});

	describe("near the hard end of the owner", () => {
		function tokenAnchoredSecondsAgo(clock: FakeClock, ageSeconds: number): string {
			const nowSeconds = Math.floor(clock.now().getTime() / 1000);
			return mintComputerOwnerToken(KEY, {
				audience: "computer-owner",
				tenantId: "anthus",
				computerId: "computer-1",
				ownerId: "owner-1",
				startGeneration: 2,
				ownerStartedAtSeconds: nowSeconds - ageSeconds,
				issuedAtSeconds: nowSeconds,
				expiresAtSeconds: nowSeconds + 3600,
			});
		}

		it("cuts a renewal to the hard end and ends the token with the credentials", async () => {
			const { broker, clock } = setup();
			const nowSeconds = Math.floor(clock.now().getTime() / 1000);
			const grant = await broker.issue({ ...identity, purpose: "supervisor_renewal", authorization: tokenAnchoredSecondsAgo(clock, OWNER_HARD_LIFETIME_SECONDS - 1800) });
			expect(grant.aws_credentials.expires_at).toBe(new Date((nowSeconds + 1800) * 1000).toISOString());
			expect(grant.supervisor_token_expires_at).toBe(grant.aws_credentials.expires_at);
		});

		it("cuts the credentials and the gateway token of a turn to the hard end", async () => {
			const { broker, clock } = setup();
			const nowSeconds = Math.floor(clock.now().getTime() / 1000);
			const grant = await broker.issue({ ...identity, purpose: "turn", authorization: tokenAnchoredSecondsAgo(clock, OWNER_HARD_LIFETIME_SECONDS - 1000), turn });
			expect(grant.expires_at).toBe(new Date((nowSeconds + 1000) * 1000).toISOString());
		});

		it("grants the last session that STS allows and refuses one second less", async () => {
			const { broker, clock } = setup();
			await expect(
				broker.issue({ ...identity, purpose: "supervisor_renewal", authorization: tokenAnchoredSecondsAgo(clock, OWNER_HARD_LIFETIME_SECONDS - OWNER_BROKER_MINIMUM_SESSION_SECONDS) }),
			).resolves.toMatchObject({ ok: true });
			await expect(
				broker.issue({ ...identity, purpose: "supervisor_renewal", authorization: tokenAnchoredSecondsAgo(clock, OWNER_HARD_LIFETIME_SECONDS - OWNER_BROKER_MINIMUM_SESSION_SECONDS + 1) }),
			).rejects.toMatchObject({ code: "owner_lifetime_over" });
			await expect(
				broker.issue({ ...identity, purpose: "turn", authorization: tokenAnchoredSecondsAgo(clock, OWNER_HARD_LIFETIME_SECONDS + 5), turn }),
			).rejects.toMatchObject({ code: "owner_lifetime_over" });
		});
	});

	it("records a call it was told to fail and one it refused", async () => {
		const { broker, bootstrap } = setup();
		broker.failNextCall("assume_role_failed");
		await expect(broker.issue({ ...identity, purpose: "supervisor_renewal", authorization: bootstrap })).rejects.toMatchObject({ code: "assume_role_failed" });
		expect(broker.calls.map((call) => call.request.purpose)).toEqual(["supervisor_renewal"]);
	});

	it("holds the next call until released and holds only that one", async () => {
		const { broker, supervisor } = setup();
		const release = broker.holdNextCall();
		let answered = false;
		const pending = broker.issue({ ...identity, purpose: "supervisor_renewal", authorization: supervisor }).then((grant) => {
			answered = true;
			return grant;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(answered).toBe(false);
		release();
		await expect(pending).resolves.toMatchObject({ ok: true, purpose: "supervisor_renewal" });
		await expect(broker.issue({ ...identity, purpose: "supervisor_renewal", authorization: supervisor })).resolves.toMatchObject({ ok: true });
	});

	it("fails the next call only, with the configured code", async () => {
		const { broker, bootstrap } = setup();
		broker.failNextCall("assume_role_failed");
		await expect(broker.issue({ ...identity, purpose: "supervisor", authorization: bootstrap })).rejects.toMatchObject({ code: "assume_role_failed" });
		await expect(broker.issue({ ...identity, purpose: "supervisor", authorization: bootstrap })).resolves.toMatchObject({ ok: true });
		expect(broker.calls).toHaveLength(2);
	});
});
