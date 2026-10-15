import type { LogEmitter } from "../../src/observability/log-line.ts";
import type { OverlayEntryReference } from "../../../computer/host/src/overlay-applier.ts";
import type { StorageCredentialsProvider, SupervisorClock, SupervisorDisk } from "../../../computer/host/src/supervisor-ports.ts";

/** One request the disk made to storage: whose credentials it was signed with when it began, and when it began and ended. */
export type RecordedStorageRequest = {
	readonly operation: string;
	readonly accessKeyId: string;
	readonly startedAtMilliseconds: number;
	finishedAtMilliseconds: number | null;
};

/**
 * The computer's disk as a scenario scripts it: it restores at once, knows whether the workspace changed since the last
 * publish, and takes a couple of seconds of fake time to publish, so a poll can report `publishing` meanwhile. It writes the
 * lines the real disk lifecycle writes. When a scenario gives it a number of storage requests per publish it asks the
 * credentials provider the supervisor handed it at the start of each request, as the real storage client does, and records
 * which credentials each request carried.
 */
export class FakeSupervisorDisk implements SupervisorDisk {
	workspaceChanged = false;
	restoreFails = false;
	publishFailuresToCome = 0;
	publishMilliseconds = 2000;
	/** How many storage requests one publish sends; zero means the publish is one wait of {@link publishMilliseconds}. */
	storageRequestsPerPublish = 0;
	/** How long each storage request of a publish takes. */
	storageRequestMilliseconds = 0;
	readonly publishedAtMilliseconds: number[] = [];
	readonly storageRequests: RecordedStorageRequest[] = [];
	readonly publishErrors: unknown[] = [];

	private readonly clock: SupervisorClock;
	private readonly log: LogEmitter;
	private credentials: StorageCredentialsProvider | null = null;

	constructor(clock: SupervisorClock, log: LogEmitter) {
		this.clock = clock;
		this.log = log;
	}

	/** Receive the credentials provider the supervisor handed to `openDisk`. */
	attachCredentials(credentials: StorageCredentialsProvider): void {
		this.credentials = credentials;
	}

	/** The credentials provider the supervisor handed over, for a probe that reads it the way the storage client does. */
	get credentialsProvider(): StorageCredentialsProvider {
		if (this.credentials === null) throw new Error("The supervisor opened no disk with a credentials provider.");
		return this.credentials;
	}

	/** Send one storage request now, as the storage client would: read the credentials, begin, run, end. */
	async storageRequest(operation: string, durationMilliseconds: number = this.storageRequestMilliseconds): Promise<void> {
		const identity = await this.credentialsProvider();
		const record: RecordedStorageRequest = { operation, accessKeyId: identity.accessKeyId, startedAtMilliseconds: this.clock.nowMilliseconds(), finishedAtMilliseconds: null };
		this.storageRequests.push(record);
		if (durationMilliseconds > 0) await this.clock.sleep(durationMilliseconds);
		record.finishedAtMilliseconds = this.clock.nowMilliseconds();
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
		try {
			if (this.storageRequestsPerPublish > 0) {
				for (let index = 1; index <= this.storageRequestsPerPublish; index += 1) await this.storageRequest(`publish_part_${index}`);
			} else {
				await this.clock.sleep(this.publishMilliseconds);
			}
		} catch (error) {
			this.publishErrors.push(error);
			this.log("snapshot_publish_failed", { error_name: "Error" });
			throw error;
		}
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
