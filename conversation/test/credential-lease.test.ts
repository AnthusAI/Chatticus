import { describe, expect, it } from "vitest";
import {
	OWNER_CREDENTIAL_DRAIN_BUDGET_SECONDS,
	OWNER_CREDENTIAL_HARD_DEADLINE_MARGIN_SECONDS,
	OWNER_CREDENTIAL_RENEWAL_MARGIN_SECONDS,
	OWNER_CREDENTIAL_RENEWAL_MINIMUM_INTERVAL_SECONDS,
} from "@chatticus/host-protocol/supervisor";
import { CredentialHolder, CredentialLease, TurnCredentialLease } from "../../computer/host/src/credential-lease.ts";

const SECOND = 1000;
const HOUR_MILLISECONDS = 3600 * SECOND;

function leaseAcquiredAtZero(lifetimeSeconds: number = 3600): CredentialLease {
	return new CredentialLease(lifetimeSeconds * SECOND, 0);
}

describe("CredentialHolder", () => {
	it("serves the set in force and a whole new set after a replace, leaving a set already taken as it was", () => {
		const first = { expires_at: "2026-10-14T13:00:00.000Z", label: "first" };
		const second = { expires_at: "2026-10-14T14:00:00.000Z", label: "second" };
		const holder = new CredentialHolder(first);
		const taken = holder.current();
		holder.replace(second);
		expect(holder.current()).toBe(second);
		expect(taken).toBe(first);
		expect(taken.label).toBe("first");
	});
});

describe("CredentialLease schedule", () => {
	it("is due twenty minutes before the credentials end and not a moment earlier", () => {
		const lease = leaseAcquiredAtZero();
		const dueAt = HOUR_MILLISECONDS - OWNER_CREDENTIAL_RENEWAL_MARGIN_SECONDS * SECOND;
		expect(OWNER_CREDENTIAL_RENEWAL_MARGIN_SECONDS).toBe(1200);
		expect(lease.dueAtMilliseconds()).toBe(dueAt);
		expect(lease.isDue(dueAt - 1)).toBe(false);
		expect(lease.isDue(dueAt)).toBe(true);
	});

	it("is never due sooner than the server's minimum interval after the last success", () => {
		const lease = leaseAcquiredAtZero(900);
		expect(lease.dueAtMilliseconds()).toBe(OWNER_CREDENTIAL_RENEWAL_MINIMUM_INTERVAL_SECONDS * SECOND);
		lease.beginRenewal();
		lease.succeeded(100 * SECOND, 100 * SECOND + 900 * SECOND);
		expect(lease.dueAtMilliseconds()).toBe(160 * SECOND);
	});

	it("pauses 15, 30, 60 and then 60 seconds after each failure, and starts over after a success", () => {
		const lease = leaseAcquiredAtZero();
		const start = lease.dueAtMilliseconds();
		const pauses: number[] = [];
		let now = start;
		for (let attempt = 0; attempt < 5; attempt += 1) {
			lease.beginRenewal();
			lease.failed(now);
			pauses.push((lease.dueAtMilliseconds() - now) / SECOND);
			now = lease.dueAtMilliseconds();
		}
		expect(pauses).toEqual([15, 30, 60, 60, 60]);
		expect(lease.consecutiveFailures).toBe(5);
		lease.beginRenewal();
		lease.succeeded(now, now + HOUR_MILLISECONDS);
		expect(lease.consecutiveFailures).toBe(0);
		expect(lease.dueAtMilliseconds()).toBe(now + HOUR_MILLISECONDS - OWNER_CREDENTIAL_RENEWAL_MARGIN_SECONDS * SECOND);
	});

	it("has one request in flight at a time and nothing due while it is out", () => {
		const lease = leaseAcquiredAtZero();
		lease.beginRenewal();
		expect(lease.inFlight).toBe(true);
		expect(lease.dueAtMilliseconds()).toBe(Number.POSITIVE_INFINITY);
		lease.abandon();
		expect(lease.inFlight).toBe(false);
		expect(lease.isDue(HOUR_MILLISECONDS)).toBe(true);
	});

	it("is due no more after a refusal for good", () => {
		const lease = leaseAcquiredAtZero();
		lease.beginRenewal();
		lease.refuse();
		expect(lease.refused).toBe(true);
		expect(lease.isDue(HOUR_MILLISECONDS)).toBe(false);
	});

	it("drains ten minutes and gives up thirty seconds before the credentials end", () => {
		const lease = leaseAcquiredAtZero();
		expect(OWNER_CREDENTIAL_DRAIN_BUDGET_SECONDS).toBe(600);
		expect(OWNER_CREDENTIAL_HARD_DEADLINE_MARGIN_SECONDS).toBe(30);
		expect(lease.localDrainAtMilliseconds()).toBe(3000 * SECOND);
		expect(lease.hardDeadlineAtMilliseconds()).toBe(3570 * SECOND);
	});

	it("moves its drain and its deadline with a renewal", () => {
		const lease = leaseAcquiredAtZero();
		lease.beginRenewal();
		lease.succeeded(2400 * SECOND, 6000 * SECOND);
		expect(lease.expiresAt).toBe(6000 * SECOND);
		expect(lease.localDrainAtMilliseconds()).toBe(5400 * SECOND);
		expect(lease.hardDeadlineAtMilliseconds()).toBe(5970 * SECOND);
	});

	it("walks the states of the contract: valid, renewing, expiring, expired, and refused in between", () => {
		const lease = leaseAcquiredAtZero();
		expect(lease.state(0)).toBe("valid");
		expect(lease.state(2399 * SECOND)).toBe("valid");
		expect(lease.state(2400 * SECOND)).toBe("renewing");
		expect(lease.state(2999 * SECOND)).toBe("renewing");
		expect(lease.state(3000 * SECOND)).toBe("expiring");
		expect(lease.state(3599 * SECOND)).toBe("expiring");
		expect(lease.state(3600 * SECOND)).toBe("expired");
		const refused = leaseAcquiredAtZero();
		refused.beginRenewal();
		refused.refuse();
		expect(refused.state(2500 * SECOND)).toBe("refused");
		expect(refused.state(3100 * SECOND)).toBe("expiring");
	});
});

describe("TurnCredentialLease", () => {
	const credentials = (label: string, expiresAt: string) => ({
		aws_credentials: { access_key_id: `key-${label}`, secret_access_key: `secret-${label}`, session_token: `session-${label}`, expires_at: expiresAt },
		gateway_token: `gateway-${label}`,
		expires_at: expiresAt,
	});

	it("answers for its own dispatch only, with the set in force, even past its end", () => {
		const lease = new TurnCredentialLease("dispatch-1", "turn-1", credentials("first", "2026-10-14T13:00:00.000Z"), 0);
		expect(lease.current("dispatch-1")?.gateway_token).toBe("gateway-first");
		expect(lease.current("dispatch-2")).toBeNull();
		lease.replace(credentials("second", "2026-10-14T14:00:00.000Z"));
		expect(lease.current("dispatch-1")?.gateway_token).toBe("gateway-second");
		expect(lease.schedule.expiresAt).toBe(Date.parse("2026-10-14T13:00:00.000Z"));
	});
});
