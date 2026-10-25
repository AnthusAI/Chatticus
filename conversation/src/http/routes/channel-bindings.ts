import type { Context, Hono } from "hono";
import {
	chooseMailHandle,
	createChannelBinding,
	linkExternalIdentity,
	setChannelBindingEnabled,
	type BindingDependencies,
	type BindingRefusal,
} from "../../channels/binding-service.ts";
import type { ChannelBinding, DeliveryRecord } from "../../channels/records.ts";
import { externalChannelsAvailable, type ChannelsRuntime } from "../../channels/runtime.ts";
import { PrincipalHttpError, type Principal } from "../../auth/principal.ts";
import type { Clock, IdSource } from "../app.ts";
import { declareRoute } from "../route-audience.ts";
import { isRefusal, pathParameter, resolveUserPrincipal, type UserPrincipalDependencies } from "../user-principal.ts";

/** Everything the channel binding routes depend on. */
export interface ChannelBindingRouteDependencies extends UserPrincipalDependencies {
	clock: Clock;
	ids: IdSource;
	/** Present only where external channels are rolled out; absent, every route answers 404. */
	channels: ChannelsRuntime | null;
}

/** One binding as the HTTP API renders it. */
export interface ChannelBindingPayload {
	binding_id: string;
	tenant_id: string;
	provider: string;
	route_key: string;
	address: string | null;
	bot_id: string;
	enabled: boolean;
	created_by: string;
	created_at: string;
	updated_at: string;
}

/** One delivery as the HTTP API renders it for an owner: ids, state and the reason, never a message body. */
export interface ChannelDeliveryPayload {
	message_id: string;
	binding_id: string;
	channel_id: string;
	state: string;
	attempts: number;
	failure_class: string | null;
	reason_code: string | null;
	created_at: string;
	updated_at: string;
}

/** Render a binding for the HTTP API. */
export function bindingPayload(binding: ChannelBinding): ChannelBindingPayload {
	return {
		binding_id: binding.bindingId,
		tenant_id: binding.tenantId,
		provider: binding.provider,
		route_key: binding.routeKey,
		address: binding.provider === "email" ? binding.routeKey : null,
		bot_id: binding.botId,
		enabled: binding.enabled,
		created_by: binding.createdBy,
		created_at: binding.createdAt.toISOString(),
		updated_at: binding.updatedAt.toISOString(),
	};
}

function deliveryPayload(delivery: DeliveryRecord): ChannelDeliveryPayload {
	return {
		message_id: delivery.messageId,
		binding_id: delivery.bindingId,
		channel_id: delivery.channelId,
		state: delivery.state,
		attempts: delivery.attempts,
		failure_class: delivery.failureClass,
		reason_code: delivery.reasonCode,
		created_at: delivery.createdAt.toISOString(),
		updated_at: delivery.updatedAt.toISOString(),
	};
}

const REFUSAL_STATUS: Readonly<Record<BindingRefusal, number>> = {
	unsupported_provider: 422,
	bot_not_found: 404,
	mail_handle_required: 409,
	bot_name_has_no_address: 422,
	route_key_required: 422,
	route_taken: 409,
	mail_handle_invalid: 422,
	mail_handle_reserved: 422,
	mail_handle_taken: 409,
	binding_not_found: 404,
	member_not_found: 404,
	identity_is_a_route: 422,
};

const NOT_FOUND_BODY = { detail: "Not found.", code: "not_found" } as const;
const FORBIDDEN_BODY = { detail: "Only an owner of the organization may change this.", code: "forbidden" } as const;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAXIMUM_BODY_BYTES = 16 * 1024;

type Caller = { readonly principal: Principal; readonly userId: string; readonly runtime: ChannelsRuntime; readonly isOwner: boolean };

function notFound(c: Context): Response {
	return c.json(NOT_FOUND_BODY, 404);
}

