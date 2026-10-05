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
