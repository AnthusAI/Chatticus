import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostDiskNeedsPublish, liveDiskPackChecksum } from "../../computer/host/src/disk-lifecycle.ts";
import { packChecksum, packLiveDisk } from "../src/snapshot/pack.ts";

const roots: string[] = [];

function freshRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pack-determinism-"));
	roots.push(root);
	return root;
}

function writeTree(root: string, order: readonly string[]): void {
	for (const relative of order) {
		const path = join(root, relative);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, `content of ${relative}`);
	}
}

const FILES = ["workspace/a.txt", "workspace/sub/b.txt", "workspace/sub/c.txt", "workspace/z.txt"];

function touchAll(root: string, seconds: number): void {
	for (const relative of FILES) {
		utimesSync(join(root, relative), seconds, seconds);
	}
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("snapshot pack determinism", () => {
	it("packs identical content to identical bytes regardless of mtimes", async () => {
		const root = freshRoot();
		writeTree(root, FILES);
		touchAll(root, 1_700_000_000);
		const first = await liveDiskPackChecksum(root);
		touchAll(root, 1_800_000_000);
		const second = await liveDiskPackChecksum(root);
		expect(second).toBe(first);
	});

	it("packs identical content to identical bytes regardless of creation order and time", async () => {
		const left = freshRoot();
		const right = freshRoot();
		writeTree(left, FILES);
		writeTree(right, [...FILES].reverse());
		touchAll(right, 1_600_000_000);
		expect(packChecksum(await packLiveDisk(right))).toBe(packChecksum(await packLiveDisk(left)));
	});

	it("does not republish an unchanged disk", async () => {
		const root = freshRoot();
		writeTree(root, FILES);
		const published = await liveDiskPackChecksum(root);
		expect(await hostDiskNeedsPublish(root, published)).toBe(false);
	});

	it("does not republish after an mtime-only change", async () => {
		const root = freshRoot();
		writeTree(root, FILES);
		const published = await liveDiskPackChecksum(root);
		touchAll(root, 1_900_000_000);
		expect(await hostDiskNeedsPublish(root, published)).toBe(false);
	});

	it("republishes when a file content changes", async () => {
		const root = freshRoot();
		writeTree(root, FILES);
		const published = await liveDiskPackChecksum(root);
		writeFileSync(join(root, "workspace/a.txt"), "different");
		expect(await hostDiskNeedsPublish(root, published)).toBe(true);
	});

	it("republishes when a file is added", async () => {
		const root = freshRoot();
		writeTree(root, FILES);
		const published = await liveDiskPackChecksum(root);
		writeFileSync(join(root, "workspace/new.txt"), "new");
		expect(await hostDiskNeedsPublish(root, published)).toBe(true);
	});

	it("republishes when a file is removed", async () => {
		const root = freshRoot();
		writeTree(root, FILES);
		const published = await liveDiskPackChecksum(root);
		rmSync(join(root, "workspace/z.txt"));
		expect(await hostDiskNeedsPublish(root, published)).toBe(true);
	});

	it("republishes when a file is renamed", async () => {
		const root = freshRoot();
		writeTree(root, FILES);
		const published = await liveDiskPackChecksum(root);
		renameSync(join(root, "workspace/z.txt"), join(root, "workspace/y.txt"));
		expect(await hostDiskNeedsPublish(root, published)).toBe(true);
	});
});
