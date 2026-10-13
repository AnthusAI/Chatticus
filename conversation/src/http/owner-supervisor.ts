import type { Context } from "hono";
import type { ZodType } from "zod";
import {
	OWNER_BOOTSTRAP_AUDIENCE,
	OWNER_ERROR_STATUS,
	ownerBootstrapRequestSchema,
	ownerPollRequestSchema,
	ownerStopRequestSchema,
	type OwnerErrorCode,
} from "@chatticus/host-protocol/supervisor";
import { ownerFileResultRequestSchema } from "@chatticus/host-protocol/live-files";
import { ownerOverlayAppliedRequestSchema, ownerOverlaySealRequestSchema } from "@chatticus/host-protocol/edit-overlay";
import { parseBearerToken, PrincipalHttpError } from "../auth/principal.ts";
import { EditOverlayRefusal, clearOverlay, sealOverlay, type EditOverlayDependencies } from "../domain/edit-overlay.ts";
import { exchangeOwnerBootstrap, judgeOwnerStop, OwnerRefusal, pollOwner, recordOwnerFileResult, type OwnerIdentity, type OwnerSupervisorDependencies } from "../domain/owner-supervisor.ts";
import { verifyOwnerBootstrapToken } from "../gateway/session-token.ts";
import { ownerHostPrincipalOf } from "./owner-host-auth.ts";
import { pathParameter } from "./user-principal.ts";

/** Everything the three owner routes depend on. */
export type OwnerSupervisorRouteDependencies = OwnerSupervisorDependencies & {
	/** The secret the bootstrap token is verified with. */
	readonly signingKey: string;
};

/**
 * The body of an owner route refusal: the detail a person can read, which never carries a token or a claim, and the code
 * the supervisor branches on.
 *
 * @param c The request context.
 * @param code The reason.
 * @param detail The description.
 * @returns The response with the status the code maps to.
 */
export function ownerErrorResponse(c: Context, code: OwnerErrorCode, detail: string): Response {
	return c.json({ detail, code }, OWNER_ERROR_STATUS[code] as 401 | 403 | 409 | 422 | 503);
}

async function parseOwnerBody<T>(c: Context, schema: ZodType<T>): Promise<{ readonly value: T } | { readonly refusal: Response }> {
	let raw: unknown;
	try {
		raw = JSON.parse(await c.req.text());
	} catch {
		return { refusal: ownerErrorResponse(c, "invalid_request", "body must be JSON") };
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		return { refusal: ownerErrorResponse(c, "invalid_request", parsed.error.issues.map((issue) => issue.message).join("; ")) };
	}
	return { value: parsed.data };
}

async function guarded(c: Context, run: () => Promise<Response>): Promise<Response> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof OwnerRefusal) return ownerErrorResponse(c, error.code, error.message);
		if (error instanceof PrincipalHttpError) return ownerErrorResponse(c, "wrong_organization", error.detail);
		throw error;
	}
}

/**
 * POST /orgs/{tenant_id}/host/owner/bootstrap: the supervisor exchanges its bootstrap token, once, for the supervisor
 * token and the supervisor's AWS credentials. The token is verified here, for the bootstrap audience only.
 */
export async function ownerBootstrapHandler(c: Context, deps: OwnerSupervisorRouteDependencies): Promise<Response> {
	return guarded(c, async () => {
		const token = parseBearerToken(c.req.header("Authorization") ?? null);
		const verification = token === null ? null : verifyOwnerBootstrapToken(deps.signingKey, token, deps.clock.now());
		if (token === null || verification === null || !verification.valid) {
			return ownerErrorResponse(c, "invalid_credential", "invalid owner credential");
		}
		const tenantId = pathParameter(c, "tenant_id");
		if (verification.claims.audience !== OWNER_BOOTSTRAP_AUDIENCE || verification.claims.tenantId !== tenantId) {
			return ownerErrorResponse(c, "wrong_organization", "owner credential is not valid for this organization");
		}
		const body = await parseOwnerBody(c, ownerBootstrapRequestSchema);
		if ("refusal" in body) return body.refusal;
		return c.json(await exchangeOwnerBootstrap(deps, tenantId, verification.claims, token, body.value), 200);
	});
}

