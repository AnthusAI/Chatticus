import { Hono } from "hono";
import { statusFor, DomainError } from "./errors.ts";
import { timingSafeEqual } from "crypto";
import type { IdTokenVerifier } from "../auth/cognito.ts";
import {
	INTEGRATION_TEST_SESSION_PATH,
	integrationTestSessionEnabled,
	type IntegrationTestAuthConfig,
} from "../auth/integration-test.ts";
import type { SignupMode } from "../domain/signup-mode.ts";
import { ORGANIZATION_CREATION_RATE_LIMIT } from "../domain/creation-limits.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import { PrincipalHttpError } from "../auth/principal.ts";
import { declareRoute } from "./route-audience.ts";
import type { BudgetRollupReader } from "../domain/organization-spend.ts";
import { setMonthlyAwsSpendCeilingHandler } from "./routes/spend-ceiling.ts";
import { AwsCrossAccountRoleInspector, type CrossAccountRoleInspector } from "../computer/provisioning.ts";
import { submitSelfSetupCrossAccountRoleHandler } from "./routes/self-setup.ts";
import { getMeHandler } from "./routes/me.ts";
import { createOrganizationHandler } from "./routes/organizations.ts";
import { createInvitationHandler, createInvitationMembershipCache } from "./routes/invitations.ts";
import { createBotHandler, getBotHandler, listUserBotsHandler, lookupBotHandler } from "./routes/bots.ts";
import { createChannelHandler, getChannelHandler, listUserChannelsHandler } from "./routes/channels.ts";
import { listChannelMessagesHandler, postChannelMessageHandler } from "./routes/messages.ts";
import { createUserTaskHandler, getTaskHandler, listUserTasksHandler, patchTaskHandler } from "./routes/tasks.ts";
import { postVoiceMessageHandler } from "./routes/voice-messages.ts";
import type { VendorLedgerDependencies } from "../ledger/vendor-ledger.ts";
import type { UserUnderstanding } from "../voice/understanding.ts";
import type { MessageDependencies } from "../domain/messages.ts";
import type { TurnControlStore } from "../domain/turns.ts";
import {
	getChannelLatestTurnHandler,
	getChannelTurnHandler,
	getTurnHandler,
	listTurnEventsHandler,
} from "./routes/turns.ts";
import { putTurnGrantHandler } from "./routes/grants.ts";
import type { PolicyStore } from "../store/policy-store.ts";
import { OpenStreamCounter, streamTurnHandler } from "./routes/turn-stream.ts";
import { DEFAULT_STREAM_TIMING, type StreamClock, type StreamTiming, wallStreamClock } from "./stream.ts";
import { integrationTestSessionHandler } from "./routes/integration-test.ts";
import { operatorOrganizationHandler } from "./routes/operator.ts";
import { registerWorkerHandler } from "./routes/workers.ts";
import { getComputerHandler, resumeTurnHandler } from "./routes/computers.ts";
import {
	hostActionResultHandler,
	hostClaimActionHandler,
	hostComputerStateHandler,
	hostGetComputerHandler,
	hostHeartbeatHandler,
	hostRegateActionHandler,
	hostRenewActionHandler,
	hostSnapshotHydratedHandler,
	hostSnapshotPublishedHandler,
} from "./host.ts";
import type { ComputerHandoffDependencies } from "../turn/park.ts";
import { createUserMembershipCache } from "./user-principal.ts";
import { WRITE_GATE_MESSAGE, WRITE_GATE_RETRY_AFTER_SECONDS, type WriteGate } from "../migration/migration-state.ts";

export interface Clock {
	now(): Date;
}

export interface IdSource {
	next(): string;
}

const INVOKE_HEADER = "X-Chatticus-Invoke-Key";
const TENANT_HEADER = "X-Tenant-Id";

/**
 * Dependencies required to create an HTTP application.
 */
