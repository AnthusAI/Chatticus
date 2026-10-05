import { Hono } from "hono";
import { statusFor, DomainError } from "./errors.ts";
import { timingSafeEqual } from "crypto";
import type { IdTokenVerifier } from "../auth/cognito.ts";
import type { SignupMode } from "../domain/signup-mode.ts";
import { ORGANIZATION_CREATION_RATE_LIMIT } from "../domain/creation-limits.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import { PrincipalHttpError } from "../auth/principal.ts";
import { declareRoute } from "./route-audience.ts";
import { getMeHandler } from "./routes/me.ts";
import { createOrganizationHandler } from "./routes/organizations.ts";
import { createInvitationHandler, createInvitationMembershipCache } from "./routes/invitations.ts";
import { createBotHandler, getBotHandler, listUserBotsHandler, lookupBotHandler } from "./routes/bots.ts";
import { createChannelHandler, getChannelHandler, listUserChannelsHandler } from "./routes/channels.ts";
import { listChannelMessagesHandler, postChannelMessageHandler } from "./routes/messages.ts";
import type { MessageDependencies } from "../domain/messages.ts";
import { createUserMembershipCache } from "./user-principal.ts";

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
	invokeKey: string | null;
	environment?: string;
	verifier?: IdTokenVerifier | null;
	signupMode?: SignupMode;
	organizationCreationRateLimit?: number;
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

	declareRoute(app, { method: "GET", path: "/me", audience: "user" }, (c) =>
		getMeHandler(c, { store, clock: deps.clock, ids: deps.ids, verifier }),
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
		createInvitationHandler(c, { store, clock: deps.clock, ids: deps.ids, verifier, membershipCache }),
	);

	const userRoutes = {
		store,
		ids: deps.ids,
		verifier,
		membershipCache: createUserMembershipCache(deps.clock),
	};

	const messageRoutes = {
		...userRoutes,
		messages: { ...deps.messages, store, ids: deps.ids, clock: deps.clock } satisfies MessageDependencies,
	};

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

	return app;
}
