import type { LogEmitter } from "../../src/observability/log-line.ts";
import type { OverlayEntryReference } from "../../../computer/host/src/overlay-applier.ts";
import type { SupervisorClock, SupervisorDisk } from "../../../computer/host/src/supervisor-ports.ts";

/**
 * The computer's disk as a scenario scripts it: it restores at once, knows whether the workspace changed since the last
 * publish, and takes a couple of seconds of fake time to publish, so a poll can report `publishing` meanwhile. It writes the
 * lines the real disk lifecycle writes.
 */
export class FakeSupervisorDisk implements SupervisorDisk {
	workspaceChanged = false;
	restoreFails = false;
	publishFailuresToCome = 0;
	publishMilliseconds = 2000;
	readonly publishedAtMilliseconds: number[] = [];

	private readonly clock: SupervisorClock;
	private readonly log: LogEmitter;

	constructor(clock: SupervisorClock, log: LogEmitter) {
		this.clock = clock;
		this.log = log;
	}

	async hydrate(): Promise<readonly OverlayEntryReference[]> {
		if (this.restoreFails) throw new Error("the download failed");
		this.log("workspace_hydrated", { generation: null, reason: "no_snapshot" });
		return [];
	}

	async clearApplied(): Promise<boolean> {
		return true;
	}

	async needsPublish(): Promise<boolean> {
		if (this.workspaceChanged) return true;
		this.log("snapshot_skipped", { reason: "unchanged" });
		return false;
	}

	async publish(): Promise<void> {
		await this.clock.sleep(this.publishMilliseconds);
		if (this.publishFailuresToCome > 0) {
			this.publishFailuresToCome -= 1;
			this.log("snapshot_publish_failed", { error_name: "Error" });
			throw new Error("the upload failed");
		}
		this.workspaceChanged = false;
		this.publishedAtMilliseconds.push(this.clock.nowMilliseconds());
		this.log("snapshot_published", { generation: this.publishedAtMilliseconds.length });
	}
}