export interface AppDeps {
	clock: Clock;
	ids: IdSource;
	store: unknown;
	/** Message admission and listing, behind the routes under /channels/{id}/messages. */
	messages: Omit<MessageDependencies, "store" | "ids" | "clock">;
	/** The understand-the-user step and the ledger its spend is recorded in, behind POST .../voice-messages. */
	voice: { understanding: UserUnderstanding; ledger: VendorLedgerDependencies };
	/** The turn control record, behind the turn read routes. */
	turnControl: TurnControlStore;
	/** Member standing ceilings, read when a member replaces a turn's grant. */
	policy: PolicyStore;
	/** The computer handoff: actions, start jobs and the spend pause, behind the resume and host action routes. */
	computer: ComputerHandoffDependencies;
	/** The month-to-date rollup rows the spend ceiling pause reads; the budget environment is `environment`. */
	budgetRollups: BudgetRollupReader;
	invokeKey: string | null;
	/** While the transcript migration holds the gate closed, every write route answers 503; reads are unaffected. */
	writeGate?: WriteGate;
	/** The deployment-wide operator bearer secret; the operator routes refuse every caller when it is empty. */
	operatorKey?: string;
	/** Inspects a customer's cross-account role at self-setup; defaults to the live STS and IAM inspector. */
	roleInspector?: CrossAccountRoleInspector;
	/** Integration-test session exchange; its route is registered only when this is enabled outside production. */
	integrationTest?: IntegrationTestAuthConfig | null;
	environment?: string;
	verifier?: IdTokenVerifier | null;
	signupMode?: SignupMode;
	organizationCreationRateLimit?: number;
	/** How the turn stream paces its reads, heartbeats, gives up and ends; defaults to the design's pacing. */
	streamTiming?: StreamTiming;
	/** The time source of turn streams; defaults to the wall clock. */
	streamClock?: StreamClock;
	/** Counts the turn streams open right now; defaults to a private counter. */
	openStreams?: OpenStreamCounter;
}

/**
 * Create a Hono application with the control plane foundation: error mapping,
 * invoke key verification, and health reporting.
 */
