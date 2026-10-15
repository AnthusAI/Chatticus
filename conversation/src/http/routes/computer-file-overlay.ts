import type { Context } from "hono";
import { liveFileDiscardBodySchema } from "@chatticus/host-protocol/live-files";
import { EditOverlayRefusal, discardOverlayEntry, listOverlayEntries, type EditOverlayDependencies } from "../../domain/edit-overlay.ts";
import { isRefusal, resolveUserPrincipal, type UserPrincipalDependencies } from "../user-principal.ts";

/** What the member overlay routes depend on: who the caller is, and the overlay, which is absent where the deployment has none. */
export interface ComputerFileOverlayRouteDependencies extends UserPrincipalDependencies {
	readonly overlay: EditOverlayDependencies | null;
}

function refusalResponse(c: Context, refusal: EditOverlayRefusal): Response {
	return c.json(
		{
			error: refusal.code,
			message: refusal.message,
			...(refusal.currentSha256 === undefined ? {} : { current_sha256: refusal.currentSha256 }),
			...(refusal.retryAfterMs === undefined ? {} : { retry_after_ms: refusal.retryAfterMs }),
		},
		refusal.status as 409,
	);
}

async function serveOverlay(
	c: Context,
	deps: ComputerFileOverlayRouteDependencies,
	produce: (overlay: EditOverlayDependencies, principal: { tenantId: string; userId: string }) => Promise<Response>,
): Promise<Response> {
	const principal = await resolveUserPrincipal(c, deps);
	c.header("X-Content-Type-Options", "nosniff");
	c.header("Cache-Control", "private, no-store");
	if (isRefusal(principal)) {
		principal.headers.set("X-Content-Type-Options", "nosniff");
		return principal;
	}
	if (principal.kind !== "user" || principal.userId === null) return c.json({ detail: "a member is required" }, 403);
	if (deps.overlay === null) return c.json({ error: "snapshot_store_unavailable", message: "This deployment has no snapshot store." }, 503);
	try {
		return await produce(deps.overlay, { tenantId: principal.tenantId, userId: principal.userId });
	} catch (error) {
		if (error instanceof EditOverlayRefusal) return refusalResponse(c, error);
		throw error;
	}
}

/**
 * POST /orgs/{tenant_id}/computer/files/overlay/discard: any enabled member drops one pending change of any kind, by the
 * revision they saw. Audited. Only while the overlay is writable.
 */
export async function discardOverlayEntryHandler(c: Context, deps: ComputerFileOverlayRouteDependencies): Promise<Response> {
	return serveOverlay(c, deps, async (overlay, member) => {
		let raw: unknown;
		try {
			raw = JSON.parse(await c.req.text());
		} catch {
			return c.json({ error: "invalid_body", message: "The body must be JSON." }, 400);
		}
		const body = liveFileDiscardBodySchema.safeParse(raw);
		if (!body.success) return c.json({ error: "invalid_body", message: body.error.issues.map((issue) => issue.message).join("; ") }, 400);
		await discardOverlayEntry(overlay, { ...member, path: body.data.path, revision: body.data.revision });
		return c.json({ discarded: true }, 200);
	});
}

/** GET /orgs/{tenant_id}/computer/files/overlay: the pending changes, each with its state against the saved copy. */
export async function listOverlayEntriesHandler(c: Context, deps: ComputerFileOverlayRouteDependencies): Promise<Response> {
	return serveOverlay(c, deps, async (overlay, member) => c.json({ entries: await listOverlayEntries(overlay, member.tenantId) }, 200));
}
