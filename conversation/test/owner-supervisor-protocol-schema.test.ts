import { describe, expect, it } from "vitest";
import {
	COMPUTER_OWNER_AUDIENCE,
	OWNER_BOOTSTRAP_AUDIENCE,
	OWNER_CHILD_ENVIRONMENT_NAMES,
	OWNER_CHILD_FORBIDDEN_ENVIRONMENT_NAMES,
	OWNER_ERROR_STATUS,
	OWNER_FILE_REQUESTS_PROTOCOL_VERSION,
	OWNER_MAX_LIFETIME_SECONDS,
	OWNER_POLL_INTERACTIVE_MILLISECONDS,
	OWNER_PROTOCOL_VERSION,
	OWNER_POLL_SILENCE_FENCE_SECONDS,
	OWNER_WATCHDOG_KILL_SECONDS,
	OWNER_WATCHDOG_TERMINATE_SECONDS,
	computerOwnerTokenClaimsSchema,
	ownerBootstrapRequestSchema,
	ownerBootstrapResponseSchema,
	ownerBootstrapTokenClaimsSchema,
	ownerCredentialBrokerRequestSchema,
	ownerCredentialBrokerResponseSchema,
	ownerErrorCodeSchema,
	ownerErrorSchema,
	ownerPollRequestSchema,
	ownerPollResponseSchema,
	ownerStopRequestSchema,
	ownerStopResponseSchema,
} from "@chatticus/host-protocol/supervisor";

const credentials = {
	access_key_id: "sample-access-key-id",
	secret_access_key: "sample-secret-value",
	session_token: "sample-session-value",
	expires_at: "2026-10-12T11:00:00.000Z",
};

const dispatch = {
	dispatch_id: "dispatch-1",
	turn_id: "turn-1",
	bot_id: "bot-1",
	channel_id: "channel-1",
	user_id: "ryan",
	action_id: "action-1",
	waiting_since: "2026-10-12T10:00:00.000Z",
	lease_expires_at: "2026-10-12T10:00:30.000Z",
	attempt: 1,
	gateway_token: "sample-gateway-token",
	aws_credentials: credentials,
	expires_at: "2026-10-12T11:00:00.000Z",
};

const poll = {
	owner_id: "owner-1",
	generation: 3,
	protocol_version: 1,
	sequence: 0,
	state: "idle",
	active_turns: [],
};

describe("owner token claims", () => {
	const claims = {
		tenantId: "anthus",
		computerId: "computer-1",
		ownerId: "owner-1",
		startGeneration: 3,
		issuedAtSeconds: 1000,
		expiresAtSeconds: 1300,
	};

	it("accepts the claims of a bootstrap token and of a supervisor token", () => {
		expect(ownerBootstrapTokenClaimsSchema.safeParse({ audience: OWNER_BOOTSTRAP_AUDIENCE, ...claims }).success).toBe(true);
		expect(computerOwnerTokenClaimsSchema.safeParse({ audience: COMPUTER_OWNER_AUDIENCE, ...claims }).success).toBe(true);
	});

	it("names no bot, channel or turn in a supervisor token", () => {
		expect(computerOwnerTokenClaimsSchema.safeParse({ audience: COMPUTER_OWNER_AUDIENCE, ...claims, turnId: "turn-1" }).success).toBe(false);
		expect(computerOwnerTokenClaimsSchema.safeParse({ audience: COMPUTER_OWNER_AUDIENCE, ...claims, botId: "bot-1" }).success).toBe(false);
	});

	it("refuses a token minted for another audience, without a computer or with a zero generation", () => {
		expect(computerOwnerTokenClaimsSchema.safeParse({ audience: OWNER_BOOTSTRAP_AUDIENCE, ...claims }).success).toBe(false);
		expect(ownerBootstrapTokenClaimsSchema.safeParse({ audience: "owner-host", ...claims }).success).toBe(false);
		const { computerId: _removed, ...withoutComputer } = claims;
		expect(computerOwnerTokenClaimsSchema.safeParse({ audience: COMPUTER_OWNER_AUDIENCE, ...withoutComputer }).success).toBe(false);
		expect(computerOwnerTokenClaimsSchema.safeParse({ audience: COMPUTER_OWNER_AUDIENCE, ...claims, startGeneration: 0 }).success).toBe(false);
	});
});

