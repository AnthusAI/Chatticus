import type { LogEmitter } from "../../../conversation/src/observability/log-line.ts";
import type { SnapshotObjectStore } from "../../../conversation/src/snapshot/store.ts";
import { ComputerHostBootDriver, type HostBootPlane } from "./boot.ts";
import { diskChangedSincePublish, publishChangedDisk } from "./disk-lifecycle.ts";
import type { SupervisorDisk } from "./supervisor-ports.ts";

/** Where the computer's disk lives and as whom the supervisor reports it. */
export type HostDiskLifecycleOptions = {
	readonly tenantId: string;
	/** The owner id; the snapshot metadata is published under it. */
	readonly ownerId: string;
	readonly liveRoot: string;
	readonly store: SnapshotObjectStore | null;
	readonly log: LogEmitter;
	/** Runs after the snapshot is hydrated, for example to share the hydrated workspace with the unprivileged shell. */
	readonly afterHydrate?: () => Promise<void>;
};

/**
 * The computer's disk driven by the supervisor: the host boot driver for the model and workspace gates and the hydrate, and
 * the disk lifecycle for the change scan and the publish, all over the supervisor's own Front Door plane.
 */
export class HostDiskLifecycle implements SupervisorDisk {
	private readonly plane: HostBootPlane;
	private readonly options: HostDiskLifecycleOptions;

	constructor(plane: HostBootPlane, options: HostDiskLifecycleOptions) {
		this.plane = plane;
		this.options = options;
	}

	async hydrate(): Promise<void> {
		await new ComputerHostBootDriver(this.plane, {
			tenantId: this.options.tenantId,
			workerId: this.options.ownerId,
			liveRoot: this.options.liveRoot,
			store: this.options.store,
			log: this.options.log,
		}).bootThroughWorkspace();
		await this.options.afterHydrate?.();
	}

	async needsPublish(): Promise<boolean> {
		return diskChangedSincePublish(this.plane, this.diskOptions());
	}

	async publish(): Promise<void> {
		await publishChangedDisk(this.plane, this.diskOptions());
	}

	private diskOptions() {
		return {
			tenantId: this.options.tenantId,
			workerId: this.options.ownerId,
			liveRoot: this.options.liveRoot,
			store: this.options.store,
			log: this.options.log,
		};
	}
}
