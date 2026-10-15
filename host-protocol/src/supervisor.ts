import { z } from "zod";
import { LIVE_FILE_MAX_REQUESTS_PER_POLL, ownerFileRequestSchema } from "./live-files.ts";

/** The version of the owner supervisor protocol this package describes. The supervisor sends it with every bootstrap and poll. */
export const OWNER_PROTOCOL_VERSION = 3;

/** The first protocol version whose owner understands file_requests in the poll response. */
export const OWNER_FILE_REQUESTS_PROTOCOL_VERSION = 2;

/** Milliseconds between polls while a Files panel is open, in the states that can serve a file request. */
export const OWNER_POLL_INTERACTIVE_MILLISECONDS = 1000;

/** The lowest protocol version the control plane serves: the first owner that renews its own credentials. An owner below it is told to drain with the reason protocol_version. */
export const OWNER_MINIMUM_PROTOCOL_VERSION = 3;

/** The audience of the token that exchanges once for the supervisor token and the supervisor's AWS credentials. */
export const OWNER_BOOTSTRAP_AUDIENCE = "owner-bootstrap";

/** The audience of the supervisor token: it opens the owner routes of one computer and nothing else. */
export const COMPUTER_OWNER_AUDIENCE = "computer-owner";

/** Seconds a bootstrap token lives from the moment the starter signs it. It is also usable only once. */
export const OWNER_BOOTSTRAP_TOKEN_LIFETIME_SECONDS = 300;

/** Seconds a supervisor token, the supervisor's AWS credentials, a per-turn gateway token and per-turn AWS credentials live. One hour is also the longest session either role allows. */
export const OWNER_CREDENTIAL_LIFETIME_SECONDS = 3600;

/** Seconds an offered dispatch holds the turn for its owner before the control plane may offer it again under a new dispatch id. */
export const OWNER_DISPATCH_LEASE_SECONDS = 30;

/** Milliseconds between polls for the first 60 seconds of an idle owner. */
export const OWNER_POLL_FAST_MILLISECONDS = 1000;

/** Milliseconds between polls from 60 seconds until 300 seconds of idleness. */
export const OWNER_POLL_MEDIUM_MILLISECONDS = 3000;

/** Milliseconds between polls after 300 seconds of idleness. Equal to the heartbeat interval of the host worker it replaces. */
export const OWNER_POLL_SLOW_MILLISECONDS = 10000;

/** Milliseconds between polls while the owner serves a turn, drains or stops: nothing can be dispatched, so the poll is only the heartbeat, kept well inside its 30 second window. */
export const OWNER_POLL_BUSY_MILLISECONDS = 5000;

/** Milliseconds between polls while the owner boots, hydrates or publishes. */
export const OWNER_POLL_STARTING_MILLISECONDS = 2000;

/** Seconds of idleness after which the first 1000 millisecond tier ends. */
export const OWNER_POLL_FAST_WINDOW_SECONDS = 60;

/** Seconds of idleness after which the 3000 millisecond tier ends. */
export const OWNER_POLL_MEDIUM_WINDOW_SECONDS = 300;

/** Seconds without work after which a supervisor asks to stop. */
export const OWNER_IDLE_TIMEOUT_SECONDS = 900;

/** Seconds after which a supervisor that was vetoed asks again. */
export const OWNER_STOP_RETRY_SECONDS = 30;

/** Seconds a draining owner gives the turn in hand before it kills the child and stops. */
export const OWNER_DRAIN_GRACE_SECONDS = 300;

/** Seconds of the budget the final publish and the stopped report get after the drain grace. */
export const OWNER_FINAL_PUBLISH_BUDGET_SECONDS = 120;

/** Seconds of a margin the stop sequence keeps before credentials end. */
export const OWNER_LIFETIME_MARGIN_SECONDS = 180;

/** Seconds before the end of the credentials at which an owner must be draining: the grace, the final publish and a margin. */
export const OWNER_CREDENTIAL_DRAIN_BUDGET_SECONDS = OWNER_DRAIN_GRACE_SECONDS + OWNER_FINAL_PUBLISH_BUDGET_SECONDS + OWNER_LIFETIME_MARGIN_SECONDS;

/** Seconds after the bootstrap exchange at which nothing the owner holds is valid: no token, no credential. Eight hours. */
export const OWNER_HARD_LIFETIME_SECONDS = 28800;

/** Seconds from the bootstrap exchange until the control plane drains an owner whose credentials were renewed all the way. */
export const OWNER_MAX_LIFETIME_SECONDS = OWNER_HARD_LIFETIME_SECONDS - OWNER_CREDENTIAL_DRAIN_BUDGET_SECONDS;

