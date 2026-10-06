import type { IdSource } from "../http/app.ts";
import type { Computer } from "../store/codecs/computer.ts";
import type { MessagingStore } from "../store/messaging-store.ts";

/**
 * Return the organization computer, creating it if needed.
 *
 * Ported from python/src/chatticus/control_plane.py lines 1009-1028.
 * The first call may set a stable computerId so workers can advertise the same workplace.
 */
export async function ensureComputer(
	tenantId: string,
	deps: { store: MessagingStore; ids: IdSource },
	computerId: string | null = null,
): Promise<Computer> {
	const existing = await deps.store.getComputer(tenantId);
	if (existing !== null) {
		return existing;
	}
	const computer: Computer = {
		computerId: computerId ?? deps.ids.next(),
		tenantId,
		policy: "prefer_local",
		stopped: false,
		modelReady: true,
		workspaceReady: false,
		browserReady: false,
		hostStartGeneration: 0,
		hostStartDispatchedGeneration: 0,
		snapshotGeneration: 0,
		diskDirty: false,
		hydrateRequired: false,
	};
	await deps.store.putComputer(computer);
	return computer;
}

/**
 * Mark the organization computer stopped or running without deleting it, creating it first if the organization has none.
 * Stopping clears the model, workspace and browser readiness.
 *
 * Ported from python/src/chatticus/control_plane.py lines 2841-2849.
 */
export async function setComputerStopped(
	tenantId: string,
	stopped: boolean,
	deps: { store: MessagingStore; ids: IdSource },
): Promise<Computer> {
	const computer = await ensureComputer(tenantId, deps);
	const updated: Computer = stopped
		? { ...computer, stopped, modelReady: false, workspaceReady: false, browserReady: false }
		: { ...computer, stopped };
	await deps.store.putComputer(updated);
	return updated;
}
