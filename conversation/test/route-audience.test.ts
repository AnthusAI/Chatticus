import { describe, expect, it } from "vitest";
import {
	statusFor,
	CapabilitySinkDenied,
	ChannelTenantMismatchError,
	TurnAccessDeniedError,
	ActorNotInChannelError,
	TaskAccessDeniedError,
	MemberStandingRequiredError,
	TaskNotFoundError,
	StaleAttemptError,
	TurnClaimDeniedError,
	TurnReconcilingError,
	TurnTerminalError,
	TurnNotWaitingError,
	ComputerNotReadyError,
	ChannelNotFoundError,
	TurnNotFoundError,
	OrganizationNotFoundError,
	OrganizationOwnerCapError,
	OrganizationCreationRateLimitedError,
	WaitlistRateLimitedError,
	OrganizationNameTooLongError,
	NotOrganizationOwnerError,
	DomainError,
} from "../src/http/errors.ts";

describe("statusFor error mapping", () => {
	it("maps CapabilitySinkDenied to 403", () => {
		expect(statusFor(new CapabilitySinkDenied("denied"))).toBe(403);
	});

	it("maps ChannelTenantMismatchError to 403", () => {
		expect(statusFor(new ChannelTenantMismatchError("mismatch"))).toBe(403);
	});

	it("maps TurnAccessDeniedError to 403", () => {
		expect(statusFor(new TurnAccessDeniedError("denied"))).toBe(403);
	});

	it("maps ActorNotInChannelError to 403", () => {
		expect(statusFor(new ActorNotInChannelError("not in channel"))).toBe(403);
	});

	it("maps TaskAccessDeniedError to 403", () => {
		expect(statusFor(new TaskAccessDeniedError("denied"))).toBe(403);
	});

	it("maps MemberStandingRequiredError to 403", () => {
		expect(statusFor(new MemberStandingRequiredError("required"))).toBe(403);
	});

	it("maps TaskNotFoundError to 404", () => {
		expect(statusFor(new TaskNotFoundError("not found"))).toBe(404);
	});

	it("maps StaleAttemptError to 409", () => {
		expect(statusFor(new StaleAttemptError("stale"))).toBe(409);
	});

	it("maps TurnClaimDeniedError to 409", () => {
		expect(statusFor(new TurnClaimDeniedError("denied"))).toBe(409);
	});

	it("maps TurnReconcilingError to 409", () => {
		expect(statusFor(new TurnReconcilingError("reconciling"))).toBe(409);
	});

	it("maps TurnTerminalError to 409", () => {
		expect(statusFor(new TurnTerminalError("terminal"))).toBe(409);
	});

	it("maps TurnNotWaitingError to 409", () => {
		expect(statusFor(new TurnNotWaitingError("not waiting"))).toBe(409);
	});

	it("maps ComputerNotReadyError to 409", () => {
		expect(statusFor(new ComputerNotReadyError("not ready"))).toBe(409);
	});

	it("maps ChannelNotFoundError to 404", () => {
		expect(statusFor(new ChannelNotFoundError("not found"))).toBe(404);
	});

	it("maps TurnNotFoundError to 404", () => {
		expect(statusFor(new TurnNotFoundError("not found"))).toBe(404);
	});

	it("maps OrganizationNotFoundError to 404", () => {
		expect(statusFor(new OrganizationNotFoundError("not found"))).toBe(404);
	});

	it("maps OrganizationOwnerCapError to 409", () => {
		expect(statusFor(new OrganizationOwnerCapError("cap exceeded"))).toBe(409);
	});

	it("maps OrganizationCreationRateLimitedError to 429", () => {
		expect(statusFor(new OrganizationCreationRateLimitedError("rate limited"))).toBe(429);
	});

	it("maps WaitlistRateLimitedError to 429", () => {
		expect(statusFor(new WaitlistRateLimitedError("rate limited"))).toBe(429);
	});

	it("maps OrganizationNameTooLongError to 400", () => {
		expect(statusFor(new OrganizationNameTooLongError("too long"))).toBe(400);
	});

	it("maps NotOrganizationOwnerError to 403", () => {
		expect(statusFor(new NotOrganizationOwnerError("not owner"))).toBe(403);
	});

	it("maps unknown DomainError to 400", () => {
		expect(statusFor(new DomainError("custom_error", "some error"))).toBe(400);
	});

	it("maps unknown error to 400", () => {
		expect(statusFor(new Error("generic error"))).toBe(400);
	});

	it("maps null to 400", () => {
		expect(statusFor(null)).toBe(400);
	});
});
