import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { S3Client } from "@aws-sdk/client-s3";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { OVERLAY_INDEX_OBJECT } from "@chatticus/host-protocol/edit-overlay";
import { snapshotBucketAndPrefix, snapshotUri } from "./uri.ts";

/** Which computer's overlay an operation addresses. The object key is built from these two ids and a checked name, never from a member-chosen string. */
export type OverlayLocation = { readonly tenantId: string; readonly computerId: string };

/** One stored object and the entity tag that names this version of it. */
export type OverlayObject = { readonly body: Buffer; readonly etag: string };

/** The answer to a read: the object, "not modified" when the caller's tag is still current, or absent. */
export type OverlayReadResult =
	| { readonly kind: "found"; readonly object: OverlayObject }
	| { readonly kind: "not_modified"; readonly etag: string }
	| { readonly kind: "absent" };

/** The answer to a conditional write: the new entity tag, or the news that the condition did not hold. */
export type OverlayWriteResult = { readonly kind: "written"; readonly etag: string } | { readonly kind: "precondition_failed" };

/**
 * The objects of the edit overlay under a computer's snapshot prefix. The Front Door is the only writer. The index is the
 * one compare-and-swap target (replaced only with the entity tag it was read with); blobs are content-addressed and written
 * only when absent. Both implementations give the same answers to the same sequence of calls, which the shared contract
 * test holds them to.
 */
export interface OverlayStore {
	/** Read an object. With `knownEtag` equal to the current tag the answer is `not_modified` and no body is returned. */
	get(location: OverlayLocation, key: string, knownEtag?: string): Promise<OverlayReadResult>;
	/** Create an object only if none exists (`If-None-Match: *`). */
	putIfAbsent(location: OverlayLocation, key: string, body: Buffer): Promise<OverlayWriteResult>;
	/** Replace an object only if its current entity tag is `etag` (`If-Match`). An absent object does not match. */
	putIfMatch(location: OverlayLocation, key: string, body: Buffer, etag: string): Promise<OverlayWriteResult>;
	/** Delete an object; deleting an absent object is not an error. */
	delete(location: OverlayLocation, key: string): Promise<void>;
}

const BLOB_KEY = /^overlay\/blobs\/[0-9a-f]{64}$/;

/**
 * Refuse any object name other than the index and a hash-named blob, so no caller can reach another object of the bucket by
 * choosing a key.
 *
 * @param key The object name relative to the computer's prefix.
 * @throws Error When the name is neither `overlay/index.json` nor `overlay/blobs/{sha256}`.
 */
export function assertOverlayObjectKey(key: string): void {
	if (key !== OVERLAY_INDEX_OBJECT && !BLOB_KEY.test(key)) {
		throw new Error(`${JSON.stringify(key)} is not an overlay object name.`);
	}
}

/** The prefix under which a computer's snapshot objects live, checked for safe path segments. */
function computerPrefixOf(bucket: string, location: OverlayLocation): string {
	const [, prefix] = snapshotBucketAndPrefix(snapshotUri(location.tenantId, location.computerId, { bucket }));
	return prefix;
}

type ErrorWithStatus = { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };

const statusOf = (error: unknown): number | undefined => (error as ErrorWithStatus).$metadata?.httpStatusCode;
const nameOf = (error: unknown): string | undefined => (error as ErrorWithStatus).name ?? (error as ErrorWithStatus).Code;

/**
 * The overlay in the snapshot bucket, written with S3 conditional puts (`IfNoneMatch: "*"` and `IfMatch`). A failed
 * condition (412), a conflicting concurrent write (409) and an `If-Match` on an absent object (404) all answer
 * `precondition_failed`: the caller re-reads and re-judges.
 */
export class S3OverlayStore implements OverlayStore {
	private readonly bucket: string;
	private readonly client: S3Client;

	/**
	 * @param bucket The snapshot bucket.
	 * @param client The S3 client.
	 */
	constructor(bucket: string, client: S3Client) {
		this.bucket = bucket;
		this.client = client;
	}

