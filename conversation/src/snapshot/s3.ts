import type { S3Client } from "@aws-sdk/client-s3";
import {
	AbortMultipartUploadCommand,
	CompleteMultipartUploadCommand,
	CreateMultipartUploadCommand,
	GetObjectCommand,
	PutObjectCommand,
	UploadPartCommand,
} from "@aws-sdk/client-s3";
import type { SnapshotManifest, SnapshotObjectStore } from "./store.ts";
import { MANIFEST_FILENAME, PACK_FILENAME, snapshotBucketAndPrefix } from "./uri.ts";
import { indexObjectName } from "./index-format.ts";
import { SnapshotObjectMissingError, SnapshotPackError } from "./pack.ts";

/** The size at which the pack stream is cut into upload parts; S3 requires at least 5 MiB for every part but the last. */
export const PACK_UPLOAD_PART_BYTES = 8 * 1024 * 1024;

/**
 * Object store backed by the CDK snapshot bucket.
 */
export class S3SnapshotStore implements SnapshotObjectStore {
	bucket: string;
	private client: S3Client | null = null;

	constructor(bucket: string, client?: S3Client | null) {
		this.bucket = bucket;
		this.client = client || null;
	}

	/**
	 * Stream the pack to the bucket. A pack that fits in one part is one `PutObject`; a larger one is a multipart upload that
	 * holds at most one part in memory, so memory does not grow with the size of the workspace. A failed upload is aborted.
	 */
	async putPack(snapshotUri: string, chunks: AsyncIterable<Buffer>): Promise<void> {
		const client = await this.getClient();
		const [bucket, prefix] = snapshotBucketAndPrefix(snapshotUri);
		const key = `${prefix}/${PACK_FILENAME}`;
		let uploadId: string | null = null;
		const completed: { ETag: string; PartNumber: number }[] = [];
		let pending: Buffer[] = [];
		let pendingBytes = 0;

		const uploadPart = async (): Promise<void> => {
			const body = Buffer.concat(pending);
			pending = [];
			pendingBytes = 0;
			if (uploadId === null) {
				const created = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: "application/gzip" }));
				if (created.UploadId === undefined) throw new SnapshotPackError("S3 did not return an upload id.");
				uploadId = created.UploadId;
			}
			const partNumber = completed.length + 1;
			const response = await client.send(
				new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: body }),
			);
			if (response.ETag === undefined) throw new SnapshotPackError("S3 did not return a part ETag.");
			completed.push({ ETag: response.ETag, PartNumber: partNumber });
		};

		try {
			for await (const chunk of chunks) {
				pending.push(chunk);
				pendingBytes += chunk.length;
				if (pendingBytes >= PACK_UPLOAD_PART_BYTES) await uploadPart();
			}
			if (uploadId === null) {
				await client.send(
					new PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.concat(pending), ContentType: "application/gzip" }),
				);
				return;
			}
			if (pendingBytes > 0) await uploadPart();
			await client.send(
				new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: completed } }),
			);
		} catch (error) {
			if (uploadId !== null) {
				await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId })).catch(() => undefined);
			}
			throw error;
		}
	}

	async putIndex(snapshotUri: string, packChecksum: string, serializedIndex: Buffer): Promise<void> {
		const client = await this.getClient();
		const [bucket, prefix] = snapshotBucketAndPrefix(snapshotUri);
		await client.send(
			new PutObjectCommand({
				Bucket: bucket,
				Key: `${prefix}/${indexObjectName(packChecksum)}`,
				Body: serializedIndex,
				ContentType: "application/json",
			}),
		);
	}

	async putManifest(snapshotUri: string, manifest: SnapshotManifest): Promise<void> {
		const client = await this.getClient();
		const [bucket, prefix] = snapshotBucketAndPrefix(snapshotUri);
		const payload = JSON.stringify(manifest, null, 2) + "\n";
		await client.send(
			new PutObjectCommand({
				Bucket: bucket,
				Key: `${prefix}/${MANIFEST_FILENAME}`,
				Body: Buffer.from(payload),
				ContentType: "application/json",
			}),
		);
	}

	async getPack(snapshotUri: string): Promise<Buffer> {
		const client = await this.getClient();
		const [bucket, prefix] = snapshotBucketAndPrefix(snapshotUri);
		return this.getBytes(client, bucket, `${prefix}/${PACK_FILENAME}`);
	}

	async getPackRange(snapshotUri: string, offset: number, length: number): Promise<Buffer> {
		const client = await this.getClient();
		const [bucket, prefix] = snapshotBucketAndPrefix(snapshotUri);
		return this.getBytes(client, bucket, `${prefix}/${PACK_FILENAME}`, `bytes=${offset}-${offset + length - 1}`);
	}

	async getIndexBytes(snapshotUri: string, packChecksum: string): Promise<Buffer> {
		const client = await this.getClient();
		const [bucket, prefix] = snapshotBucketAndPrefix(snapshotUri);
		return this.getBytes(client, bucket, `${prefix}/${indexObjectName(packChecksum)}`);
	}

	async getManifest(snapshotUri: string): Promise<SnapshotManifest> {
		const client = await this.getClient();
		const [bucket, prefix] = snapshotBucketAndPrefix(snapshotUri);
		const payload = await this.getBytes(client, bucket, `${prefix}/${MANIFEST_FILENAME}`);
		return JSON.parse(payload.toString()) as SnapshotManifest;
	}

	private async getClient(): Promise<S3Client> {
		if (!this.client) {
			try {
				const { S3Client } = await import("@aws-sdk/client-s3");
				this.client = new S3Client({});
			} catch (error) {
				throw new SnapshotPackError(
					"@aws-sdk/client-s3 is required for the S3 snapshot store. " +
					"Install with npm install @aws-sdk/client-s3."
				);
			}
		}
		return this.client;
	}

	private async getBytes(client: S3Client, bucket: string, key: string, range?: string): Promise<Buffer> {
		try {
			const response = await client.send(
				new GetObjectCommand({ Bucket: bucket, Key: key, ...(range === undefined ? {} : { Range: range }) })
			);

			const stream = response.Body as unknown as AsyncIterable<Uint8Array>;
			const chunks: Buffer[] = [];

			if (stream && typeof stream[Symbol.asyncIterator] === "function") {
				for await (const chunk of stream) {
					chunks.push(Buffer.from(chunk));
				}
			} else {
				throw new Error("Response body is not iterable");
			}

			return Buffer.concat(chunks);
		} catch (error) {
			const clientError = error as { __type?: string; Code?: string; message?: string };
			if (
				clientError.__type === "NoSuchKey" ||
				clientError.Code === "NoSuchKey" ||
				clientError.Code === "404" ||
				(clientError.message && clientError.message.includes("NoSuchKey"))
			) {
				throw new SnapshotObjectMissingError(`No snapshot object s3://${bucket}/${key}.`);
			}
			throw error;
		}
	}
}