/** The shortest session STS issues; the broker issues nothing in the last this many seconds of the hard lifetime. */
export const OWNER_BROKER_MINIMUM_SESSION_SECONDS = 900;

/** Seconds after the bootstrap exchange from which no renewal is granted and no dispatch is offered. */
export const OWNER_ISSUANCE_CUTOFF_SECONDS = OWNER_HARD_LIFETIME_SECONDS - OWNER_BROKER_MINIMUM_SESSION_SECONDS;

/** Seconds of remaining credentials at which the supervisor starts asking for new ones. */
export const OWNER_CREDENTIAL_RENEWAL_MARGIN_SECONDS = 1200;

/** Seconds that must pass between two renewals of the same kind for one owner. */
export const OWNER_CREDENTIAL_RENEWAL_MINIMUM_INTERVAL_SECONDS = 60;

/** Pauses, in seconds, between the attempts of a renewal that fails; the last repeats. */
export const OWNER_CREDENTIAL_RENEWAL_RETRY_SECONDS = [15, 30, 60] as const;

/** Seconds before its credentials end at which a supervisor kills everything and exits. */
export const OWNER_CREDENTIAL_HARD_DEADLINE_MARGIN_SECONDS = 30;

/** Where the supervisor listens for its child. A filesystem socket inside a directory only root can enter. */
export const OWNER_SUPERVISOR_SOCKET_PATH = "/run/chatticus/supervisor.sock";

/** Seconds without a successful poll after which the supervisor fences itself. Below the 30 second window in which the control plane still counts it as the live owner. */
export const OWNER_POLL_SILENCE_FENCE_SECONDS = 25;

/** Consecutive child exits with a code other than 0 and 1 (or a signal) after which the supervisor asks to stop as unhealthy. */
export const OWNER_CHILD_FAILURE_LIMIT = 3;

/** Seconds after the last child exit before a changed disk is published (the quiet publish). */
export const OWNER_QUIET_PUBLISH_SECONDS = 30;

/** Seconds between publishes of a changed disk while the owner is idle. */
export const OWNER_PERIODIC_PUBLISH_SECONDS = 600;

/** Seconds from its own start after which the watchdog process sends SIGTERM to the supervisor. */
export const OWNER_WATCHDOG_TERMINATE_SECONDS = OWNER_MAX_LIFETIME_SECONDS + OWNER_DRAIN_GRACE_SECONDS;

/** Seconds from its own start after which the watchdog process sends SIGKILL to the supervisor. */
export const OWNER_WATCHDOG_KILL_SECONDS = OWNER_WATCHDOG_TERMINATE_SECONDS + OWNER_FINAL_PUBLISH_BUDGET_SECONDS;

/** Seconds the liveness file of the supervisor may go without an update before the watchdog kills it. */
export const OWNER_WATCHDOG_STALE_SECONDS = 180;

/** Seconds between the checks of the watchdog. */
export const OWNER_WATCHDOG_CHECK_SECONDS = 15;

/** The wire version of the request the control plane sends to the OwnerCredentialBroker. */
export const OWNER_BROKER_VERSION = 1;

/** The environment variable names the supervisor starts a per-turn child with, and no others. */
export const OWNER_CHILD_ENVIRONMENT_NAMES = [
	"PATH",
	"HOME",
	"CHATTICUS_TENANT_ID",
	"CHATTICUS_USER_ID",
	"CHATTICUS_OWNER_ID",
	"CHATTICUS_OWNER_START_GENERATION",
	"CHATTICUS_DISPATCH_ID",
	"CHATTICUS_TAKEOVER_TURN_ID",
	"CHATTICUS_TAKEOVER_BOT_ID",
	"CHATTICUS_MESSAGING_TABLE",
	"CHATTICUS_CONVERSATIONS_TABLE",
	"CHATTICUS_PI_SESSIONS_BUCKET",
	"CHATTICUS_ENVIRONMENT",
	"CHATTICUS_MODEL_GATEWAY_URL",
	"CHATTICUS_SUPERVISOR_SOCKET",
	"CHATTICUS_WORKSPACE_ROOT",
	"CHATTICUS_SHELL_LAUNCHER",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
] as const;

/** The names a per-turn child must never hold: they belong to the supervisor alone. */
export const OWNER_CHILD_FORBIDDEN_ENVIRONMENT_NAMES = [
	"CHATTICUS_OWNER_BOOTSTRAP_TOKEN",
	"CHATTICUS_SUPERVISOR_TOKEN",
	"CHATTICUS_FRONT_DOOR_URL",
	"CHATTICUS_SNAPSHOT_BUCKET",
	"CHATTICUS_LIVE_ROOT",
	"CHATTICUS_INVOKE_KEY",
	"CHATTICUS_OWNER_HOST_TOKEN",
	"OPENAI_API_KEY",
	"CHATTICUS_MODEL_GATEWAY_TOKEN",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
] as const;

