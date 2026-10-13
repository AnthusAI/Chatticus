import type { S3Client } from "@aws-sdk/client-s3";
import { overlayBlobObject } from "@chatticus/host-protocol/edit-overlay";
import { S3OverlayStore, type OverlayLocation } from "../../../conversation/src/snapshot/overlay-store.ts";
import type { OverlayBlobReader } from "./overlay-applier.ts";

/**
 * Reads overlay blobs from the snapshot bucket with the supervisor's own credentials. The supervisor role may read the
 * overlay and is explicitly denied every write to it, so this class only ever calls the store's `get`.
 */
export class S3OverlayBlobReader implements OverlayBlobReader {
	private readonly store: S3OverlayStore;
	private readonly locationOf: () => Promise<OverlayLocation>;

	/**
	 * @param bucket The snapshot bucket.
	 * @param client An S3 client holding the supervisor's credentials.
	 * @param locationOf The organization and the computer whose overlay is read; asked on first use.
	 */
	constructor(bucket: string, client: S3Client, locationOf: () => Promise<OverlayLocation>) {
		this.store = new S3OverlayStore(bucket, client);
		this.locationOf = locationOf;
	}

	async read(sha256: string): Promise<Buffer | null> {
		const answer = await this.store.get(await this.locationOf(), overlayBlobObject(sha256));
		return answer.kind === "found" ? answer.object.body : null;
	}
}
