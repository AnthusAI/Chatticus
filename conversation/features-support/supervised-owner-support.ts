import type { HostComputer } from "@chatticus/host-protocol";
import type {
	OwnerBootstrapRequest,
	OwnerBootstrapResponse,
	OwnerCredentialsRequest,
	OwnerCredentialsResponse,
	OwnerPollRequest,
	OwnerPollResponse,
	OwnerStopRequest,
	OwnerStopResponse,
} from "@chatticus/host-protocol/supervisor";
import { HostDiskLifecycle } from "../../computer/host/src/host-disk-lifecycle.ts";
import { SealingOverlayApplier } from "../../computer/host/src/overlay-applier.ts";
import { OwnerSupervisor } from "../../computer/host/src/supervisor.ts";
import {
	runtimeSupervisorClock,
	type ChildExit,
	type ChildSpawner,
	type SpawnedChild,
	type SupervisorPlane,
	type UnprivilegedProcessSweeper,
} from "../../computer/host/src/supervisor-ports.ts";
import { consoleLogEmitter } from "../src/observability/log-line.ts";
import type { SnapshotObjectStore } from "../src/snapshot/store.ts";
import { UNUSED_FILE_HELPER_LAUNCHER } from "./fakes/fake-file-helper-launcher.ts";
import { FakeOverlayBlobStore } from "./fakes/fake-overlay-blob-store.ts";
import { dispatchPollAnswer, emptyPollAnswer, FAKE_SUPERVISOR_SECRETS } from "./fakes/fake-supervisor-plane.ts";
import { ensureHostWorker, hostClientFor, hostDiskOf, LIFECYCLE_TENANT } from "./host-lifecycle-support.ts";
import type { ChatticusWorld } from "./world.ts";

/** What the supervised owner's one turn does in place of a child process, and how the run ends. */
export type SupervisedTurn = {
	/** The turn the control plane dispatches; absent for a run that must end before any dispatch. */
	readonly turnId?: string;
	readonly botId?: string;
	/** The work of the child, given the workspace directory; resolves with the child's exit code. */
	readonly work: (workspaceRoot: string) => Promise<number>;
};

/** How a supervised owner run ended. */
export type SupervisedRunResult = {
	readonly exitCode: number;
	readonly logs: readonly string[];
};

/**
 * The Front Door for a supervisor in the disk scenarios: the owner routes are scripted (the bootstrap succeeds, the first
 * idle poll dispatches the turn, and the poll after the turn drains the owner at its lifetime), and the computer routes are
 * the production Front Door's, reached with the host worker's token the way the host worker reaches them.
 */
class DiskScenarioPlane implements SupervisorPlane {
	private readonly computerRoutes: ReturnType<typeof hostClientFor>;
	private readonly turn: SupervisedTurn | null;
	private dispatched = false;

	constructor(computerRoutes: ReturnType<typeof hostClientFor>, turn: SupervisedTurn | null) {
		this.computerRoutes = computerRoutes;
		this.turn = turn;
	}

	async bootstrap(_request: OwnerBootstrapRequest): Promise<OwnerBootstrapResponse> {
		const expiresAt = new Date(Date.now() + 3600_000).toISOString();
		return {
			computer_id: "household-computer",
			supervisor_token: FAKE_SUPERVISOR_SECRETS.supervisorToken,
			supervisor_token_expires_at: expiresAt,
			aws_credentials: {
				access_key_id: FAKE_SUPERVISOR_SECRETS.supervisorAccessKeyId,
				secret_access_key: FAKE_SUPERVISOR_SECRETS.supervisorSecretAccessKey,
				session_token: FAKE_SUPERVISOR_SECRETS.supervisorSessionToken,
				expires_at: expiresAt,
			},
		};
	}

	async poll(request: OwnerPollRequest): Promise<OwnerPollResponse> {
		if (request.state !== "idle") return emptyPollAnswer(250);
		if (this.turn?.turnId !== undefined && !this.dispatched) {
			this.dispatched = true;
			return { ...dispatchPollAnswer({ turnId: this.turn.turnId, botId: this.turn.botId ?? "bot-1" }, runtimeSupervisorClock), next_poll_ms: 250 };
		}
		return { dispatches: [], file_requests: [], drain: true, drain_reason: "lifetime", next_poll_ms: 250 };
	}

	async stopRequest(_request: OwnerStopRequest): Promise<OwnerStopResponse> {
		return { approved: true };
	}

	async renewCredentials(_request: OwnerCredentialsRequest): Promise<OwnerCredentialsResponse> {
		throw new Error("The disk scenario plane serves no credential renewal.");
	}

	replaceBearerToken(): void {
		throw new Error("The disk scenario plane serves no credential renewal.");
	}

	async postFileResult(): Promise<{ readonly recorded: true }> {
		return { recorded: true };
	}

	async sealOverlay(): Promise<{ readonly entries: [] }> {
		return { entries: [] };
	}