const identifier = z.string().min(1).max(256);
const generation = z.number().int().positive();
const timestamp = z.iso.datetime();

/** Where an owner is in its life, as the supervisor reports it with every poll. */
export const ownerStateSchema = z.enum(["booting", "hydrating", "idle", "publishing", "serving", "draining", "stopping"]);

/** The temporary AWS credentials of one role session. */
export const awsCredentialsSchema = z.object({
	access_key_id: z.string().min(1),
	secret_access_key: z.string().min(1),
	session_token: z.string().min(1),
	expires_at: timestamp,
});

/** The turn a supervisor currently serves: the turn and the dispatch that delivered it. */
export const ownerActiveTurnSchema = z.object({ turn_id: identifier, dispatch_id: identifier }).strict();

/** Why a control plane refused an owner route. Each code has one status in {@link OWNER_ERROR_STATUS}. */
export const ownerErrorCodeSchema = z.enum([
	"invalid_credential",
	"wrong_organization",
	"credential_mismatch",
	"stale_generation",
	"not_current_owner",
	"owner_not_registered",
	"stale_poll",
	"bootstrap_already_used",
	"invalid_request",
	"credentials_unavailable",
	"operation_closed",
	"overlay_not_sealed",
	"owner_draining",
	"owner_stopping",
	"renewal_too_soon",
	"turn_not_served",
]);

/** The status of each owner error code. */
export const OWNER_ERROR_STATUS: Readonly<Record<z.infer<typeof ownerErrorCodeSchema>, 401 | 403 | 409 | 422 | 429 | 503>> = {
	invalid_credential: 401,
	wrong_organization: 403,
	credential_mismatch: 403,
	stale_generation: 403,
	not_current_owner: 403,
	owner_not_registered: 403,
	stale_poll: 409,
	bootstrap_already_used: 409,
	invalid_request: 422,
	credentials_unavailable: 503,
	operation_closed: 409,
	overlay_not_sealed: 409,
	owner_draining: 409,
	owner_stopping: 409,
	renewal_too_soon: 429,
	turn_not_served: 409,
};

/** The body of every refusal of an owner route. */
export const ownerErrorSchema = z.object({ detail: z.string(), code: ownerErrorCodeSchema });

/** The claims of the bootstrap token the starter signs: one owner of one computer start generation, for five minutes, once. */
export const ownerBootstrapTokenClaimsSchema = z
	.object({
		audience: z.literal(OWNER_BOOTSTRAP_AUDIENCE),
		tenantId: identifier,
		computerId: identifier,
		ownerId: identifier,
		startGeneration: generation,
		issuedAtSeconds: z.number().int().nonnegative(),
		expiresAtSeconds: z.number().int().positive(),
	})
	.strict();

/** The claims of the supervisor token. It names no bot, channel or turn: the supervisor serves the whole organization computer. */
export const computerOwnerTokenClaimsSchema = z
	.object({
		audience: z.literal(COMPUTER_OWNER_AUDIENCE),
		tenantId: identifier,
		computerId: identifier,
		ownerId: identifier,
		startGeneration: generation,
		/** When the owner's bootstrap exchange was granted, in seconds since the epoch; every renewal keeps it, and the broker ends every credential by this plus the hard lifetime. */
		ownerStartedAtSeconds: z.number().int().positive(),
		issuedAtSeconds: z.number().int().nonnegative(),
		expiresAtSeconds: z.number().int().positive(),
	})
	.strict();

/** POST /orgs/{tenant}/host/owner/bootstrap: the supervisor says who it is and exchanges its bootstrap token. */
export const ownerBootstrapRequestSchema = z
	.object({
		owner_id: identifier,
		generation,
		protocol_version: z.number().int().positive(),
	})
	.strict();

/** The answer of the bootstrap exchange: the supervisor token and the credentials of the supervisor role. */
export const ownerBootstrapResponseSchema = z.object({
	computer_id: identifier,
	supervisor_token: z.string().min(1),
	supervisor_token_expires_at: timestamp,
	aws_credentials: awsCredentialsSchema,
});

const quietStates: ReadonlySet<string> = new Set(["booting", "hydrating", "idle", "publishing", "stopping"]);