describe("owner bootstrap", () => {
	it("accepts the request and refuses unknown fields, a missing generation and a zero protocol version", () => {
		const request = { owner_id: "owner-1", generation: 3, protocol_version: 1 };
		expect(ownerBootstrapRequestSchema.parse(request)).toEqual(request);
		expect(ownerBootstrapRequestSchema.safeParse({ ...request, token: "x" }).success).toBe(false);
		expect(ownerBootstrapRequestSchema.safeParse({ owner_id: "owner-1", protocol_version: 1 }).success).toBe(false);
		expect(ownerBootstrapRequestSchema.safeParse({ ...request, protocol_version: 0 }).success).toBe(false);
	});

	it("accepts the response and refuses one without credentials or with a malformed expiry", () => {
		const response = {
			computer_id: "computer-1",
			supervisor_token: "sample-claims-token",
			supervisor_token_expires_at: "2026-10-12T11:00:00.000Z",
			aws_credentials: credentials,
		};
		expect(ownerBootstrapResponseSchema.safeParse(response).success).toBe(true);
		const { aws_credentials: _removed, ...withoutCredentials } = response;
		expect(ownerBootstrapResponseSchema.safeParse(withoutCredentials).success).toBe(false);
		expect(ownerBootstrapResponseSchema.safeParse({ ...response, supervisor_token_expires_at: "tomorrow" }).success).toBe(false);
	});
});

describe("owner poll request", () => {
	it("accepts an idle poll, a serving poll with its turn and a poll with memory", () => {
		expect(ownerPollRequestSchema.safeParse(poll).success).toBe(true);
		expect(
			ownerPollRequestSchema.safeParse({ ...poll, state: "serving", active_turns: [{ turn_id: "turn-1", dispatch_id: "dispatch-1" }], memory_used_percent: 71 }).success,
		).toBe(true);
		expect(ownerPollRequestSchema.safeParse({ ...poll, state: "draining", active_turns: [] }).success).toBe(true);
	});

	it("refuses a state that contradicts the active turns", () => {
		const active = [{ turn_id: "turn-1", dispatch_id: "dispatch-1" }];
		expect(ownerPollRequestSchema.safeParse({ ...poll, state: "idle", active_turns: active }).success).toBe(false);
		expect(ownerPollRequestSchema.safeParse({ ...poll, state: "serving", active_turns: [] }).success).toBe(false);
		expect(ownerPollRequestSchema.safeParse({ ...poll, state: "stopping", active_turns: active }).success).toBe(false);
	});

	it("refuses two active turns, an unknown state, a negative sequence, memory over 100 and unknown fields", () => {
		const two = [
			{ turn_id: "turn-1", dispatch_id: "dispatch-1" },
			{ turn_id: "turn-2", dispatch_id: "dispatch-2" },
		];
		expect(ownerPollRequestSchema.safeParse({ ...poll, state: "serving", active_turns: two }).success).toBe(false);
		expect(ownerPollRequestSchema.safeParse({ ...poll, state: "napping" }).success).toBe(false);
		expect(ownerPollRequestSchema.safeParse({ ...poll, sequence: -1 }).success).toBe(false);
		expect(ownerPollRequestSchema.safeParse({ ...poll, memory_used_percent: 101 }).success).toBe(false);
		expect(ownerPollRequestSchema.safeParse({ ...poll, file_requests: [] }).success).toBe(false);
		expect(ownerPollRequestSchema.safeParse({ ...poll, generation: 0 }).success).toBe(false);
	});
});

