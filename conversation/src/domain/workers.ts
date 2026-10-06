import { hashWorkerToken, mintWorkerToken, verifyWorkerTokenHash } from "../auth/worker-credentials.ts";
import { WorkerTenantMismatchError } from "../http/errors.ts";
import type { Clock, IdSource } from "../http/app.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import { ensureComputer } from "./computers.ts";

export { WorkerTenantMismatchError };

/** One worker's registration payload. */
export interface WorkerRegistration {
	workerId: string;
	tenantId: string;
	costClass: string;
	capabilities: string[];
	computerId: string | null;
}

/**
 * Register or replace a worker and record a heartbeat. Re-registering rotates the bearer token, and a new token is
 * returned on every successful registration. A worker advertising the computer capability gets the organization
 * computer, created when it does not exist yet.
 *
 * Ported from python/src/chatticus/control_plane.py lines 595-645.
 */
export async function registerWorker(
	registration: WorkerRegistration,
	deps: { store: MessagingStore; clock: Clock; ids: IdSource },
): Promise<string> {
	const existing = await deps.store.getWorker(registration.tenantId, registration.workerId);
	if (existing !== null && existing.tenantId !== registration.tenantId) {
		throw new WorkerTenantMismatchError(
			`Worker ${JSON.stringify(registration.workerId)} is registered to tenant ${JSON.stringify(existing.tenantId)}, not ${JSON.stringify(registration.tenantId)}.`,
		);
	}
	let computerId = registration.computerId;
	if (registration.capabilities.includes("computer")) {
		const organizationComputer = await ensureComputer(registration.tenantId, deps, registration.computerId);
		if (computerId === null) {
			computerId = organizationComputer.computerId;
		}
	}
	const token = mintWorkerToken();
	await deps.store.putWorker({
		workerId: registration.workerId,
		tenantId: registration.tenantId,
		costClass: registration.costClass,
		capabilities: registration.capabilities,
		tokenHash: hashWorkerToken(token),
		lastHeartbeatAt: deps.clock.now(),
		...(computerId === null ? {} : { computerId }),
		...(existing?.hydratedSnapshotGeneration === undefined
			? {}
			: { hydratedSnapshotGeneration: existing.hydratedSnapshotGeneration }),
	});
	return token;
}

/** Return the worker id for a valid bearer token in `tenantId`, or null when no registered worker holds it. */
export async function verifyWorkerToken(
	tenantId: string,
	token: string,
	deps: { store: MessagingStore },
): Promise<string | null> {
	for (const worker of await deps.store.listWorkers(tenantId)) {
		if (verifyWorkerTokenHash(token, worker.tokenHash)) {
			return worker.workerId;
		}
	}
	return null;
}