	async get(location: OverlayLocation, key: string, knownEtag?: string): Promise<OverlayReadResult> {
		assertOverlayObjectKey(key);
		try {
			const response = await this.client.send(
				new GetObjectCommand({
					Bucket: this.bucket,
					Key: this.keyOf(location, key),
					...(knownEtag === undefined ? {} : { IfNoneMatch: knownEtag }),
				}),
			);
			const bytes = await response.Body!.transformToByteArray();
			return { kind: "found", object: { body: Buffer.from(bytes), etag: response.ETag as string } };
		} catch (error) {
			if (statusOf(error) === 304) return { kind: "not_modified", etag: knownEtag as string };
			if (nameOf(error) === "NoSuchKey" || statusOf(error) === 404) return { kind: "absent" };
			throw error;
		}
	}

	async putIfAbsent(location: OverlayLocation, key: string, body: Buffer): Promise<OverlayWriteResult> {
		assertOverlayObjectKey(key);
		return this.conditionalPut(location, key, body, { IfNoneMatch: "*" });
	}

	async putIfMatch(location: OverlayLocation, key: string, body: Buffer, etag: string): Promise<OverlayWriteResult> {
		assertOverlayObjectKey(key);
		return this.conditionalPut(location, key, body, { IfMatch: etag });
	}

	async delete(location: OverlayLocation, key: string): Promise<void> {
		assertOverlayObjectKey(key);
		await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.keyOf(location, key) }));
	}

	private keyOf(location: OverlayLocation, key: string): string {
		return `${computerPrefixOf(this.bucket, location)}/${key}`;
	}

	private async conditionalPut(
		location: OverlayLocation,
		key: string,
		body: Buffer,
		condition: { IfNoneMatch: string } | { IfMatch: string },
	): Promise<OverlayWriteResult> {
		try {
			const response = await this.client.send(
				new PutObjectCommand({
					Bucket: this.bucket,
					Key: this.keyOf(location, key),
					Body: body,
					ContentType: key === OVERLAY_INDEX_OBJECT ? "application/json" : "text/plain; charset=utf-8",
					...condition,
				}),
			);
			return { kind: "written", etag: response.ETag as string };
		} catch (error) {
			const status = statusOf(error);
			if (status === 412 || status === 409 || (status === 404 && "IfMatch" in condition)) return { kind: "precondition_failed" };
			throw error;
		}
	}
}

const etagOf = (body: Buffer): string => `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;

/**
 * The overlay on a local directory, for scenarios and local runs. Every method is one synchronous block of file operations,
 * so a compare-and-swap cannot interleave with another call of the same process, which gives it the semantics of the S3
 * implementation. The entity tag is derived from the content.
 */
export class FilesystemOverlayStore implements OverlayStore {
	private readonly root: string;
	private readonly bucket: string;

	/**
	 * @param root The directory the objects are kept in.
	 * @param bucket The logical bucket name the keys are validated with.
	 */
	constructor(root: string, bucket = "chatticus") {
		this.root = resolve(root);
		this.bucket = bucket;
		mkdirSync(this.root, { recursive: true });
	}

	async get(location: OverlayLocation, key: string, knownEtag?: string): Promise<OverlayReadResult> {
		const path = this.pathOf(location, key);
		if (!existsSync(path)) return { kind: "absent" };
		const body = readFileSync(path);
		const etag = etagOf(body);
		if (knownEtag !== undefined && knownEtag === etag) return { kind: "not_modified", etag };
		return { kind: "found", object: { body, etag } };
	}

	async putIfAbsent(location: OverlayLocation, key: string, body: Buffer): Promise<OverlayWriteResult> {
		const path = this.pathOf(location, key);
		if (existsSync(path)) return { kind: "precondition_failed" };
		return this.write(path, body);
	}

	async putIfMatch(location: OverlayLocation, key: string, body: Buffer, etag: string): Promise<OverlayWriteResult> {
		const path = this.pathOf(location, key);
		if (!existsSync(path) || etagOf(readFileSync(path)) !== etag) return { kind: "precondition_failed" };
		return this.write(path, body);
	}

	async delete(location: OverlayLocation, key: string): Promise<void> {
		rmSync(this.pathOf(location, key), { force: true });
	}

	private pathOf(location: OverlayLocation, key: string): string {
		assertOverlayObjectKey(key);
		return join(this.root, computerPrefixOf(this.bucket, location), key);
	}

	private write(path: string, body: Buffer): OverlayWriteResult {
		mkdirSync(dirname(path), { recursive: true });
		const temporary = `${path}.${randomUUID()}.tmp`;
		writeFileSync(temporary, body);
		renameSync(temporary, path);
		return { kind: "written", etag: etagOf(body) };
	}
}