/** POST /orgs/{tenant}/host/owner/poll: the supervisor is alive, says what it is doing and asks for work. */
export const ownerPollRequestSchema = z
	.object({
		owner_id: identifier,
		generation,
		protocol_version: z.number().int().positive(),
		sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		state: ownerStateSchema,
		active_turns: z.array(ownerActiveTurnSchema).max(1),
		memory_used_percent: z.number().int().min(0).max(100).optional(),
	})
	.strict()
	.refine((body) => !quietStates.has(body.state) || body.active_turns.length === 0, {
		message: "booting, hydrating, idle, publishing and stopping report no active turn",
	})
	.refine((body) => body.state !== "serving" || body.active_turns.length === 1, {
		message: "serving reports exactly one active turn",
	});

/** One turn the control plane hands to the supervisor, with everything the per-turn child needs. */
export const ownerDispatchSchema = z.object({
	dispatch_id: identifier,
	turn_id: identifier,
	bot_id: identifier,
	channel_id: identifier,
	user_id: identifier,
	action_id: identifier,
	waiting_since: timestamp.nullable(),
	lease_expires_at: timestamp,
	attempt: z.number().int().positive(),
	gateway_token: z.string().min(1),
	aws_credentials: awsCredentialsSchema,
	expires_at: timestamp,
});

/** The answer of the poll: at most one dispatch, whether to drain, and when to poll next. */
export const ownerPollResponseSchema = z
	.object({
		dispatches: z.array(ownerDispatchSchema).max(1),
		file_requests: z.array(ownerFileRequestSchema).max(LIVE_FILE_MAX_REQUESTS_PER_POLL).default([]),
		drain: z.boolean(),
		drain_reason: z.string().min(1).optional(),
		next_poll_ms: z.number().int().min(250).max(60000),
	})
	.refine((body) => body.drain === (body.drain_reason !== undefined), {
		message: "drain_reason is present exactly when drain is true",
	})
	.refine((body) => !body.drain || body.dispatches.length === 0, {
		message: "a draining owner is offered no dispatch",
	});

/** Why a supervisor asks to stop: no work for the idle timeout, the drain the control plane ordered at the maximum lifetime, the owner's own failure, or credentials it could not renew (always approved). */
export const ownerStopReasonSchema = z.enum(["idle", "lifetime", "unhealthy", "credentials"]);

/** POST /orgs/{tenant}/host/owner/credentials: the supervisor asks for the next set of credentials, its own or its turn's. */
export const ownerCredentialsRequestSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("supervisor"), owner_id: identifier, generation }).strict(),
	z
		.object({ kind: z.literal("turn"), owner_id: identifier, generation, dispatch_id: identifier, turn_id: identifier })
		.strict(),
]);

/** The next set. Both kinds end their token and their credentials at the same moment, never later than the owner's hard end. */
export const ownerCredentialsResponseSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("supervisor"),
		supervisor_token: z.string().min(1),
		supervisor_token_expires_at: timestamp,
		aws_credentials: awsCredentialsSchema,
	}),
	z.object({
		kind: z.literal("turn"),
		dispatch_id: identifier,
		turn_id: identifier,
		gateway_token: z.string().min(1),
		aws_credentials: awsCredentialsSchema,
		expires_at: timestamp,
	}),
]);

/** What the per-turn child asks its supervisor for over the local socket. The dispatch id is the one in its environment. */
export const ownerSocketRequestSchema = z.object({ v: z.literal(1), op: z.literal("turn_credentials"), dispatch_id: identifier }).strict();

/** What the supervisor answers over the local socket: the active turn's credentials, or a refusal that carries no secret. */
export const ownerSocketResponseSchema = z.union([
	z.object({ ok: z.literal(true), aws_credentials: awsCredentialsSchema, gateway_token: z.string().min(1), expires_at: timestamp }),
	z.object({ ok: z.literal(false), code: z.enum(["no_turn", "expired"]) }),
]);

/** POST /orgs/{tenant}/host/owner/stop-request: the supervisor asks whether it may stop. */
export const ownerStopRequestSchema = z
	.object({
		owner_id: identifier,
		generation,
		reason: ownerStopReasonSchema,
		active_turns: z.array(ownerActiveTurnSchema).max(1),
	})
	.strict();

/** Why the control plane vetoed a stop. */
export const ownerStopVetoReasonSchema = z.enum(["work_pending", "dispatch_pending", "turn_active", "not_draining", "file_operation_pending"]);

/** The answer of the stop request: approved, or vetoed with the reason. A veto is a 200, not an error. */
export const ownerStopResponseSchema = z.discriminatedUnion("approved", [
	z.object({ approved: z.literal(true) }),
	z.object({ approved: z.literal(false), reason: ownerStopVetoReasonSchema }),
]);

