import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { resolve, join } from "node:path";
import type { SnapshotIndex } from "./index-format.ts";
import { walkLiveDisk } from "./pack.ts";

async function sha256OfFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) {
		hash.update(chunk as Buffer);
	}
	return hash.digest("hex");
}

/**
 * Whether the live disk differs from the snapshot an index describes.
 *
 * The scan compares paths, kinds, permission bits, link targets, sizes and modified times against the index and reads a
 * file only when its size or modified time moved; a file whose time moved but whose bytes hash the same as the index is
 * not a change. A disk that no file was added to, removed from or edited on therefore costs one directory walk and no
 * file reads, where packing it again would read every byte.
 *
 * @param liveRoot The live-disk root.
 * @param index The index of the last published pack.
 * @returns True when a new pack would differ from the published one.
 */
export async function liveDiskDiffersFromIndex(liveRoot: string, index: SnapshotIndex): Promise<boolean> {
	const resolvedRoot = resolve(liveRoot);
	const members = walkLiveDisk(resolvedRoot);
	if (members.length !== index.entries.length) return true;
	for (const [position, member] of members.entries()) {
		const recorded = index.entries[position];
		if (recorded === undefined) return true;
		if (member.path !== recorded.path || member.kind !== recorded.kind || member.mode !== recorded.mode) return true;
		if (member.link_target !== recorded.link_target) return true;
		if (member.kind !== "file") continue;
		if (member.size !== recorded.size) return true;
		if (member.mtime_ms === recorded.mtime_ms) continue;
		try {
			if ((await sha256OfFile(join(resolvedRoot, member.path))) !== recorded.sha256) return true;
		} catch {
			return true;
		}
	}
	return false;
}