describe("owner poll response", () => {
	it("accepts an empty answer, an answer with one dispatch and a drain", () => {
		expect(ownerPollResponseSchema.safeParse({ dispatches: [], drain: false, next_poll_ms: 1000 }).success).toBe(true);
		expect(ownerPollResponseSchema.safeParse({ dispatches: [dispatch], drain: false, next_poll_ms: 1000 }).success).toBe(true);
		expect(ownerPollResponseSchema.safeParse({ dispatches: [], drain: true, drain_reason: "lifetime", next_poll_ms: 5000 }).success).toBe(true);
	});

	it("accepts a drain reason a later server invents and fields it adds, so an old owner keeps reading the answer", () => {
		const parsed = ownerPollResponseSchema.parse({ dispatches: [], drain: true, drain_reason: "protocol_version", next_poll_ms: 5000, file_requests: [] });
		expect(parsed.drain_reason).toBe("protocol_version");
	});

	it("refuses two dispatches, a dispatch while draining, a drain without a reason and a reason without a drain", () => {
		expect(ownerPollResponseSchema.safeParse({ dispatches: [dispatch, dispatch], drain: false, next_poll_ms: 1000 }).success).toBe(false);
		expect(ownerPollResponseSchema.safeParse({ dispatches: [dispatch], drain: true, drain_reason: "lifetime", next_poll_ms: 1000 }).success).toBe(false);
		expect(ownerPollResponseSchema.safeParse({ dispatches: [], drain: true, next_poll_ms: 1000 }).success).toBe(false);
		expect(ownerPollResponseSchema.safeParse({ dispatches: [], drain: false, drain_reason: "lifetime", next_poll_ms: 1000 }).success).toBe(false);
	});

	it("refuses a dispatch that lacks its credentials or its gateway token, and an interval outside 250 to 60000 milliseconds", () => {
		const { aws_credentials: _credentials, ...withoutCredentials } = dispatch;
		const { gateway_token: _token, ...withoutToken } = dispatch;
		expect(ownerPollResponseSchema.safeParse({ dispatches: [withoutCredentials], drain: false, next_poll_ms: 1000 }).success).toBe(false);
		expect(ownerPollResponseSchema.safeParse({ dispatches: [withoutToken], drain: false, next_poll_ms: 1000 }).success).toBe(false);
		expect(ownerPollResponseSchema.safeParse({ dispatches: [], drain: false, next_poll_ms: 100 }).success).toBe(false);
		expect(ownerPollResponseSchema.safeParse({ dispatches: [], drain: false, next_poll_ms: 60001 }).success).toBe(false);
	});

	it("defaults file_requests to empty when the answer has none", () => {
		const parsed = ownerPollResponseSchema.parse({ dispatches: [], drain: false, next_poll_ms: 1000 });
		expect(parsed.file_requests).toEqual([]);
	});

	it("carries up to four file requests, also while draining, and refuses a fifth or a malformed one", () => {
		const request = { operation_id: "op-1", path: "/workspace/a.txt", expires_in_ms: 8000, kind: "stat" };
		const base = { dispatches: [], drain: false, next_poll_ms: 1000 };
		expect(ownerPollResponseSchema.parse({ ...base, file_requests: [request, request, request, request] }).file_requests).toHaveLength(4);
		expect(ownerPollResponseSchema.safeParse({ ...base, file_requests: [request, request, request, request, request] }).success).toBe(false);
		expect(ownerPollResponseSchema.safeParse({ ...base, file_requests: [{ ...request, path: "/etc/passwd" }] }).success).toBe(false);
		expect(ownerPollResponseSchema.safeParse({ ...base, file_requests: [{ ...request, kind: "chmod" }] }).success).toBe(false);
		expect(ownerPollResponseSchema.safeParse({ dispatches: [], drain: true, drain_reason: "lifetime", next_poll_ms: 5000, file_requests: [request] }).success).toBe(true);
	});

	it("accepts a field a newer server adds to the answer", () => {
		expect(ownerPollResponseSchema.safeParse({ dispatches: [], drain: false, next_poll_ms: 1000, future_field: 1 }).success).toBe(true);
	});

	it("carries no host token in a dispatch", () => {
		const parsed = ownerPollResponseSchema.parse({ dispatches: [{ ...dispatch, host_token: "sample-host-token" }], drain: false, next_poll_ms: 1000 });
		expect(Object.keys(parsed.dispatches[0] as object)).not.toContain("host_token");
	});
});

