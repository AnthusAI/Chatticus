import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { browserProfileDir, ensureBrowserProfilesLayout, UNTRUSTED_PARTITION, WORKSPACE_DIRNAME } from "../browser-profiles.ts";
import { consoleLogEmitter, type LogEmitter } from "../observability/log-line.ts";
import { PACK_MAX_FILE_BYTES } from "./exclusions.ts";
import { indexChecksumOf, serializeIndex } from "./index-format.ts";
import { CACHE_CHECKSUM_FILENAME, packChecksum, streamLiveDisk, unpackLiveDisk } from "./pack.ts";
import type { SnapshotManifest, SnapshotObjectStore } from "./store.ts";
import { snapshotUri } from "./uri.ts";

/**
 * The downloaded pack does not match the published checksum.
 */
export class SnapshotChecksumMismatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SnapshotChecksumMismatchError";
	}
}

/**
 * Live workplace files on one host, hydrated from a shared store.
 *
 * This is the Mac, Fargate, or EC2 cache. The store is the checkpoint
 * every host can see. Publish uploads. Hydrate downloads unless the
 * local checksum already matches.
 */
export class ComputerHostDisk {
	liveRoot: string;
	store: SnapshotObjectStore;

	constructor(liveRoot: string, store: SnapshotObjectStore) {
		this.liveRoot = resolve(liveRoot);
		this.store = store;
		mkdirSync(this.liveRoot, { recursive: true });
		ensureBrowserProfilesLayout(this.liveRoot);
		mkdirSync(join(this.liveRoot, WORKSPACE_DIRNAME), { recursive: true });
	}

	/**
	 * Write a file under the host's `workspace` tree.
	 */
	writeWorkspaceFile(relativePath: string, content: string): void {
		const path = safeJoin(join(this.liveRoot, WORKSPACE_DIRNAME), relativePath);
		mkdirSync(resolve(path, ".."), { recursive: true });
		writeFileSync(path, content);
	}

	/**
	 * Write a file under one partitioned Chromium user-data tree.
	 */
	writeBrowserProfileFile(
		relativePath: string,
		content: string,
		{ storagePartition = UNTRUSTED_PARTITION }: { storagePartition?: string } = {}
	): void {
		const profileRoot = browserProfileDir(this.liveRoot, storagePartition);
		const path = safeJoin(profileRoot, relativePath);
		mkdirSync(resolve(path, ".."), { recursive: true });
		writeFileSync(path, content);
	}

	/**
	 * Read a workspace file from this host's live disk.
	 */
	readWorkspaceFile(relativePath: string): string {
		return readFileSync(safeJoin(join(this.liveRoot, WORKSPACE_DIRNAME), relativePath), "utf-8");
	}

	/**
	 * Read a browser-profile file from one partitioned user-data tree.
	 */
	readBrowserProfileFile(
		relativePath: string,
		{ storagePartition = UNTRUSTED_PARTITION }: { storagePartition?: string } = {}
	): string {
		const profileRoot = browserProfileDir(this.liveRoot, storagePartition);
		return readFileSync(safeJoin(profileRoot, relativePath), "utf-8");
	}

	/**
	 * Stream the live disk to the shared store as a pack, then write its index, then the manifest that names both.
	 * Each oversized file left out of the pack is reported to `log` as `snapshot_file_skipped`.
	 */
	async publish(options: {
		tenant_id: string;
		computer_id: string;
		worker_id: string;
		image_digest?: string | null;
		published_at?: Date | null;
		log?: LogEmitter;
	}): Promise<SnapshotManifest> {
		const uri = snapshotUri(options.tenant_id, options.computer_id, { bucket: this.store.bucket });
		const log = options.log ?? consoleLogEmitter({ tenant_id: options.tenant_id, computer_id: options.computer_id });
		const live = streamLiveDisk(this.liveRoot, {
			onSkippedFile: (path, sizeBytes) => log("snapshot_file_skipped", { path, size_bytes: sizeBytes, limit_bytes: PACK_MAX_FILE_BYTES }),
		});
		await this.store.putPack(uri, live.chunks);
		const { checksum, index } = live.result();
		const serializedIndex = serializeIndex(index);
		await Promise.resolve(this.store.putIndex(uri, checksum, serializedIndex));
		const manifest: SnapshotManifest = {
			tenant_id: options.tenant_id,
			computer_id: options.computer_id,
			checksum,
			published_by_worker_id: options.worker_id,
			published_at: (options.published_at || new Date()).toISOString(),
			image_digest: options.image_digest || undefined,
			pack_filename: "snapshot.tar.gz",
			index_checksum: indexChecksumOf(serializedIndex),
		};
		await Promise.resolve(this.store.putManifest(uri, manifest));

		this.writeChecksum(checksum);
		return manifest;
	}

	/**
	 * Load the published snapshot unless this host already has it.
	 */
	async hydrate(options: {
		tenant_id: string;
		computer_id: string;
	}): Promise<SnapshotManifest> {
		const uri = snapshotUri(options.tenant_id, options.computer_id, { bucket: this.store.bucket });
		const manifest = await Promise.resolve(this.store.getManifest(uri));

		if (this.cacheMatches(manifest.checksum)) {
			return manifest;
		}

		const pack = await Promise.resolve(this.store.getPack(uri));
		const actual = packChecksum(pack);

		if (actual !== manifest.checksum) {
			throw new SnapshotChecksumMismatchError(
				`Snapshot pack checksum ${JSON.stringify(actual)} does not match ` +
				`manifest ${JSON.stringify(manifest.checksum)}.`
			);
		}

		await unpackLiveDisk(pack, this.liveRoot);
		ensureBrowserProfilesLayout(this.liveRoot);
		this.writeChecksum(manifest.checksum);

		return manifest;
	}

	/**
	 * Return True if the local cache already holds this snapshot.
	 */
	cacheMatches(checksum: string): boolean {
		const cache = join(this.liveRoot, CACHE_CHECKSUM_FILENAME);
		if (!existsSync(cache)) {
			return false;
		}

		const cached = readFileSync(cache, "utf-8").trim();
		if (cached !== checksum) {
			return false;
		}

		return existsSync(join(this.liveRoot, WORKSPACE_DIRNAME));
	}

	private writeChecksum(checksum: string): void {
		writeFileSync(join(this.liveRoot, CACHE_CHECKSUM_FILENAME), checksum + "\n");
	}
}

/**
 * Check if a path is within root and resolve it safely.
 */
export function safeJoin(root: string, relativePath: string): string {
	const resolvedRoot = resolve(root);
	const candidate = resolve(root, relativePath);

	if (candidate !== resolvedRoot && !candidate.startsWith(resolvedRoot + "/")) {
		throw new Error(`Path ${JSON.stringify(relativePath)} escapes ${resolvedRoot}.`);
	}

	return candidate;
}