async function bodyOf(c: Context): Promise<Record<string, unknown> | null> {
	const text = await c.req.text();
	if (text.length > MAXIMUM_BODY_BYTES) return null;
	try {
		const parsed: unknown = JSON.parse(text);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

async function authorize(c: Context, deps: ChannelBindingRouteDependencies): Promise<Caller | Response> {
	for (const name of ["tenant_id", "binding_id"]) {
		const value = c.req.param(name);
		if (value !== undefined && !IDENTIFIER_PATTERN.test(value)) return notFound(c);
	}
	let principal: Principal | Response;
	try {
		principal = await resolveUserPrincipal(c, deps);
	} catch (error) {
		if (error instanceof PrincipalHttpError && error.nonMemberUserId !== null) return notFound(c);
		throw error;
	}
	if (isRefusal(principal)) return principal;
	if (principal.userId === null) return c.json({ detail: "user credential required" }, 403);
	const tenantId = pathParameter(c, "tenant_id");
	if (deps.channels === null || !(await externalChannelsAvailable(deps.channels, tenantId))) return notFound(c);
	const membership = await deps.store.getMembership(tenantId, principal.userId);
	if (membership === null) return notFound(c);
	return { principal, userId: principal.userId, runtime: deps.channels, isOwner: membership.role === "owner" };
}

function bindingDependencies(deps: ChannelBindingRouteDependencies, runtime: ChannelsRuntime): BindingDependencies {
	return { runtime, store: deps.store, ids: deps.ids, clock: deps.clock };
}

function refusalResponse(c: Context, refusal: BindingRefusal): Response {
	if (REFUSAL_STATUS[refusal] === 404) return notFound(c);
	return c.json({ detail: refusal.replaceAll("_", " "), code: refusal }, REFUSAL_STATUS[refusal] as 404);
}

async function ownerCall(
	c: Context,
	deps: ChannelBindingRouteDependencies,
	run: (caller: Caller, tenantId: string, body: Record<string, unknown>) => Promise<Response>,
): Promise<Response> {
	const caller = await authorize(c, deps);
	if (caller instanceof Response) return caller;
	if (!caller.isOwner) return c.json(FORBIDDEN_BODY, 403);
	const body = await bodyOf(c);
	if (body === null) return c.json({ detail: "The body must be a JSON object.", code: "invalid_request" }, 422);
	return run(caller, pathParameter(c, "tenant_id"), body);
}

/**
 * Register the owner routes of external channel bindings under `/orgs/{tenant_id}`. Every member reads; only owners
 * change; a stranger, a switched-off organization and an environment without the capability all answer 404.
 *
 * @param app The application to register on.
 * @param deps The user principal dependencies, the clock, identifiers and the channel runtime (null where not rolled out).
 */
export function registerChannelBindingRoutes(app: Hono, deps: ChannelBindingRouteDependencies): void {
	declareRoute(app, { method: "PUT", path: "/orgs/:tenant_id/mail-handle", audience: "user" }, (c) =>
		ownerCall(c, deps, async (caller, tenantId, body) => {
			if (typeof body["mail_handle"] !== "string") return c.json({ detail: "mail_handle is required.", code: "invalid_request" }, 422);
			const chosen = await chooseMailHandle(bindingDependencies(deps, caller.runtime), tenantId, body["mail_handle"]);
			return chosen.ok ? c.json({ tenant_id: tenantId, mail_handle: chosen.value }, 200) : refusalResponse(c, chosen.refusal);
		}),
	);

	declareRoute(app, { method: "POST", path: "/orgs/:tenant_id/channel-bindings", audience: "user" }, (c) =>
		ownerCall(c, deps, async (caller, tenantId, body) => {
			if (typeof body["provider"] !== "string" || typeof body["bot_id"] !== "string") {
				return c.json({ detail: "provider and bot_id are required.", code: "invalid_request" }, 422);
			}
			const routeKey = typeof body["route_key"] === "string" ? body["route_key"] : null;
			const created = await createChannelBinding(bindingDependencies(deps, caller.runtime), tenantId, {
				provider: body["provider"],
				botId: body["bot_id"],
				routeKey,
				createdBy: caller.userId,
			});
			return created.ok ? c.json(bindingPayload(created.value), 200) : refusalResponse(c, created.refusal);
		}),
	);

	declareRoute(app, { method: "GET", path: "/orgs/:tenant_id/channel-bindings", audience: "user" }, async (c) => {
		const caller = await authorize(c, deps);
		if (caller instanceof Response) return caller;
		const tenantId = pathParameter(c, "tenant_id");
		const settings = await caller.runtime.store.getSettings(tenantId);
		const bindings = await caller.runtime.store.listBindings(tenantId);
		return c.json({ mail_handle: settings.mailHandle, bindings: bindings.map(bindingPayload) }, 200);
	});

	declareRoute(app, { method: "GET", path: "/orgs/:tenant_id/channel-bindings/:binding_id", audience: "user" }, async (c) => {
		const caller = await authorize(c, deps);
		if (caller instanceof Response) return caller;
		const binding = await caller.runtime.store.getBinding(pathParameter(c, "tenant_id"), pathParameter(c, "binding_id"));
		return binding === null ? notFound(c) : c.json(bindingPayload(binding), 200);
	});

	declareRoute(app, { method: "PATCH", path: "/orgs/:tenant_id/channel-bindings/:binding_id", audience: "user" }, (c) =>
		ownerCall(c, deps, async (caller, tenantId, body) => {
			if (typeof body["enabled"] !== "boolean") return c.json({ detail: "enabled is required.", code: "invalid_request" }, 422);
			const changed = await setChannelBindingEnabled(bindingDependencies(deps, caller.runtime), tenantId, pathParameter(c, "binding_id"), body["enabled"]);
			return changed.ok ? c.json(bindingPayload(changed.value), 200) : refusalResponse(c, changed.refusal);
		}),
	);

	declareRoute(app, { method: "GET", path: "/orgs/:tenant_id/channel-bindings/:binding_id/deliveries", audience: "user" }, async (c) => {
		const caller = await authorize(c, deps);
		if (caller instanceof Response) return caller;
		const tenantId = pathParameter(c, "tenant_id");
		const bindingId = pathParameter(c, "binding_id");
		if ((await caller.runtime.store.getBinding(tenantId, bindingId)) === null) return notFound(c);
		const deliveries = await caller.runtime.store.listDeliveries(tenantId, bindingId);
		return c.json({ deliveries: deliveries.map(deliveryPayload) }, 200);
	});

	declareRoute(app, { method: "PUT", path: "/orgs/:tenant_id/external-identities", audience: "user" }, (c) =>
		ownerCall(c, deps, async (caller, tenantId, body) => {
			if (typeof body["provider"] !== "string" || typeof body["external_id"] !== "string" || typeof body["user_id"] !== "string") {
				return c.json({ detail: "provider, external_id and user_id are required.", code: "invalid_request" }, 422);
			}
			const linked = await linkExternalIdentity(bindingDependencies(deps, caller.runtime), tenantId, {
				provider: body["provider"],
				externalId: body["external_id"],
				userId: body["user_id"],
				linkedBy: caller.userId,
			});
			if (!linked.ok) return refusalResponse(c, linked.refusal);
			return c.json({ tenant_id: tenantId, provider: linked.value.provider, external_id: linked.value.externalId, user_id: linked.value.userId }, 200);
		}),
	);

	for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
		declareRoute(app, { method, path: "/orgs/:tenant_id/channel-bindings/*", audience: "user" }, (c) => notFound(c));
	}
}
