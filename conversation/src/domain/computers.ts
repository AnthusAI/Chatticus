import {
	ComputerDirtyError,
	ComputerNotFoundError,
	ComputerNotHydratedError,
	SnapshotRequiredError,
	WorkerDoesNotHostComputerError,
	WorkerNotRegisteredError,
} from "../http/errors.ts";
import { snapshotUri } from "../snapshot/uri.ts";
import { pythonRepr } from "./bots.ts";
import type { Clock, IdSource } from "../http/app.ts";
import type { Computer } from "../store/codecs/computer.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import { refuseIfComputerWorkPaused, type SpendPauseDependencies } from "./organization-spend.ts";

export { ComputerNotFoundError };

/** The readiness gate of the model on the computer host. */
export const MODEL_CAPABILITY = "model";

/** The readiness gate of the workspace and terminal. */
export const WORKSPACE_CAPABILITY = "workspace";

/** The readiness gate of the browser. */
export const BROWSER_CAPABILITY = "browser";

/** Seconds one host start holds the right to be the only start of its generation; the same as the turn attempt lease. */
export const HOST_START_LEASE_SECONDS = 60;

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
 * Return the existing computer of one organization. The store is always read, never a cache: the front door and the
 * computer starter are separate processes, and a cached computer would hide a host start the other recorded.
 *
 * Ported from python/src/chatticus/control_plane.py lines 1030-1044.
 *
 * @throws ComputerNotFoundError If the organization has no computer.
 */
export async function computerForOrganization(tenantId: string, deps: { store: MessagingStore }): Promise<Computer> {
	const computer = await deps.store.getComputer(tenantId);
	if (computer === null) {
		throw new ComputerNotFoundError(`Organization ${JSON.stringify(tenantId)} has no computer.`);
	}
	return computer;
}

/**
 * Whether the organization computer is stopped. An organization with no computer yet is not.
 *
 * Ported from python/src/chatticus/control_plane.py `computer_is_stopped`.
 */
export async function computerIsStopped(tenantId: string, deps: { store: MessagingStore }): Promise<boolean> {
	return (await deps.store.getComputer(tenantId))?.stopped ?? false;
}

/**
 * Mark the organization computer stopped or running without deleting it. Stopping clears every readiness gate.
 *
 * Ported from python/src/chatticus/control_plane.py lines 2841-2851.
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

/**
 * Record that one capability gate cleared on the computer host.
 *
 * Ported from python/src/chatticus/control_plane.py `record_computer_capability_ready`.
 *
 * @throws Error If the capability is not one of `model`, `workspace` or `browser`.
 */
export async function recordComputerCapabilityReady(
	tenantId: string,
	capability: string,
	deps: { store: MessagingStore; ids: IdSource },
): Promise<Computer> {
	const computer = await ensureComputer(tenantId, deps);
	const updated: Computer = { ...computer };
	if (capability === MODEL_CAPABILITY) {
		updated.modelReady = true;
	} else if (capability === WORKSPACE_CAPABILITY) {
		updated.workspaceReady = true;
	} else if (capability === BROWSER_CAPABILITY) {
		updated.browserReady = true;
	} else {
		throw new Error(`Unknown capability ${JSON.stringify(capability)}.`);
	}
	await deps.store.putComputer(updated);
	return updated;
}

/** One host start of one generation: the right to start the computer's host and the user it is started for. */
export type HostStartClaim = {
	readonly tenantId: string;
	readonly computerId: string;
	readonly hostStartGeneration: number;
	/** The member the start is made for, so the host starts under that member's account context. */
	readonly userId: string;
	readonly expiresAt: Date;
	/** Whether this call began the generation. Only the call that did starts a host. */
	readonly newlyClaimed: boolean;
};

/** What requesting a host start needs. */
export type HostStartDependencies = {
	readonly store: MessagingStore;
	readonly clock: Clock;
	readonly ids: IdSource;
	readonly spend: SpendPauseDependencies;
};

/**
 * Ask for a host start. Callers that find a live start lease share its generation; the one caller that begins a new
 * generation (a compare-and-set on the stored generation, so two concurrent callers cannot both) is told so and is the
 * only one that starts a host.
 *
 * Ported from python/src/chatticus/control_plane.py lines 2701-2753, without the in-process claim dictionary: the
 * computer record is the single source of truth.
 *
 * @param deps Store, clock, identifiers and the spend pause inputs.
 * @param tenantId Organization.
 * @param userId The member the start is for.
 * @returns The claim.
 * @throws Error If `userId` is empty.
 * @throws OrganizationSpendCeilingExceededError If month-to-date spend blocks new computer work.
 */
export async function requestComputerHostStart(
	deps: HostStartDependencies,
	tenantId: string,
	userId: string,
): Promise<HostStartClaim> {
	if (userId === "") {
		throw new Error("host start requires a non-empty user_id");
	}
	await refuseIfComputerWorkPaused(tenantId, deps.spend);
	for (;;) {
		const computer = await ensureComputer(tenantId, deps);
		const now = deps.clock.now();
		const lease = computer.hostStartLeaseExpiresAt;
		if (lease !== undefined && lease.getTime() > now.getTime()) {
			return {
				tenantId,
				computerId: computer.computerId,
				hostStartGeneration: computer.hostStartGeneration,
				userId,
				expiresAt: lease,
				newlyClaimed: false,
			};
		}
		const expiresAt = new Date(now.getTime() + HOST_START_LEASE_SECONDS * 1000);
		const claimed = await deps.store.claimHostStartGeneration(tenantId, computer.hostStartGeneration, expiresAt);
		if (claimed !== null) {
			return {
				tenantId,
				computerId: claimed.computerId,
				hostStartGeneration: claimed.hostStartGeneration,
				userId,
				expiresAt,
				newlyClaimed: true,
			};
		}
	}
}

