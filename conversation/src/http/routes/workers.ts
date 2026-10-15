import type { Context } from "hono";
import { registerWorker } from "../../domain/workers.ts";
import type { MessagingStore } from "../../store/messaging-store.ts";
import type { Clock, IdSource } from "../app.ts";
import { pathParameter } from "../user-principal.ts";

/** Everything the worker routes depend on. */
export interface WorkerRouteDependencies {
	store: MessagingStore;
	clock: Clock;
	ids: IdSource;
}

type RegisterWorkerBody = { worker_id: string; cost_class: string; capabilities: string[]; computer_id: string | null };

const costClasses = new Set(["local", "ec2", "fargate"]);

function parseRegisterWorkerBody(raw: unknown): RegisterWorkerBody | null {
	if (typeof raw !== "object" || raw === null) {
		return null;
	}
	const body = raw as Record<string, unknown>;
	if (typeof body.worker_id !== "string" || typeof body.cost_class !== "string" || !costClasses.has(body.cost_class)) {
		return null;
	}
	const capabilities = body.capabilities ?? [];
	if (!Array.isArray(capabilities) || !capabilities.every((capability) => typeof capability === "string")) {
		return null;
	}
	if (body.computer_id !== undefined && body.computer_id !== null && typeof body.computer_id !== "string") {
		return null;
	}
	return {
		worker_id: body.worker_id,
		cost_class: body.cost_class,
		capabilities: capabilities as string[],
		computer_id: (body.computer_id as string | null | undefined) ?? null,
	};
}

/**
 * POST /orgs/{tenant_id}/workers/register: the worker bootstrap. It carries no principal; the invoke key gate in
 * front of every route is the only credential. The response holds the worker's one-time bearer token.
 */
export async function registerWorkerHandler(c: Context, deps: WorkerRouteDependencies): Promise<Response> {
	const body = parseRegisterWorkerBody(await c.req.json().catch(() => null));
	if (body === null) {
		return c.json({ detail: "worker_id, cost_class and capabilities are required" }, 422);
	}
	const token = await registerWorker(
		{
			workerId: body.worker_id,
			tenantId: pathParameter(c, "tenant_id"),
			costClass: body.cost_class,
			capabilities: body.capabilities,
			computerId: body.computer_id,
		},
		deps,
	);
	return c.json({ worker_id: body.worker_id, token }, 200);
}
