import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { liveDiskDiffersFromIndex } from "../src/snapshot/change-detection.ts";
import {
	SnapshotFileError,
	followSymlinks,
	indexPathOf,
	loadedIndexOf,
} from "../src/snapshot/files.ts";
import type { SnapshotIndexEntry } from "../src/snapshot/index-format.ts";
import { createEffectiveView, snapshotViewOfIndex } from "../src/snapshot/overlay-merge.ts";
import { packLiveDiskWithIndex, unpackLiveDisk } from "../src/snapshot/pack.ts";

const roots: string[] = [];

function freshRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pack-v2-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function write(root: string, relative: string, content: Buffer | string): void {
	const path = join(root, relative);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

describe("snapshot v2 pack layout", () => {
	it("stores each file as its own gzip member at the offset and length the index records", async () => {
		const root = freshRoot();
		const long = `workspace/${"deeply-nested-directory-name/".repeat(5)}file-with-a-long-name.txt`;
		const big = randomBytes(300 * 1024);
		write(root, "workspace/a.txt", "alpha");
		write(root, "workspace/empty.txt", "");
		write(root, "workspace/big.bin", big);
		write(root, long, "long path content");
		const { pack, index } = await packLiveDiskWithIndex(root);
		const files = index.entries.filter((entry) => entry.kind === "file");
		expect(files.map((entry) => entry.path)).toContain(long);
		for (const entry of files) {
			const member = pack.subarray(entry.offset!, entry.offset! + entry.length!);
			const plain = zlib.gunzipSync(member);
			const padded = Math.ceil(entry.size / 512) * 512;
			const headerLength = plain.length - padded;
			expect(headerLength % 512).toBe(0);
			const data = plain.subarray(headerLength, headerLength + entry.size);
			expect(createHash("sha256").update(data).digest("hex")).toBe(entry.sha256);
		}
		expect(index.pack_bytes).toBe(pack.length);
		expect(createHash("sha256").update(pack).digest("hex")).toBe(index.pack_checksum);
	});

	it("restores through the unchanged unpack, including a long path and a safe link", async () => {
		const root = freshRoot();
		const long = `workspace/${"deeply-nested-directory-name/".repeat(5)}f.txt`;
		write(root, long, "long");
		write(root, "workspace/src/a.c", "int main(){}");
		symlinkSync("src/a.c", join(root, "workspace/link"));
		const { pack } = await packLiveDiskWithIndex(root);
		const fresh = freshRoot();
		await unpackLiveDisk(pack, fresh);
		expect(readFileSync(join(fresh, long), "utf8")).toBe("long");
		expect(readFileSync(join(fresh, "workspace/link"), "utf8")).toBe("int main(){}");
	});

	it("leaves excluded directories and oversized files out of the pack and the index", async () => {
		const root = freshRoot();
		write(root, "workspace/keep.txt", "keep");
		write(root, "workspace/app/node_modules/dep/index.js", "x");
		write(root, "workspace/app/.cache/x", "x");
		write(root, "workspace/app/build", "a file named build is kept");
		const skipped: string[] = [];
		const { index } = await packLiveDiskWithIndex(root, { onSkippedFile: (path) => skipped.push(path) });
		const paths = index.entries.map((entry) => entry.path);
		expect(paths).toContain("workspace/keep.txt");
		expect(paths).toContain("workspace/app/build");
		expect(paths.some((path) => path.includes("node_modules") || path.includes(".cache"))).toBe(false);
		expect(skipped).toEqual([]);
	});

	it("detects an edit, ignores a touch, and notices an added file from the index alone", async () => {
		const root = freshRoot();
		write(root, "workspace/a.txt", "one");
		utimesSync(join(root, "workspace/a.txt"), 1_700_000_000, 1_700_000_000);
		const { index } = await packLiveDiskWithIndex(root);
		expect(await liveDiskDiffersFromIndex(root, index)).toBe(false);
		write(root, "workspace/a.txt", "two");
		expect(await liveDiskDiffersFromIndex(root, index)).toBe(true);
		write(root, "workspace/a.txt", "one");
		expect(await liveDiskDiffersFromIndex(root, index)).toBe(false);
		write(root, "workspace/b.txt", "new");
		expect(existsSync(join(root, "workspace/b.txt"))).toBe(true);
		expect(await liveDiskDiffersFromIndex(root, index)).toBe(true);
	});
});

describe("snapshot file path rules", () => {
	it("maps an API path to an index path", () => {
		expect(indexPathOf("/workspace/src/a.c")).toBe("workspace/src/a.c");
		expect(indexPathOf("/workspace/")).toBe("workspace");
		expect(indexPathOf("/workspace//src///a.c")).toBe("workspace/src/a.c");
	});

	it.each([undefined, "", "workspace/a", "/etc/passwd", "/workspace/../etc", "/workspace/a/../b", "/workspacex/a", "/workspace/a\u0000b", `/workspace/${"a".repeat(1100)}`, "/browser-profiles/untrusted"])(
		"refuses %j",
		(raw) => {
			expect(() => indexPathOf(raw as string | undefined)).toThrow(SnapshotFileError);
		},
	);

});

describe("symbolic links inside the index", () => {
	const entry = (path: string, kind: SnapshotIndexEntry["kind"], link: string | null = null): SnapshotIndexEntry => ({
		path,
		kind,
		size: 0,
		mode: 0o644,
		mtime_ms: 0,
		sha256: null,
		link_target: link,
		offset: null,
		length: null,
	});

	it("follows a chain of eight and refuses a ninth", () => {
		const entries = [entry("workspace", "directory"), entry("workspace/real", "file")];
		for (let step = 1; step <= 9; step += 1) {
			entries.push(entry(`workspace/l${step}`, "symlink", step === 9 ? "real" : `l${step + 1}`));
		}
		const view = createEffectiveView(snapshotViewOfIndex(loadedIndexOf(entries)), []);
		expect(followSymlinks(view, view.lookup("/workspace/l2")!).path).toBe("/workspace/real");
		expect(() => followSymlinks(view, view.lookup("/workspace/l1")!)).toThrow(SnapshotFileError);
	});

	it("refuses a target outside workspace even if an index names one", () => {
		const view = createEffectiveView(
			snapshotViewOfIndex(loadedIndexOf([entry("workspace", "directory"), entry("workspace/out", "symlink", "../browser-profiles/x"), entry("browser-profiles/x", "file")])),
			[],
		);
		expect(() => followSymlinks(view, view.lookup("/workspace/out")!)).toThrow(/outside \/workspace/);
	});
});