async function requireHost(computer: Computer, workerId: string, deps: { store: MessagingStore }): Promise<void> {
	const worker = await deps.store.getWorker(computer.tenantId, workerId);
	if (worker === null) {
		throw new WorkerNotRegisteredError(workerId);
	}
	if (worker.computerId !== computer.computerId) {
		throw new WorkerDoesNotHostComputerError(
			`Worker ${pythonRepr(workerId)} hosts ${worker.computerId === undefined ? "None" : pythonRepr(worker.computerId)}, not ${pythonRepr(computer.computerId)}.`,
		);
	}
}

/**
 * Record that a host packed its disk and uploaded the pack. The computer keeps the URI, the checksum and the generation
 * only; the bytes live in object storage.
 *
 * Ported from python/src/chatticus/control_plane.py `record_host_snapshot_published`.
 *
 * @throws ComputerNotFoundError If the organization has no computer.
 * @throws ComputerNotHydratedError If a relocation waits for a host to hydrate first.
 * @throws WorkerNotRegisteredError If the worker is not registered.
 * @throws WorkerDoesNotHostComputerError If the worker does not host this computer.
 */
export async function recordHostSnapshotPublished(
	tenantId: string,
	workerId: string,
	checksum: string,
	snapshotUriOverride: string | null,
	deps: { store: MessagingStore },
): Promise<Computer> {
	const computer = await computerForOrganization(tenantId, deps);
	if (computer.hydrateRequired) {
		throw new ComputerNotHydratedError(
			`Computer ${pythonRepr(computer.computerId)} must be hydrated before the live disk can be published.`,
		);
	}
	await requireHost(computer, workerId, deps);
	const published: Computer = {
		...computer,
		snapshotUri: snapshotUriOverride ?? snapshotUri(computer.tenantId, computer.computerId),
		snapshotChecksum: checksum,
		snapshotGeneration: computer.snapshotGeneration + 1,
		diskDirty: false,
	};
	await markWorkerHydrated(published, workerId, deps);
	await deps.store.putComputer(published);
	return published;
}

/**
 * Record that a host hydrated the published snapshot onto its disk, which ends a relocation.
 *
 * Ported from python/src/chatticus/control_plane.py `record_host_hydrated`.
 *
 * @throws ComputerNotFoundError If the organization has no computer.
 * @throws SnapshotRequiredError If nothing has been published.
 * @throws WorkerNotRegisteredError If the worker is not registered.
 * @throws WorkerDoesNotHostComputerError If the worker is not the intended host, or does not host this computer.
 */
export async function recordHostHydrated(tenantId: string, workerId: string, deps: { store: MessagingStore }): Promise<Computer> {
	const computer = await computerForOrganization(tenantId, deps);
	if (computer.snapshotUri === undefined) {
		throw new SnapshotRequiredError(`Computer ${pythonRepr(computer.computerId)} has no published snapshot.`);
	}
	await requireHost(computer, workerId, deps);
	if (computer.intendedHostWorkerId !== undefined && workerId !== computer.intendedHostWorkerId) {
		throw new WorkerDoesNotHostComputerError(
			`Worker ${pythonRepr(workerId)} is not the intended host ${pythonRepr(computer.intendedHostWorkerId)} for computer ${pythonRepr(computer.computerId)}.`,
		);
	}
	const { intendedHostWorkerId: _cleared, ...rest } = computer;
	const hydrated: Computer = { ...rest, hydrateRequired: false, diskDirty: false };
	await markWorkerHydrated(hydrated, workerId, deps);
	await deps.store.putComputer(hydrated);
	return hydrated;
}

async function markWorkerHydrated(computer: Computer, workerId: string, deps: { store: MessagingStore }): Promise<void> {
	const worker = await deps.store.getWorker(computer.tenantId, workerId);
	if (worker !== null) {
		await deps.store.putWorker({ ...worker, hydratedSnapshotGeneration: computer.snapshotGeneration });
	}
}

/**
 * Point the next run at a host. Nothing is copied: turns stay pinned to the target until it hydrates the published
 * snapshot, and prefer-local ranking resumes after that.
 *
 * Ported from python/src/chatticus/control_plane.py `relocate_computer`.
 *
 * @param tenantId Organization.
 * @param targetWorkerId The worker that becomes the intended host; it must advertise this computer.
 * @param deps The store.
 * @throws ComputerNotFoundError If the organization has no computer.
 * @throws SnapshotRequiredError If nothing has been published.
 * @throws ComputerDirtyError If the live disk has unpublished writes.
 * @throws WorkerNotRegisteredError If the target is not registered.
 * @throws WorkerDoesNotHostComputerError If the target is not a host of this computer.
 */
export async function relocateComputer(tenantId: string, targetWorkerId: string, deps: { store: MessagingStore }): Promise<Computer> {
	const computer = await computerForOrganization(tenantId, deps);
	if (computer.snapshotUri === undefined) {
		throw new SnapshotRequiredError(`Computer ${pythonRepr(computer.computerId)} has no published snapshot.`);
	}
	if (computer.diskDirty) {
		throw new ComputerDirtyError(`Computer ${pythonRepr(computer.computerId)} has unpublished live-disk writes.`);
	}
	await requireHost(computer, targetWorkerId, deps);
	const relocating: Computer = { ...computer, intendedHostWorkerId: targetWorkerId, hydrateRequired: true };
	await deps.store.putComputer(relocating);
	return relocating;
}