function ownerOf(c: Context) {
	const owner = ownerHostPrincipalOf(c.req.raw);
	if (owner === null) throw new OwnerRefusal("not_current_owner", "owner credential is required");
	return owner;
}

/** POST /orgs/{tenant_id}/host/owner/poll: the supervisor's heartbeat and request for work. */
export async function ownerPollHandler(c: Context, deps: OwnerSupervisorRouteDependencies): Promise<Response> {
	return guarded(c, async () => {
		const owner = ownerOf(c);
		const body = await parseOwnerBody(c, ownerPollRequestSchema);
		if ("refusal" in body) return body.refusal;
		return c.json(await pollOwner(deps, owner, body.value), 200);
	});
}

async function overlayGuarded(c: Context, overlay: EditOverlayDependencies | null, run: (overlay: EditOverlayDependencies) => Promise<Response>): Promise<Response> {
	return guarded(c, async () => {
		if (overlay === null) return c.json({ detail: "the edit overlay is not configured" }, 503);
		try {
			return await run(overlay);
		} catch (error) {
			if (error instanceof EditOverlayRefusal) return c.json({ detail: error.message, code: error.code }, error.status as 503);
			throw error;
		}
	});
}

function requireNamedOwner(owner: OwnerIdentity, body: { owner_id: string; generation: number }): void {
	if (body.owner_id !== owner.ownerId || body.generation !== owner.startGeneration) {
		throw new OwnerRefusal("credential_mismatch", "request does not match the owner credential");
	}
}

/** POST /orgs/{tenant_id}/host/owner/overlay-seal: after extraction the owner closes the overlay to member writes and gets the entries to apply. */
export async function ownerOverlaySealHandler(c: Context, overlay: EditOverlayDependencies | null): Promise<Response> {
	return overlayGuarded(c, overlay, async (dependencies) => {
		const owner = ownerOf(c);
		const body = await parseOwnerBody(c, ownerOverlaySealRequestSchema);
		if ("refusal" in body) return body.refusal;
		requireNamedOwner(owner, body.value);
		return c.json(await sealOverlay(dependencies, owner), 200);
	});
}

/** POST /orgs/{tenant_id}/host/owner/overlay-applied: the owner asks to clear what it applied, after a recorded publish, and reports what it could not apply. */
export async function ownerOverlayAppliedHandler(c: Context, overlay: EditOverlayDependencies | null): Promise<Response> {
	return overlayGuarded(c, overlay, async (dependencies) => {
		const owner = ownerOf(c);
		const body = await parseOwnerBody(c, ownerOverlayAppliedRequestSchema);
		if ("refusal" in body) return body.refusal;
		requireNamedOwner(owner, body.value);
		return c.json(await clearOverlay(dependencies, owner, body.value), 200);
	});
}

/** POST /orgs/{tenant_id}/host/owner/stop-request: the supervisor asks whether it may stop. A veto is a 200. */
export async function ownerStopRequestHandler(c: Context, deps: OwnerSupervisorRouteDependencies): Promise<Response> {
	return guarded(c, async () => {
		const owner = ownerOf(c);
		const body = await parseOwnerBody(c, ownerStopRequestSchema);
		if ("refusal" in body) return body.refusal;
		return c.json(await judgeOwnerStop(deps, owner, body.value), 200);
	});
}

/**
 * POST /orgs/{tenant_id}/host/owner/file-results: the supervisor posts the answer to one file request. A store failure is a
 * 503 the supervisor retries; the write that records the answer is idempotent.
 */
export async function ownerFileResultHandler(c: Context, deps: OwnerSupervisorRouteDependencies): Promise<Response> {
	return guarded(c, async () => {
		const owner = ownerOf(c);
		const body = await parseOwnerBody(c, ownerFileResultRequestSchema);
		if ("refusal" in body) return body.refusal;
		try {
			return c.json(await recordOwnerFileResult(deps, owner, body.value), 200);
		} catch (error) {
			if (error instanceof OwnerRefusal) throw error;
			return c.json({ detail: "the file result could not be recorded; send it again" }, 503);
		}
	});
}