describe("owner stop request", () => {
	const request = { owner_id: "owner-1", generation: 3, reason: "idle", active_turns: [] };

	it("accepts each reason the owner may give", () => {
		for (const reason of ["idle", "lifetime", "unhealthy"]) {
			expect(ownerStopRequestSchema.safeParse({ ...request, reason }).success).toBe(true);
		}
	});

	it("refuses a reason the owner may not give, a missing generation and unknown fields", () => {
		expect(ownerStopRequestSchema.safeParse({ ...request, reason: "sigterm" }).success).toBe(false);
		expect(ownerStopRequestSchema.safeParse({ owner_id: "owner-1", reason: "idle", active_turns: [] }).success).toBe(false);
		expect(ownerStopRequestSchema.safeParse({ ...request, force: true }).success).toBe(false);
	});

	it("answers approved or vetoed with a known reason", () => {
		expect(ownerStopResponseSchema.safeParse({ approved: true }).success).toBe(true);
		for (const reason of ["work_pending", "dispatch_pending", "turn_active", "not_draining", "file_operation_pending"]) {
			expect(ownerStopResponseSchema.safeParse({ approved: false, reason }).success).toBe(true);
		}
		expect(ownerStopResponseSchema.safeParse({ approved: false }).success).toBe(false);
		expect(ownerStopResponseSchema.safeParse({ approved: false, reason: "because" }).success).toBe(false);
		expect(ownerStopResponseSchema.safeParse({ approved: "yes" }).success).toBe(false);
	});
});

describe("owner errors", () => {
	it("gives every code exactly one status and the documented ones", () => {
		expect(Object.keys(OWNER_ERROR_STATUS).sort()).toEqual([...ownerErrorCodeSchema.options].sort());
		expect(OWNER_ERROR_STATUS.invalid_credential).toBe(401);
		expect(OWNER_ERROR_STATUS.stale_generation).toBe(403);
		expect(OWNER_ERROR_STATUS.stale_poll).toBe(409);
		expect(OWNER_ERROR_STATUS.bootstrap_already_used).toBe(409);
		expect(OWNER_ERROR_STATUS.invalid_request).toBe(422);
		expect(OWNER_ERROR_STATUS.credentials_unavailable).toBe(503);
		expect(OWNER_ERROR_STATUS.operation_closed).toBe(409);
		expect(OWNER_ERROR_STATUS.overlay_not_sealed).toBe(409);
	});

	it("reads a refusal body with each new file and overlay code", () => {
		for (const code of ["operation_closed", "overlay_not_sealed"]) {
			expect(ownerErrorSchema.safeParse({ detail: "x", code }).success).toBe(true);
		}
	});

	it("fixes the file request protocol version, the interactive pace and an owner protocol version that understands file requests", () => {
		expect(OWNER_FILE_REQUESTS_PROTOCOL_VERSION).toBe(2);
		expect(OWNER_POLL_INTERACTIVE_MILLISECONDS).toBe(1000);
		expect(OWNER_PROTOCOL_VERSION).toBe(2);
	});

	it("reads a refusal body and refuses one without a code", () => {
		expect(ownerErrorSchema.safeParse({ detail: "invalid owner credential", code: "invalid_credential" }).success).toBe(true);
		expect(ownerErrorSchema.safeParse({ detail: "invalid owner credential" }).success).toBe(false);
		expect(ownerErrorSchema.safeParse({ detail: "x", code: "teapot" }).success).toBe(false);
	});
});

