import type { S3Client } from "@aws-sdk/client-s3";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import type { SnapshotManifest } from "./store.ts";
import { MANIFEST_FILENAME, PACK_FILENAME, snapshotBucketAndPrefix } from "./uri.ts";
import { SnapshotPackError } from "./pack.ts";

/**
 * Object store backed by the CDK snapshot bucket.
 */
export class S3SnapshotStore {
	bucket: string;
	private client: S3Client | null = null;

	constructor(bucket: string, client?: S3Client | null) {
		this.bucket = bucket;
		this.client = client || null;
	}

	async put(snapshotUri: string, pack: Buffer, manifest: SnapshotManifest): Promise<void> {
		const client = await this.getClient();
		const [bucket, prefix] = snapshotBucketAndPrefix(snapshotUri);

		await client.send(
			new PutObjectCommand({
				Bucket: bucket,
				Key: `${prefix}/${PACK_FILENAME}`,
				Body: pack,
				ContentType: "application/gzip",
			})
		);

		const payload = JSON.stringify(manifest, null, 2) + "\n";
		await client.send(
			new PutObjectCommand({
				Bucket: bucket,
				Key: `${prefix}/${MANIFEST_FILENAME}`,
				Body: Buffer.from(payload),
				ContentType: "application/json",
			})
		);
	}

	async getPack(snapshotUri: string): Promise<Buffer> {
		const client = await this.getClient();
		const [bucket, prefix] = snapshotBucketAndPrefix(snapshotUri);
		return this.getBytes(client, bucket, `${prefix}/${PACK_FILENAME}`);
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

	private async getBytes(client: S3Client, bucket: string, key: string): Promise<Buffer> {
		try {
			const response = await client.send(
				new GetObjectCommand({ Bucket: bucket, Key: key })
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
				throw new SnapshotPackError(`No snapshot object s3://${bucket}/${key}.`);
			}
			throw error;
		}
	}
}
