import { createHash } from "node:crypto";
import { join } from "node:path";
import { overlayBlobObject } from "@chatticus/host-protocol/edit-overlay";
import type { OverlayBlobReader } from "../../../computer/host/src/overlay-applier.ts";
import { FilesystemOverlayStore, type OverlayLocation } from "../../src/snapshot/overlay-store.ts";

const LOCATION: OverlayLocation = { tenantId: "anthus", computerId: "household-computer" };

/** The SHA-256 of bytes in hex, as the overlay names a blob. */
export const blobHashOf = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/**
 * The blobs of a scenario's edit overlay, kept on a local directory with the real overlay store and its key discipline, and
 * read the way the supervisor reads them: by content hash, read-only. A scenario can drop a blob, store other bytes under a
 * hash, or make a read fail.
 */
export class FakeOverlayBlobStore implements OverlayBlobReader {
	/** Hashes whose read fails as an unreachable bucket would. */
	readonly unreadable = new Set<string>();
	/** How many reads were asked of the store. */
	reads = 0;

	private readonly store: FilesystemOverlayStore;

	constructor(directory: string) {
		this.store = new FilesystemOverlayStore(join(directory, "overlay-blobs"));
	}

	/** Store the content under its own hash and return the hash. */
	async put(content: string): Promise<string> {
		const sha256 = blobHashOf(content);
		await this.putUnder(sha256, Buffer.from(content, "utf8"));
		return sha256;
	}

	/** Store bytes under a hash they do not have. */
	async putUnder(sha256: string, bytes: Buffer): Promise<void> {
		await this.store.putIfAbsent(LOCATION, overlayBlobObject(sha256), bytes);
	}

	async read(sha256: string): Promise<Buffer | null> {
		this.reads += 1;
		if (this.unreadable.has(sha256)) throw new Error("the bucket cannot be reached");
		const answer = await this.store.get(LOCATION, overlayBlobObject(sha256));
		return answer.kind === "found" ? answer.object.body : null;
	}
}
