import { GetObjectCommand, type GetObjectCommandOutput } from "@aws-sdk/client-s3";

/** Reads raw inbound messages from the raw mail archive, the system of record for received mail. */
export interface RawMailReader {
	/** The bytes stored under the key, or null when no such object exists. */
	read(key: string): Promise<Uint8Array | null>;
}

/** The part of an S3 client the archive reader uses. */
export interface S3ObjectReader {
	send(command: GetObjectCommand): Promise<Pick<GetObjectCommandOutput, "Body">>;
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

	async read(key: string): Promise<Uint8Array | null> {
		try {
			const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
			return (await response.Body?.transformToByteArray()) ?? null;
		} catch (error) {
			if ((error as { name?: string }).name === "NoSuchKey") return null;
			throw error;
		}
	}
}
