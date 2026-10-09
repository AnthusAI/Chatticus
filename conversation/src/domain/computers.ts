import {
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
	const { browserUnavailable: _kept, ...withoutUnavailable } = computer;
	const updated: Computer = stopped
		? { ...computer, stopped, modelReady: false, workspaceReady: false, browserReady: false }
		: { ...withoutUnavailable, stopped };
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
		delete updated.browserUnavailable;
	} else {
		throw new Error(`Unknown capability ${JSON.stringify(capability)}.`);
	}
	await deps.store.putComputer(updated);
	return updated;
}

/** What the model reads when it calls a browser tool on a computer whose image has no browser. */
export const BROWSER_UNAVAILABLE_TEXT = "The browser capability is not available on this computer.";

/**
 * Record that the computer host booted without a browser. The computer keeps serving files and the terminal; browser
 * tools answer with `BROWSER_UNAVAILABLE_TEXT` until a host starts again and reports the browser ready.
 *
 * @throws Error If the capability is not `browser`, the only one an image may leave out.
 */
export async function recordComputerCapabilityUnavailable(
	tenantId: string,
	capability: string,
	deps: { store: MessagingStore; ids: IdSource },
): Promise<Computer> {
	if (capability !== BROWSER_CAPABILITY) {
		throw new Error(`Capability ${JSON.stringify(capability)} cannot be unavailable.`);
	}
	const computer = await ensureComputer(tenantId, deps);
	const updated: Computer = { ...computer, browserReady: false, browserUnavailable: true };
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
	/** Seconds without a heartbeat after which a host is taken to be gone. */
	readonly heartbeatTimeoutSeconds: number;
};

/**
 * Settle the record of a computer whose host is gone. The record claims a host when the disk holds unpublished writes or
 * a live-writer lock is held; the host is gone when no worker that advertises this computer and the computer capability
 * has a heartbeat within `heartbeatTimeoutSeconds` (a host killed before it could report, a crash, a spot reclaim). The
 * unpublished writes died with the host, so the record is marked stopped, the lock released, the dirty flag cleared, and
 * the live disk marked to be rebuilt from the last published snapshot (`hydrateRequired`, only when one exists; with no
 * snapshot the next disk is empty). `hostLostAt` and `hostLostGeneration` keep the loss visible. A host that is merely
 * slow, with a heartbeat inside the timeout, is left alone.
 *
 * @returns The settled computer, or null when nothing needed settling or another caller moved the record first.
 */
export async function settleComputerIfHostLost(
	deps: Pick<HostStartDependencies, "store" | "clock" | "heartbeatTimeoutSeconds">,
	computer: Computer,
): Promise<Computer | null> {
	if (!computer.diskDirty && computer.liveWriterHostId === undefined) {
		return null;
	}
	const now = deps.clock.now();
	const hostIsAlive = (await deps.store.listWorkers(computer.tenantId)).some(
		(worker) =>
			worker.computerId === computer.computerId &&
			worker.capabilities.includes("computer") &&
			now.getTime() - worker.lastHeartbeatAt.getTime() <= deps.heartbeatTimeoutSeconds * 1000,
	);
	if (hostIsAlive) {
		return null;
	}
	return deps.store.settleLostComputerHost(computer.tenantId, computer.hostStartGeneration, now, computer.snapshotUri !== undefined);
}

/**
 * Ask for a host start. Callers that find a live start lease share its generation; the one caller that begins a new
 * generation (a compare-and-set on the stored generation, so two concurrent callers cannot both) is told so and is the
 * only one that starts a host.
 *
 * Ported from python/src/chatticus/control_plane.py lines 2701-2753, without the in-process claim dictionary: the
 * computer record is the single source of truth. Before it begins a generation it settles a record whose host is gone
 * (`settleComputerIfHostLost`), so a killed host never leaves the new start facing a dirty disk that no longer exists.
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
		await settleComputerIfHostLost(deps, computer);
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

/** The computer tools that change the live disk: a workspace write, a workspace edit and a terminal command. */
export const DISK_WRITING_TOOL_NAMES: ReadonlySet<string> = new Set(["write_workspace", "edit_workspace", "run_terminal"]);

/**
 * Refuse a disk-writing tool while the computer waits for its intended host to hydrate the snapshot the record names,
 * because a write now would land on a disk that is about to be replaced and would be lost.
 *
 * Ported from python/src/chatticus/control_plane.py `seed_snapshot_workspace` and `save_browser_session`.
 *
 * @param toolName The computer tool about to run.
 * @param computer The organization computer, or null when it has none yet.
 * @throws ComputerNotHydratedError If the tool writes the disk and a hydrate is required.
 */
export function refuseDiskWriteBeforeHydrate(toolName: string, computer: Computer | null): void {
	if (computer !== null && computer.hydrateRequired && DISK_WRITING_TOOL_NAMES.has(toolName)) {
		throw new ComputerNotHydratedError(
			`Computer ${pythonRepr(computer.computerId)} must be hydrated before the live disk can be written.`,
		);
	}
}

/**
 * Record that a disk-writing tool answered, so the live disk holds writes no snapshot has published until the next
 * publish or hydrate. Tools that only read leave the flag alone.
 *
 * Ported from python/src/chatticus/control_plane.py `seed_snapshot_workspace` and `save_browser_session`.
 */
export async function recordComputerToolAnswered(tenantId: string, toolName: string, deps: { store: MessagingStore }): Promise<void> {
	if (DISK_WRITING_TOOL_NAMES.has(toolName)) {
		await deps.store.markComputerDiskDirty(tenantId);
	}
}

