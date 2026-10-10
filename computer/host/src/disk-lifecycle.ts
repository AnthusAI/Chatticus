import { consoleLogEmitter, errorNameOf, type LogEmitter } from "../../../conversation/src/observability/log-line.ts";
import { FilesystemSnapshotStore, type SnapshotObjectStore } from "../../../conversation/src/snapshot/store.ts";
import { S3SnapshotStore } from "../../../conversation/src/snapshot/s3.ts";
import { ComputerHostDisk } from "../../../conversation/src/snapshot/host.ts";
import { packChecksum, packLiveDisk } from "../../../conversation/src/snapshot/pack.ts";
import { snapshotUri } from "../../../conversation/src/snapshot/uri.ts";
import { liveRootFromEnvironment } from "./live-root.ts";
import type { HostProtocolClient } from "./protocol-client.ts";

/** What the disk lifecycle asks of the Front Door. */
export type HostDiskPlane = Pick<HostProtocolClient, "getComputer" | "recordComputerHydrated" | "publishComputerSnapshot">;

/** What hydrate and publish run on. A null store means the host has none configured. */
export type HostDiskOptions = {
	readonly tenantId: string;
	readonly workerId: string;
	readonly liveRoot?: string;
	readonly store?: SnapshotObjectStore | null;
	/** Receives `workspace_hydrated`, `snapshot_published` and `snapshot_skipped`; absent, each is one console line naming the tenant and the worker. */
	readonly log?: LogEmitter;
};

const logOf = (options: HostDiskOptions): LogEmitter => options.log ?? consoleLogEmitter({ tenant_id: options.tenantId, worker_id: options.workerId });

/**
 * Return the snapshot store configured on this host, or null.
 *
 * Hosts skip hydrate and publish when no store is configured. The filesystem root is the Gherkin stand-in. A bucket name
 * is honored only when `CHATTICUS_SNAPSHOT_BUCKET` is set explicitly; there is no default to the Anthus CDK bucket.
 */
export function snapshotStoreFromEnvironment(): SnapshotObjectStore | null {
	const root = (process.env["CHATTICUS_SNAPSHOT_STORE_ROOT"] ?? "").trim();
	if (root !== "") {
		return new FilesystemSnapshotStore(root);
	}
	const bucket = (process.env["CHATTICUS_SNAPSHOT_BUCKET"] ?? "").trim();
	if (bucket !== "") {
		return new S3SnapshotStore(bucket);
	}
	return null;
}

/** Return True when *error* means the configured bucket does not exist. */
export function isNoSuchBucketError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const named = error as { name?: string; Code?: string };
	return ["NoSuchBucket", "404"].includes(String(named.Code ?? named.name ?? ""));
}

function storeOf(options: HostDiskOptions): SnapshotObjectStore | null {
	return options.store === undefined ? snapshotStoreFromEnvironment() : options.store;
}

/**
 * Return the checksum of the current host live-disk pack.
 *
 * @param liveRoot The host live-disk root.
 */
export async function liveDiskPackChecksum(liveRoot: string): Promise<string> {
	return packChecksum(await packLiveDisk(liveRoot));
}

/**
 * Return True when live host bytes differ from the last published pack.
 *
 * @param liveRoot The host live-disk root.
 * @param publishedChecksum The checksum the computer last published, or null when nothing was published.
 */
export async function hostDiskNeedsPublish(liveRoot: string, publishedChecksum: string | null): Promise<boolean> {
	if (publishedChecksum === null) {
		return true;
	}
	return (await liveDiskPackChecksum(liveRoot)) !== publishedChecksum;
}

/**
 * Load a published pack onto the host disk when a store is configured.
 *
 * @param plane The Front Door.
 * @param options The organization, the worker, the live root and the store.
 * @returns True when a snapshot was hydrated.
 */
export async function hydrateOnBoot(plane: HostDiskPlane, options: HostDiskOptions): Promise<boolean> {
	const log = logOf(options);
	const startedAt = Date.now();
	const resolvedStore = storeOf(options);
	if (resolvedStore === null) {
		log("workspace_hydrated", { generation: null, reason: "no_store", duration_ms: Date.now() - startedAt });
		return false;
	}
	const computer = await plane.getComputer();
	if (computer.snapshot_uri === undefined) {
		log("workspace_hydrated", { generation: null, reason: "no_snapshot", duration_ms: Date.now() - startedAt });
		return false;
	}
	const root = options.liveRoot ?? liveRootFromEnvironment();
	const disk = new ComputerHostDisk(root, resolvedStore);
	const needsHydrateRecord = computer.hydrate_required;
	try {
		await disk.hydrate({ tenant_id: options.tenantId, computer_id: computer.computer_id });
	} catch (error) {
		if (isNoSuchBucketError(error)) {
			console.warn(
				`computer_host_hydrate_skipped_missing_bucket tenant_id=${options.tenantId} computer_id=${computer.computer_id} bucket=${resolvedStore.bucket}`,
			);
			log("workspace_hydrated", { generation: null, reason: "missing_bucket", duration_ms: Date.now() - startedAt });
			return false;
		}
		log("workspace_hydrate_failed", { generation: computer.snapshot_generation, error_name: errorNameOf(error), duration_ms: Date.now() - startedAt });
		throw error;
	}
	if (needsHydrateRecord) {
		await plane.recordComputerHydrated(options.workerId);
	}
	log("workspace_hydrated", { generation: computer.snapshot_generation, duration_ms: Date.now() - startedAt });
	return true;
}

/**
 * Pack and upload a dirty host disk, then persist snapshot metadata.
 *
 * @param plane The Front Door.
 * @param options The organization, the worker, the live root and the store.
 * @returns True when a pack was published.
 */
export async function publishBeforeExit(plane: HostDiskPlane, options: HostDiskOptions): Promise<boolean> {
	const log = logOf(options);
	const startedAt = Date.now();
	const resolvedStore = storeOf(options);
	if (resolvedStore === null) {
		log("snapshot_skipped", { reason: "no_store" });
		return false;
	}
	const computer = await plane.getComputer();
	const root = options.liveRoot ?? liveRootFromEnvironment();
	if (!(await hostDiskNeedsPublish(root, computer.snapshot_checksum ?? null))) {
		log("snapshot_skipped", { reason: "unchanged", generation: computer.snapshot_generation });
		return false;
	}
	const disk = new ComputerHostDisk(root, resolvedStore);
	let manifest;
	try {
		manifest = await disk.publish({ tenant_id: options.tenantId, computer_id: computer.computer_id, worker_id: options.workerId });
	} catch (error) {
		if (isNoSuchBucketError(error)) {
			console.warn(
				`computer_host_publish_skipped_missing_bucket tenant_id=${options.tenantId} computer_id=${computer.computer_id} bucket=${resolvedStore.bucket}`,
			);
			log("snapshot_skipped", { reason: "missing_bucket", generation: computer.snapshot_generation });
			return false;
		}
		log("snapshot_publish_failed", { generation: computer.snapshot_generation, error_name: errorNameOf(error), duration_ms: Date.now() - startedAt });
		throw error;
	}
	const uri = snapshotUri(options.tenantId, computer.computer_id, { bucket: resolvedStore.bucket });
	await plane.publishComputerSnapshot(options.workerId, manifest.checksum, uri);
	const published = await plane.getComputer();
	log("snapshot_published", { generation: published.snapshot_generation, duration_ms: Date.now() - startedAt });
	return true;
}
