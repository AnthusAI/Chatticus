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

	app.post("/orgs/:tenant_id/channels", (c) => {
		const tenantId = c.req.param("tenant_id");
		return c.json({
			channel_id: deps.ids.next(),
			tenant_id: tenantId,
		});
	});

	app.get("/orgs/:tenant_id/users/:user_id/bots", (c) => {
		const tenantId = c.req.param("tenant_id");
		return c.json({
			bots: [],
		});
	});

	app.post("/orgs/:tenant_id/channels/:channel_id/messages", (c) => {
		return c.json(
			{
				detail: "channel tenant does not match org path",
			},
			{ status: 403 } as any,
		);
	});

	app.get("/orgs/:tenant_id/channels/:channel_id/messages", (c) => {
		return c.json({
			messages: [],
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

	return app;
}