const brokerBase = {
	version: z.literal(OWNER_BROKER_VERSION),
	tenant_id: identifier,
	computer_id: identifier,
	owner_id: identifier,
	generation,
	authorization: z.string().min(1),
};

/**
 * The payload the Front Door sends to the OwnerCredentialBroker. The authorization is the token the broker verifies with the
 * signing key and whose claims must equal the other fields: the bootstrap token for `supervisor`, the supervisor token for `turn`.
 */
export const ownerCredentialBrokerRequestSchema = z.discriminatedUnion("purpose", [
	z.object({ ...brokerBase, purpose: z.literal("supervisor") }).strict(),
	z.object({ ...brokerBase, purpose: z.literal("supervisor_renewal") }).strict(),
	z
		.object({
			...brokerBase,
			purpose: z.literal("turn"),
			turn: z.object({ turn_id: identifier, bot_id: identifier, channel_id: identifier }).strict(),
		})
		.strict(),
]);

/** Why the broker issued nothing. The message never carries a token, a key or a credential. */
export const ownerCredentialBrokerErrorCodeSchema = z.enum([
	"invalid_request",
	"unsafe_tag_value",
	"invalid_authorization",
	"authorization_mismatch",
	"assume_role_failed",
	"signing_key_unavailable",
	"owner_lifetime_over",
]);

/** What the broker answers: the credentials of the role it assumed and the token it signed, or a refusal. */
export const ownerCredentialBrokerResponseSchema = z.union([
	z.object({
		ok: z.literal(true),
		purpose: z.literal("supervisor"),
		aws_credentials: awsCredentialsSchema,
		supervisor_token: z.string().min(1),
		supervisor_token_expires_at: timestamp,
	}),
	z.object({
		ok: z.literal(true),
		purpose: z.literal("supervisor_renewal"),
		aws_credentials: awsCredentialsSchema,
		supervisor_token: z.string().min(1),
		supervisor_token_expires_at: timestamp,
	}),
	z.object({
		ok: z.literal(true),
		purpose: z.literal("turn"),
		aws_credentials: awsCredentialsSchema,
		gateway_token: z.string().min(1),
		expires_at: timestamp,
	}),
	z.object({
		ok: z.literal(false),
		error: z.object({ code: ownerCredentialBrokerErrorCodeSchema, message: z.string() }),
	}),
]);

export type OwnerState = z.infer<typeof ownerStateSchema>;
export type AwsCredentials = z.infer<typeof awsCredentialsSchema>;
export type OwnerActiveTurn = z.infer<typeof ownerActiveTurnSchema>;
export type OwnerErrorCode = z.infer<typeof ownerErrorCodeSchema>;
export type OwnerError = z.infer<typeof ownerErrorSchema>;
export type OwnerBootstrapTokenClaims = z.infer<typeof ownerBootstrapTokenClaimsSchema>;
export type ComputerOwnerTokenClaims = z.infer<typeof computerOwnerTokenClaimsSchema>;
export type OwnerBootstrapRequest = z.infer<typeof ownerBootstrapRequestSchema>;
export type OwnerBootstrapResponse = z.infer<typeof ownerBootstrapResponseSchema>;
export type OwnerPollRequest = z.infer<typeof ownerPollRequestSchema>;
export type OwnerDispatch = z.infer<typeof ownerDispatchSchema>;
export type OwnerPollResponse = z.infer<typeof ownerPollResponseSchema>;
export type OwnerCredentialsRequest = z.infer<typeof ownerCredentialsRequestSchema>;
export type OwnerCredentialsResponse = z.infer<typeof ownerCredentialsResponseSchema>;
export type OwnerSocketRequest = z.infer<typeof ownerSocketRequestSchema>;
export type OwnerSocketResponse = z.infer<typeof ownerSocketResponseSchema>;
export type OwnerStopReason =z.infer<typeof ownerStopReasonSchema>;
export type OwnerStopRequest = z.infer<typeof ownerStopRequestSchema>;
export type OwnerStopVetoReason = z.infer<typeof ownerStopVetoReasonSchema>;
export type OwnerStopResponse = z.infer<typeof ownerStopResponseSchema>;
export type OwnerCredentialBrokerRequest = z.infer<typeof ownerCredentialBrokerRequestSchema>;
export type OwnerCredentialBrokerErrorCode = z.infer<typeof ownerCredentialBrokerErrorCodeSchema>;
export type OwnerCredentialBrokerResponse = z.infer<typeof ownerCredentialBrokerResponseSchema>;
