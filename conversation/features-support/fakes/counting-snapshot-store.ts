import { FilesystemSnapshotStore } from "../../src/snapshot/store.ts";

/** A snapshot store on a local directory that counts how many times a whole pack was downloaded, so a scenario can tell an extraction from a cache that matched. */
export class CountingSnapshotStore extends FilesystemSnapshotStore {
	/** How many times the whole pack was read. */
	packReads = 0;

	override getPack(snapshotUri: string): Buffer {
		this.packReads += 1;
		return super.getPack(snapshotUri);
	}
}