export function createApp(deps: AppDeps): Hono {
	const app = new Hono();

	const environment = deps.environment || process.env.CHATTICUS_ENVIRONMENT || "local";

	app.use(async (c, next) => {
		if (c.req.path === "/health") {
			return next();
		}
		const tenantId = c.req.header(TENANT_HEADER);
		if (tenantId) {
			return c.json(
				{
					detail: `${TENANT_HEADER} is not accepted; use /orgs/{tenant_id}/... in the request path.`,
				},
				400 as any,
			);
		}
		return next();
	});

	app.use(async (c, next) => {
		if (c.req.path === "/health") {
			return next();
		}
		if (deps.invokeKey) {
			const provided = c.req.header(INVOKE_HEADER);
			if (!provided || !timingSafeEqual(Buffer.from(provided), Buffer.from(deps.invokeKey))) {
				return c.json(
					{
						detail: "invoke key required",
					},
					403 as any,
				);
			}
		}
		return next();
	});

	const writeGate = deps.writeGate ?? null;
	app.use(async (c, next) => {
		if (writeGate === null || c.req.path === "/health" || ["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
			return next();
		}
		if (await writeGate.isClosed()) {
			c.header("Retry-After", String(WRITE_GATE_RETRY_AFTER_SECONDS));
			return c.json({ detail: WRITE_GATE_MESSAGE }, 503 as any);
		}
		return next();
	});

	app.onError((err, c) => {
		if (err instanceof DomainError) {
			const status = statusFor(err);
			return c.json({ detail: err.message }, status as any);
		}
		if (err instanceof PrincipalHttpError) {
			return c.json({ detail: err.detail }, err.status as any);
		}
		throw err;
	});

	app.get("/health", (c) => {
		return c.json({
			status: "ok",
			environment,
		});
	});

	const store = deps.store as MessagingStore;
	const verifier = deps.verifier ?? null;
	const membershipCache = createInvitationMembershipCache(deps.clock);
	const integrationTest = deps.integrationTest ?? null;
	const operatorKey = deps.operatorKey ?? "";

	declareRoute(app, { method: "GET", path: "/me", audience: "user" }, (c) =>
		getMeHandler(c, { store, clock: deps.clock, ids: deps.ids, verifier, rollups: deps.budgetRollups, environment }),
	);

	declareRoute(app, { method: "POST", path: "/organizations", audience: "user" }, (c) =>
		createOrganizationHandler(c, {
			store,
			clock: deps.clock,
			ids: deps.ids,
			verifier,
			signupMode: deps.signupMode ?? "invitation_only",
			organizationCreationRateLimit: deps.organizationCreationRateLimit ?? ORGANIZATION_CREATION_RATE_LIMIT,
		}),
	);

	declareRoute(app, { method: "POST", path: "/orgs/:tenant_id/invitations", audience: "user" }, (c) =>
		createInvitationHandler(c, { store, clock: deps.clock, ids: deps.ids, verifier, membershipCache, integrationTest }),
	);

	const userRoutes = {
		store,
		ids: deps.ids,
		verifier,
		membershipCache: createUserMembershipCache(deps.clock),
		integrationTest,
	};

	const taskRoutes = { ...userRoutes };

	const messageRoutes = {
		...userRoutes,
		messages: { ...deps.messages, store, ids: deps.ids, clock: deps.clock } satisfies MessageDependencies,
	};

	declareRoute(app, { method: "PATCH", path: "/orgs/:tenant_id/monthly-aws-spend-ceiling", audience: "user" }, (c) =>
		setMonthlyAwsSpendCeilingHandler(c, userRoutes),
	);

	const roleInspector = deps.roleInspector ?? new AwsCrossAccountRoleInspector();
	declareRoute(app, { method: "POST", path: "/orgs/:tenant_id/self-setup/cross-account-role", audience: "user" }, (c) =>
		submitSelfSetupCrossAccountRoleHandler(c, { ...userRoutes, roleInspector }),
	);

	declareRoute(app, { method: "POST", path: "/orgs/:tenant_id/bots", audience: "user" }, (c) =>
		createBotHandler(c, userRoutes),
	);
	declareRoute(app, { method: "GET", path: "/orgs/:tenant_id/bots", audience: "user" }, (c) =>
		lookupBotHandler(c, userRoutes),
	);
	declareRoute(app, { method: "GET", path: "/orgs/:tenant_id/bots/:bot_id", audience: "user" }, (c) =>
		getBotHandler(c, userRoutes),
	);
	declareRoute(app, { method: "GET", path: "/orgs/:tenant_id/users/:user_id/bots", audience: "user" }, (c) =>
		listUserBotsHandler(c, userRoutes),
	);
	declareRoute(app, { method: "GET", path: "/orgs/:tenant_id/users/:user_id/channels", audience: "user" }, (c) =>
		listUserChannelsHandler(c, userRoutes),
	);
	declareRoute(app, { method: "POST", path: "/orgs/:tenant_id/channels", audience: "user" }, (c) =>
		createChannelHandler(c, userRoutes),
	);
	declareRoute(app, { method: "GET", path: "/orgs/:tenant_id/channels/:channel_id", audience: "user" }, (c) =>
		getChannelHandler(c, userRoutes),
	);
	declareRoute(app, { method: "POST", path: "/orgs/:tenant_id/channels/:channel_id/messages", audience: "user" }, (c) =>
		postChannelMessageHandler(c, messageRoutes),
	);
	declareRoute(app, { method: "GET", path: "/orgs/:tenant_id/channels/:channel_id/messages", audience: "user" }, (c) =>
		listChannelMessagesHandler(c, messageRoutes),
	);

	declareRoute(app, { method: "GET", path: "/orgs/:tenant_id/users/:user_id/tasks", audience: "user" }, (c) =>
		listUserTasksHandler(c, taskRoutes),
	);
	declareRoute(app, { method: "POST", path: "/orgs/:tenant_id/users/:user_id/tasks", audience: "user" }, (c) =>
		createUserTaskHandler(c, taskRoutes),
	);
	declareRoute(app, { method: "GET", path: "/orgs/:tenant_id/tasks/:task_id", audience: "user" }, (c) =>
		getTaskHandler(c, taskRoutes),
	);
	declareRoute(app, { method: "PATCH", path: "/orgs/:tenant_id/tasks/:task_id", audience: "user" }, (c) =>
		patchTaskHandler(c, taskRoutes),
	);

	declareRoute(app, { method: "POST", path: "/orgs/:tenant_id/channels/:channel_id/voice-messages", audience: "user" }, (c) =>
		postVoiceMessageHandler(c, { ...messageRoutes, voice: { ...deps.voice, messages: messageRoutes.messages } }),
	);

	const turnRoutes = {
		...userRoutes,
		turns: { store: deps.turnControl, clock: deps.clock, ids: deps.ids },
	};

	const openStreams = deps.openStreams ?? new OpenStreamCounter();

	declareRoute(app, { method: "GET", path: "/orgs/:tenant_id/channels/:channel_id/turn", audience: "user" }, (c) =>
		getChannelTurnHandler(c, turnRoutes),
	);
	declareRoute(app, { method: "GET", path: "/orgs/:tenant_id/channels/:channel_id/turns/latest", audience: "user" }, (c) =>
		getChannelLatestTurnHandler(c, turnRoutes),
	);
	declareRoute(app, { method: "GET", path: "/orgs/:tenant_id/turns/:turn_id", audience: "user" }, (c) =>
		getTurnHandler(c, turnRoutes),
	);
	declareRoute(app, { method: "GET", path: "/orgs/:tenant_id/turns/:turn_id/events", audience: "user" }, (c) =>
		listTurnEventsHandler(c, turnRoutes),
	);
	declareRoute(app, { method: "GET", path: "/orgs/:tenant_id/turns/:turn_id/stream", audience: "user" }, (c) =>
		streamTurnHandler(c, {
			...turnRoutes,
			streamTiming: deps.streamTiming ?? DEFAULT_STREAM_TIMING,
			streamClock: deps.streamClock ?? wallStreamClock,
			openStreams,
		}),
	);

	declareRoute(app, { method: "PUT", path: "/orgs/:tenant_id/turns/:turn_id/grant", audience: "user" }, (c) =>
		putTurnGrantHandler(c, { ...turnRoutes, store, policyStore: deps.policy }),
	);

	const computerRoutes = {
		...userRoutes,
		park: {
			turns: turnRoutes.turns,
			messaging: store,
			turnRuns: deps.messages.turnRuns,
			turnProbes: deps.messages.turnProbes,
			computer: deps.computer,
			faults: deps.messages.faults,
		},
	};

	declareRoute(app, { method: "GET", path: "/orgs/:tenant_id/computer", audience: "user" }, (c) =>
		getComputerHandler(c, computerRoutes),
	);
	declareRoute(app, { method: "GET", path: "/orgs/:tenant_id/users/:user_id/computer", audience: "user" }, (c) =>
		getComputerHandler(c, computerRoutes),
	);
	declareRoute(app, { method: "POST", path: "/orgs/:tenant_id/turns/:turn_id/resume", audience: "user" }, (c) =>
		resumeTurnHandler(c, computerRoutes),
	);

	const workerRoutes = { store, clock: deps.clock, ids: deps.ids };

	declareRoute(app, { method: "POST", path: "/orgs/:tenant_id/workers/register", audience: "public" }, (c) =>
		registerWorkerHandler(c, workerRoutes),
	);
	const hostRoutes = {
		store,
		clock: deps.clock,
		ids: deps.ids,
		park: computerRoutes.park,
		policyStore: deps.policy,
	};
	const hostPaths = [
		["GET", "/computer", hostGetComputerHandler],
		["POST", "/computer/state", hostComputerStateHandler],
		["POST", "/snapshot/hydrated", hostSnapshotHydratedHandler],
		["POST", "/snapshot/published", hostSnapshotPublishedHandler],
		["POST", "/actions/claim", hostClaimActionHandler],
		["POST", "/actions/:action_id/renew", hostRenewActionHandler],
		["POST", "/actions/:action_id/result", hostActionResultHandler],
		["POST", "/actions/:action_id/regate", hostRegateActionHandler],
		["POST", "/heartbeat", hostHeartbeatHandler],
	] as const;
	for (const [method, path, handler] of hostPaths) {
		declareRoute(app, { method, path: `/orgs/:tenant_id/host${path}`, audience: "worker" }, (c) => handler(c, hostRoutes));
	}

	for (const action of ["enable", "suspend", "reinstate"] as const) {
		declareRoute(app, { method: "POST", path: `/operator/orgs/:tenant_id/${action}`, audience: "operator" }, (c) =>
			operatorOrganizationHandler(c, action, { store, operatorKey }),
		);
	}

	if (integrationTestSessionEnabled(integrationTest) && integrationTest !== null) {
		declareRoute(app, { method: "POST", path: INTEGRATION_TEST_SESSION_PATH, audience: "integration" }, (c) =>
			integrationTestSessionHandler(c, integrationTest),
		);
	}

	return app;
}
