import { readFileSync, writeFileSync, mkdirSync, renameSync, createWriteStream, openSync, readSync, closeSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join, resolve, basename } from "node:path";
import { URL } from "node:url";
import {
	MANIFEST_FILENAME,
	PACK_FILENAME,
	LOGICAL_SNAPSHOT_BUCKET,
	defaultSnapshotBucket,
	snapshotObjectDir,
} from "./uri.ts";
import { SnapshotObjectMissingError, SnapshotPackError } from "./pack.ts";
import { indexObjectName } from "./index-format.ts";

/**
 * Metadata stored next to a snapshot pack.
 */
export interface SnapshotManifest {
	tenant_id: string;
	computer_id: string;
	checksum: string;
	published_by_worker_id: string;
	published_at: string;
	image_digest?: string | null;
	pack_filename?: string;
	/** SHA-256 of the serialized index stored at `index/<checksum>.json`; a manifest without it names no index. */
	index_checksum?: string;
}

/**
 * What the Front Door reads from a published snapshot: the manifest, the index it names, and byte ranges of the pack.
 */
export interface SnapshotReadStore {
	bucket: string;
	getManifest(snapshotUri: string): SnapshotManifest | Promise<SnapshotManifest>;
	getIndexBytes(snapshotUri: string, packChecksum: string): Buffer | Promise<Buffer>;
	getPackRange(snapshotUri: string, offset: number, length: number): Buffer | Promise<Buffer>;
}

/**
 * Put and get snapshot packs by canonical URI. A publish writes the pack, then the index, then the manifest, so a reader
 * that finds a manifest finds the index it names.
 */
export interface SnapshotObjectStore extends SnapshotReadStore {
	putPack(snapshotUri: string, chunks: AsyncIterable<Buffer>): Promise<void>;
	putIndex(snapshotUri: string, packChecksum: string, serializedIndex: Buffer): void | Promise<void>;
	putManifest(snapshotUri: string, manifest: SnapshotManifest): void | Promise<void>;
	getPack(snapshotUri: string): Buffer | Promise<Buffer>;
}

/**
 * Object store rooted on a local directory.
 *
 * URIs keep the `s3://chatticus/...` form so a Mac and a Fargate task
 * can later share a real bucket without changing callers.
 */
export class FilesystemSnapshotStore implements SnapshotObjectStore {
	root: string;
	bucket: string;

	constructor(root: string, bucket?: string | null) {
		this.root = resolve(root);
		this.bucket = bucket || defaultSnapshotBucket();
		mkdirSync(this.root, { recursive: true });
	}

	async putPack(snapshotUri: string, chunks: AsyncIterable<Buffer>): Promise<void> {
		const directory = this.getDirectory(snapshotUri);
		mkdirSync(directory, { recursive: true });
		const target = join(directory, PACK_FILENAME);
		const temporary = join(directory, `.${PACK_FILENAME}.tmp`);
		await pipeline(Readable.from(chunks), createWriteStream(temporary));
		renameSync(temporary, target);
	}

	putIndex(snapshotUri: string, packChecksum: string, serializedIndex: Buffer): void {
		const target = join(this.getDirectory(snapshotUri), indexObjectName(packChecksum));
		mkdirSync(resolve(target, ".."), { recursive: true });
		atomicWrite(target, serializedIndex);
	}

	putManifest(snapshotUri: string, manifest: SnapshotManifest): void {
		const directory = this.getDirectory(snapshotUri);
		mkdirSync(directory, { recursive: true });
		const payload = JSON.stringify(manifest, null, 2) + "\n";
		atomicWrite(join(directory, MANIFEST_FILENAME), Buffer.from(payload));
	}

	getPack(snapshotUri: string): Buffer {
		const path = join(this.getDirectory(snapshotUri), PACK_FILENAME);
		try {
			return readFileSync(path);
		} catch {
			throw new SnapshotObjectMissingError(`No snapshot pack at ${JSON.stringify(snapshotUri)}.`);
		}
	}

	getPackRange(snapshotUri: string, offset: number, length: number): Buffer {
		const path = join(this.getDirectory(snapshotUri), PACK_FILENAME);
		let descriptor: number;
		try {
			descriptor = openSync(path, "r");
		} catch {
			throw new SnapshotObjectMissingError(`No snapshot pack at ${JSON.stringify(snapshotUri)}.`);
		}
		try {
			const buffer = Buffer.alloc(length);
			const bytesRead = readSync(descriptor, buffer, 0, length, offset);
			return buffer.subarray(0, bytesRead);
		} finally {
			closeSync(descriptor);
		}
	}

	getIndexBytes(snapshotUri: string, packChecksum: string): Buffer {
		const path = join(this.getDirectory(snapshotUri), indexObjectName(packChecksum));
		try {
			return readFileSync(path);
		} catch {
			throw new SnapshotObjectMissingError(`No snapshot index at ${JSON.stringify(snapshotUri)} for ${packChecksum}.`);
		}
	}

	getManifest(snapshotUri: string): SnapshotManifest {
		const path = join(this.getDirectory(snapshotUri), MANIFEST_FILENAME);
		let payload: string;
		try {
			payload = readFileSync(path, "utf-8");
		} catch {
			throw new SnapshotObjectMissingError(`No snapshot manifest at ${JSON.stringify(snapshotUri)}.`);
		}
		try {
			return JSON.parse(payload) as SnapshotManifest;
		} catch {
			throw new SnapshotPackError(`Snapshot manifest at ${JSON.stringify(snapshotUri)} is not valid JSON.`);
		}
	}

	private getDirectory(snapshotUri: string): string {
		return join(this.root, snapshotObjectDir(snapshotUri));
	}
}

/**
 * Open a filesystem store or the CDK S3 bucket.
 *
 * `s3` or `s3://bucket` uses the AWS bucket created by
 * `ChatticusSnapshots`. Any other value is a local directory.
 */
export async function openSnapshotStore(store: string): Promise<SnapshotObjectStore> {
	if (store === "s3" || store.startsWith("s3://")) {
		const { S3SnapshotStore } = await import("./s3.ts");

		if (store === "s3") {
			const bucket = defaultSnapshotBucket();
			if (bucket === LOGICAL_SNAPSHOT_BUCKET) {
				throw new SnapshotPackError(
					"CHATTICUS_SNAPSHOT_BUCKET is not set. Deploy infra/ with " +
					"CDK and export the SnapshotBucketName output."
				);
			}
			return new S3SnapshotStore(bucket);
		}

		let parsed: URL;
		try {
			parsed = new URL(store);
		} catch {
			throw new SnapshotPackError(`Invalid S3 store location ${JSON.stringify(store)}.`);
		}

		if (parsed.protocol !== "s3:" || !parsed.hostname) {
			throw new SnapshotPackError(`Invalid S3 store location ${JSON.stringify(store)}.`);
		}

		return new S3SnapshotStore(parsed.hostname);
	}

	return new FilesystemSnapshotStore(store);
}

/**
 * Write data atomically to a file.
 */
function atomicWrite(path: string, data: Buffer): void {
	const temporary = join(resolve(path, ".."), `.${basename(path)}.tmp`);
	writeFileSync(temporary, data);
	renameSync(temporary, path);
}
