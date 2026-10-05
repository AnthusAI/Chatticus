import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { URL } from "node:url";
import {
	MANIFEST_FILENAME,
	PACK_FILENAME,
	LOGICAL_SNAPSHOT_BUCKET,
	defaultSnapshotBucket,
	snapshotObjectDir,
} from "./uri.ts";
import { SnapshotPackError } from "./pack.ts";

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
}

/**
 * Put and get snapshot packs by canonical URI.
 */
export interface SnapshotObjectStore {
	bucket: string;
	put(snapshotUri: string, pack: Buffer, manifest: SnapshotManifest): void | Promise<void>;
	getPack(snapshotUri: string): Buffer | Promise<Buffer>;
	getManifest(snapshotUri: string): SnapshotManifest | Promise<SnapshotManifest>;
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

	put(snapshotUri: string, pack: Buffer, manifest: SnapshotManifest): void {
		const directory = this.getDirectory(snapshotUri);
		mkdirSync(directory, { recursive: true });
		atomicWrite(join(directory, PACK_FILENAME), pack);
		const payload = JSON.stringify(manifest, null, 2) + "\n";
		atomicWrite(join(directory, MANIFEST_FILENAME), Buffer.from(payload));
	}

	getPack(snapshotUri: string): Buffer {
		const path = join(this.getDirectory(snapshotUri), PACK_FILENAME);
		try {
			return readFileSync(path);
		} catch {
			throw new SnapshotPackError(`No snapshot pack at ${JSON.stringify(snapshotUri)}.`);
		}
	}

	getManifest(snapshotUri: string): SnapshotManifest {
		const path = join(this.getDirectory(snapshotUri), MANIFEST_FILENAME);
		try {
			const payload = readFileSync(path, "utf-8");
			return JSON.parse(payload) as SnapshotManifest;
		} catch {
			throw new SnapshotPackError(`No snapshot manifest at ${JSON.stringify(snapshotUri)}.`);
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