describe("owner credential broker", () => {
	const supervisorRequest = {
		version: 1,
		purpose: "supervisor",
		tenant_id: "anthus",
		computer_id: "computer-1",
		owner_id: "owner-1",
		generation: 3,
		authorization: "sample-bootstrap-token",
	};
	const turnRequest = {
		...supervisorRequest,
		purpose: "turn",
		authorization: "sample-supervisor-token",
		turn: { turn_id: "turn-1", bot_id: "bot-1", channel_id: "channel-1" },
	};

	it("accepts a supervisor request and a turn request", () => {
		expect(ownerCredentialBrokerRequestSchema.safeParse(supervisorRequest).success).toBe(true);
		expect(ownerCredentialBrokerRequestSchema.safeParse(turnRequest).success).toBe(true);
	});

	it("refuses a turn request without its turn, a supervisor request with one, another version and no authorization", () => {
		const { turn: _turn, ...withoutTurn } = turnRequest;
		expect(ownerCredentialBrokerRequestSchema.safeParse(withoutTurn).success).toBe(false);
		expect(ownerCredentialBrokerRequestSchema.safeParse({ ...supervisorRequest, turn: turnRequest.turn }).success).toBe(false);
		expect(ownerCredentialBrokerRequestSchema.safeParse({ ...supervisorRequest, version: 2 }).success).toBe(false);
		const { authorization: _authorization, ...withoutAuthorization } = supervisorRequest;
		expect(ownerCredentialBrokerRequestSchema.safeParse(withoutAuthorization).success).toBe(false);
		expect(ownerCredentialBrokerRequestSchema.safeParse({ ...turnRequest, purpose: "everything" }).success).toBe(false);
	});

	it("answers with credentials and a token for the purpose, or with a refusal", () => {
		expect(
			ownerCredentialBrokerResponseSchema.safeParse({
				ok: true,
				purpose: "supervisor",
				aws_credentials: credentials,
				supervisor_token: "sample-supervisor-token",
				supervisor_token_expires_at: "2026-10-12T11:00:00.000Z",
			}).success,
		).toBe(true);
		expect(
			ownerCredentialBrokerResponseSchema.safeParse({
				ok: true,
				purpose: "turn",
				aws_credentials: credentials,
				gateway_token: "sample-gateway-token",
				expires_at: "2026-10-12T11:00:00.000Z",
			}).success,
		).toBe(true);
		expect(ownerCredentialBrokerResponseSchema.safeParse({ ok: false, error: { code: "unsafe_tag_value", message: "the bot id cannot be a tag value" } }).success).toBe(true);
	});

	it("refuses an answer that mixes the purposes or names an unknown refusal", () => {
		expect(
			ownerCredentialBrokerResponseSchema.safeParse({ ok: true, purpose: "turn", aws_credentials: credentials, supervisor_token: "sample-x-token", expires_at: "2026-10-12T11:00:00.000Z" }).success,
		).toBe(false);
		expect(ownerCredentialBrokerResponseSchema.safeParse({ ok: false, error: { code: "teapot", message: "no" } }).success).toBe(false);
	});
});

describe("owner process constants", () => {
	it("keeps the supervisor secrets out of the environment of a child", () => {
		const allowed: readonly string[] = OWNER_CHILD_ENVIRONMENT_NAMES;
		for (const name of OWNER_CHILD_FORBIDDEN_ENVIRONMENT_NAMES) {
			expect(allowed).not.toContain(name);
		}
		expect(new Set(allowed).size).toBe(allowed.length);
	});

	it("orders the lifetime, the watchdog and the poll fence so the graceful path always comes first", () => {
		expect(OWNER_WATCHDOG_TERMINATE_SECONDS).toBe(OWNER_MAX_LIFETIME_SECONDS + 300);
		expect(OWNER_WATCHDOG_KILL_SECONDS).toBeGreaterThan(OWNER_WATCHDOG_TERMINATE_SECONDS);
		expect(OWNER_WATCHDOG_KILL_SECONDS).toBeLessThan(3600);
		expect(OWNER_POLL_SILENCE_FENCE_SECONDS).toBeLessThan(30);
	});
});
