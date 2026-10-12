import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerHostDisk } from "./host.ts";
import { unpackLiveDisk } from "./pack.ts";
import type { SnapshotObjectStore } from "./store.ts";
import { snapshotUri } from "./uri.ts";

/** One computer whose current snapshot the re-index looks at. */
export interface ReindexTarget {
	tenantId: string;
	computerId: string;
}

/** What the re-index did, or would do, for one computer. */
export interface ReindexResult {
	tenantId: string;
	computerId: string;
	outcome: "already_indexed" | "would_reindex" | "reindexed" | "failed";
	reason?: string;
}

/**
 * Give every listed computer's current snapshot a v2 pack and an index.
 *
 * A snapshot whose manifest already names an index is left alone, so running it again changes nothing. For any other, the
 * pack is unpacked into a scratch directory, packed again in the v2 layout (per-file members, default exclusions) and
 * published with its index and a new manifest that keeps the original publish time, worker and image digest. Without
 * `execute` nothing is read from the pack or written.
 *
 * The pack object is replaced before the manifest is, so run it while the computers are stopped: a host that hydrates in
 * between sees a pack that does not match the manifest and refuses it until the run finishes.
 *
 * @param store The snapshot store of the environment.
 * @param targets The computers to look at.
 * @param options `execute` writes; otherwise the run only reports.
 */
export async function reindexSnapshots(
	store: SnapshotObjectStore,
	targets: readonly ReindexTarget[],
	options: { execute: boolean; scratchRoot?: string },
): Promise<ReindexResult[]> {
	const results: ReindexResult[] = [];
	for (const target of targets) {
		const uri = snapshotUri(target.tenantId, target.computerId, { bucket: store.bucket });
		try {
			const manifest = await Promise.resolve(store.getManifest(uri));
			if (manifest.index_checksum !== undefined) {
				results.push({ ...target, outcome: "already_indexed" });
				continue;
			}
			if (!options.execute) {
				results.push({ ...target, outcome: "would_reindex" });
				continue;
			}
			const scratch = mkdtempSync(join(options.scratchRoot ?? tmpdir(), "reindex-"));
			try {
				await unpackLiveDisk(await Promise.resolve(store.getPack(uri)), scratch);
				await new ComputerHostDisk(scratch, store).publish({
					tenant_id: target.tenantId,
					computer_id: target.computerId,
					worker_id: manifest.published_by_worker_id,
					image_digest: manifest.image_digest ?? null,
					published_at: new Date(manifest.published_at),
					log: (event, fields) => process.stdout.write(`${event} ${JSON.stringify(fields ?? {})}\n`),
				});
			} finally {
				rmSync(scratch, { recursive: true, force: true });
			}
			results.push({ ...target, outcome: "reindexed" });
		} catch (error) {
			results.push({ ...target, outcome: "failed", reason: error instanceof Error ? error.message : String(error) });
		}
	}
	return results;
}
