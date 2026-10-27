import { GetObjectCommand, type GetObjectCommandOutput } from "@aws-sdk/client-s3";

/** What reading one object of the raw mail archive found. */
export type RawMailRead =
	| { readonly kind: "found"; readonly bytes: Uint8Array }
	| { readonly kind: "missing" }
	| { readonly kind: "too_large"; readonly sizeBytes: number };

/** Reads raw inbound messages from the raw mail archive, the system of record for received mail. */
export interface RawMailReader {
	/**
	 * Read the object under the key. The size is checked before the body is read: an object above the limit is reported and its
	 * body is never consumed.
	 *
	 * @param key The archive key.
	 * @param maximumBytes The largest object that may be read.
	 */
	read(key: string, maximumBytes: number): Promise<RawMailRead>;
}

/** The part of an S3 client the archive reader uses. */
export interface S3ObjectReader {
	send(command: GetObjectCommand): Promise<Pick<GetObjectCommandOutput, "Body" | "ContentLength">>;
}

/** The raw mail archive in S3, read with `GetObject` on the one bucket. */
export class S3RawMailReader implements RawMailReader {
	private readonly client: S3ObjectReader;
	private readonly bucket: string;

	/**
	 * @param client The S3 client.
	 * @param bucket The raw mail bucket.
	 */
	constructor(client: S3ObjectReader, bucket: string) {
		this.client = client;
		this.bucket = bucket;
	}

	async read(key: string, maximumBytes: number): Promise<RawMailRead> {
		let response: Pick<GetObjectCommandOutput, "Body" | "ContentLength">;
		try {
			response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
		} catch (error) {
			if ((error as { name?: string }).name === "NoSuchKey") return { kind: "missing" };
			throw error;
		}
		const sizeBytes = response.ContentLength;
		if (sizeBytes !== undefined && sizeBytes > maximumBytes) {
			(response.Body as { destroy?: () => void } | undefined)?.destroy?.();
			return { kind: "too_large", sizeBytes };
		}
		const bytes = await response.Body?.transformToByteArray();
		if (bytes === undefined) return { kind: "missing" };
		return bytes.length > maximumBytes ? { kind: "too_large", sizeBytes: bytes.length } : { kind: "found", bytes };
	}
}