	async postOverlayApplied(): Promise<{ readonly remaining: number }> {
		return { remaining: 0 };
	}

	getComputer(): Promise<HostComputer> {
		return this.computerRoutes.getComputer();
	}

	setComputerStopped(stopped: boolean, startGeneration?: number, diskMatchesPublished?: boolean): Promise<HostComputer> {
		return this.computerRoutes.setComputerStopped(stopped, startGeneration, diskMatchesPublished);
	}

	recordComputerCapabilityReady(capability: string): Promise<HostComputer> {
		return this.computerRoutes.recordComputerCapabilityReady(capability);
	}

	recordComputerCapabilityUnavailable(capability: string): Promise<HostComputer> {
		return this.computerRoutes.recordComputerCapabilityUnavailable(capability);
	}

	recordComputerHydrated(workerId: string): Promise<void> {
		return this.computerRoutes.recordComputerHydrated(workerId);
	}

	publishComputerSnapshot(workerId: string, checksum: string, snapshotUri?: string): Promise<void> {
		return this.computerRoutes.publishComputerSnapshot(workerId, checksum, snapshotUri);
	}
}

/** Runs the child's work in this process; a kill ends the child at once and leaves the work to finish on its own. */
class InProcessChildSpawner implements ChildSpawner {
	private readonly workspaceRoot: string;
	private readonly turn: SupervisedTurn;

	constructor(workspaceRoot: string, turn: SupervisedTurn) {
		this.workspaceRoot = workspaceRoot;
		this.turn = turn;
	}

	spawn(): SpawnedChild {
		let finish: (exit: ChildExit) => void = () => undefined;
		const exited = new Promise<ChildExit>((resolve) => {
			finish = resolve;
		});
		void this.turn.work(this.workspaceRoot).then(
			(code) => finish({ code, signal: null }),
			() => finish({ code: 70, signal: null }),
		);
		return {
			pid: process.pid,
			kill: (signal) => finish({ code: null, signal }),
			exited,
		};
	}
}

const noProcessesToSweep: UnprivilegedProcessSweeper = { sweep: async () => 0 };

/** A supervised owner a scenario can end by telling the container to stop. */
export type RunningSupervisedOwner = {
	readonly supervisor: OwnerSupervisor;
	readonly ended: Promise<SupervisedRunResult>;
};

/**
 * Start a supervisor over the production Front Door, one disk and a child that runs in this process, with the real clock.
 * It dispatches the turn once it is idle, and when the turn's child has ended the control plane drains it, so the supervisor
 * publishes the disk if it changed, reports the computer stopped and exits. Without a turn it only hydrates and drains.
 *
 * @param world The scenario world.
 * @param ownerId The owner id; the host worker registered under it speaks for the supervisor on the computer routes.
 * @param generation The host start generation the supervisor was started for.
 * @param store The snapshot store the disk hydrates from and publishes to.
 * @param turn The turn the child serves.
 */
export async function startSupervisedOwner(
	world: ChatticusWorld,
	ownerId: string,
	generation: number,
	store: SnapshotObjectStore,
	turn: SupervisedTurn | null,
): Promise<RunningSupervisedOwner> {
	await ensureHostWorker(world, LIFECYCLE_TENANT, ownerId);
	const disk = hostDiskOf(world, ownerId);
	const plane = new DiskScenarioPlane(hostClientFor(world, ownerId), turn);
	const log = consoleLogEmitter({ tenant_id: LIFECYCLE_TENANT, owner_id: ownerId });
	const lines: string[] = [];
	const supervisor = new OwnerSupervisor({
		identity: { tenantId: LIFECYCLE_TENANT, ownerId, generation },
		environment: { PATH: process.env["PATH"] },
		plane,
		openDisk: () =>
			new HostDiskLifecycle(plane, {
				tenantId: LIFECYCLE_TENANT,
				ownerId,
				liveRoot: disk.liveRoot,
				store,
				log,
				overlayApplier: new SealingOverlayApplier({
					ownerId,
					generation,
					plane,
					launcher: UNUSED_FILE_HELPER_LAUNCHER,
					workspaceRoot: `${disk.liveRoot}/workspace`,
					blobs: new FakeOverlayBlobStore(disk.liveRoot),
					clock: runtimeSupervisorClock,
					log,
				}),
			}),
		spawner: new InProcessChildSpawner(`${disk.liveRoot}/workspace`, turn ?? { work: async () => 0 }),
		sweeper: noProcessesToSweep,
		fileHelperLauncher: UNUSED_FILE_HELPER_LAUNCHER,
		workspaceRoot: `${disk.liveRoot}/workspace`,
		clock: runtimeSupervisorClock,
		log: (event, fields) => {
			log(event, fields);
			lines.push(event);
		},
	});
	return { supervisor, ended: supervisor.run().then((exitCode) => ({ exitCode, logs: lines })) };
}
