import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runOwnerFileRequest, type OwnerFileRequest, type OwnerFileResponse } from "../src/pi/owner-file-helper.ts";
import { treeHashOf, symlinkHashOf } from "@chatticus/host-protocol/live-file-rules";

const sha = (text: string | Uint8Array): string => createHash("sha256").update(text).digest("hex");

let workspace: string;

beforeEach(() => {
	workspace = realpathSync(mkdtempSync(join(tmpdir(), "owner-file-helper-")));
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

const ask = (request: Omit<OwnerFileRequest, "allowedRoots">, hooks?: Parameters<typeof runOwnerFileRequest>[1]): Promise<OwnerFileResponse> =>
	runOwnerFileRequest({ allowedRoots: [workspace], refuseGitSegments: true, ...request }, hooks);

const failureCode = (response: OwnerFileResponse): string => (response.ok ? "ok" : response.code);

describe("the helper's atomic write", () => {
	it("keeps the replaced bytes beside the file when an in-place writer wins the window before the rename", async () => {
		const path = join(workspace, "notes.md");
		writeFileSync(path, "one");
		const response = await ask(
			{ operation: "write", path, content: "two", precondition: { type: "if_match", sha256: sha("one") } },
			{ beforePublish: async () => appendFileSync(path, "-concurrent") },
		);
		expect(response.ok).toBe(true);
		if (!response.ok) return;
		expect(readFileSync(path, "utf8")).toBe("two");
		expect(response.keptAs).toMatch(/^\/workspace\/notes\.md\.chatticus-replaced-[0-9a-f]{8}$/);
		const kept = readdirSync(workspace).find((name) => name.includes("chatticus-replaced"));
		expect(readFileSync(join(workspace, kept!), "utf8")).toBe("one-concurrent");
	});

	it("leaves no temporary file behind on any failure", async () => {
		const path = join(workspace, "notes.md");
		writeFileSync(path, "one");
		let reachedSecondStage = false;
		const stale = await ask(
			{ operation: "write", path, content: "two", precondition: { type: "if_match", sha256: sha("zero") } },
			{ afterFirstComparison: async () => void (reachedSecondStage = true) },
		);
		expect(failureCode(stale)).toBe("precondition_failed");
		expect(reachedSecondStage).toBe(false);
		const raced = await ask(
			{ operation: "write", path, content: "two", precondition: { type: "if_match", sha256: sha("one") } },
			{
				beforePublish: async () => {
					throw new Error("the hook failed");
				},
			},
		);
		expect(raced.ok).toBe(false);
		expect(readdirSync(workspace)).toEqual(["notes.md"]);
		expect(readFileSync(path, "utf8")).toBe("one");
	});

	it("refuses a replace when a writer changes the file between the first and the second comparison", async () => {
		const path = join(workspace, "notes.md");
		writeFileSync(path, "one");
		const response = await ask(
			{ operation: "write", path, content: "two", precondition: { type: "if_match", sha256: sha("one") } },
			{ afterFirstComparison: async () => writeFileSync(path, "theirs") },
		);
		expect(failureCode(response)).toBe("precondition_failed");
		expect(!response.ok && response.currentSha256).toBe(sha("theirs"));
		expect(readFileSync(path, "utf8")).toBe("theirs");
		expect(readdirSync(workspace)).toEqual(["notes.md"]);
	});

	it("creates a file exclusively and loses to a creator that wins the window", async () => {
		const path = join(workspace, "new.md");
		const response = await ask({ operation: "write", path, content: "mine", precondition: { type: "if_none_match" } }, { beforePublish: async () => writeFileSync(path, "theirs") });
		expect(failureCode(response)).toBe("already_exists");
		expect(readFileSync(path, "utf8")).toBe("theirs");
		expect(readdirSync(workspace)).toEqual(["new.md"]);
	});

	it("keeps the mode of the file it replaces and gives a new file 0664", async () => {
		const path = join(workspace, "script.sh");
		writeFileSync(path, "one", { mode: 0o755 });
		await ask({ operation: "write", path, content: "two", precondition: { type: "if_match", sha256: sha("one") } });
		const replaced = await ask({ operation: "stat", path });
		expect(replaced.ok && replaced.mode).toBe("755");
	});

	it("refuses text with a NUL and text over 256 KiB, and a Pi write needs no precondition and creates parents", async () => {
		expect(failureCode(await ask({ operation: "write", path: join(workspace, "a"), content: "a\u0000b", precondition: { type: "if_none_match" } }))).toBe("not_text");
		expect(failureCode(await ask({ operation: "write", path: join(workspace, "b"), content: "x".repeat(262145), precondition: { type: "if_none_match" } }))).toBe("file_too_large");
		const pi = await ask({ operation: "write", path: join(workspace, "deep/er/c.txt"), contentBase64: Buffer.from("pi").toString("base64"), createParents: true, refuseGitSegments: false });
		expect(pi.ok).toBe(true);
		expect(readFileSync(join(workspace, "deep/er/c.txt"), "utf8")).toBe("pi");
	});
});

describe("the helper's containment", () => {
	it("refuses to read, write, list, delete or rename through a link that leads out of the workspace", async () => {
		const outside = realpathSync(mkdtempSync(join(tmpdir(), "owner-file-helper-outside-")));
		try {
			writeFileSync(join(outside, "secret"), "owner-secret");
			symlinkSync(join(outside, "secret"), join(workspace, "leak"));
			symlinkSync(outside, join(workspace, "out"));
			writeFileSync(join(workspace, "a"), "a");
			expect(failureCode(await ask({ operation: "read", path: join(workspace, "leak") }))).toBe("outside_workspace");
			expect(failureCode(await ask({ operation: "write", path: join(workspace, "leak"), content: "x", precondition: { type: "if_none_match" } }))).toBe("outside_workspace");
			expect(failureCode(await ask({ operation: "list", path: join(workspace, "out") }))).toBe("outside_workspace");
			expect(failureCode(await ask({ operation: "unlink", path: join(workspace, "out/secret"), sha256: sha("owner-secret") }))).toBe("outside_workspace");
			expect(failureCode(await ask({ operation: "rename", path: join(workspace, "a"), to: join(workspace, "out/a"), sha256: sha("a") }))).toBe("outside_workspace");
			expect(readFileSync(join(outside, "secret"), "utf8")).toBe("owner-secret");
			expect(readdirSync(outside)).toEqual(["secret"]);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("the helper's reads and listings", () => {
	it("reads a range, hashes the whole file and trims a character boundary", async () => {
		const path = join(workspace, "text.txt");
		writeFileSync(path, "aaaaébbbb");
		const response = await ask({ operation: "read", path, range: { offset: 0, length: 5, maxFileBytes: 1000, mask: true } });
		expect(response.ok).toBe(true);
		if (!response.ok) return;
		expect(response.content).toBe("aaaa");
		expect(response.truncated).toBe(true);
		expect(response.sha256).toBe(sha(readFileSync(path)));
		expect(response.binary).toBe(false);
	});

	it("masks a secret reached through a link with an ordinary name", async () => {
		writeFileSync(join(workspace, ".env"), "TOKEN=abc");
		symlinkSync(".env", join(workspace, "config.txt"));
		const response = await ask({ operation: "read", path: join(workspace, "config.txt"), range: { offset: 0, length: 100, maxFileBytes: 1000, mask: true } });
		expect(response.ok && response.masked).toBe(true);
		expect(response.ok && response.content).toBe("");
		const revealed = await ask({ operation: "read", path: join(workspace, "config.txt"), range: { offset: 0, length: 100, maxFileBytes: 1000, mask: false } });
		expect(revealed.ok && revealed.content).toBe("TOKEN=abc");
	});

	it("refuses a file over the limit and answers a binary file in base64", async () => {
		writeFileSync(join(workspace, "big"), Buffer.alloc(2000, 1));
		expect(failureCode(await ask({ operation: "read", path: join(workspace, "big"), range: { offset: 0, length: 10, maxFileBytes: 1000, mask: false } }))).toBe("file_too_large");
		writeFileSync(join(workspace, "bin"), Buffer.from([0, 1, 2, 3]));
		const binary = await ask({ operation: "read", path: join(workspace, "bin"), range: { offset: 0, length: 10, maxFileBytes: 1000, mask: false } });
		expect(binary.ok && binary.encoding).toBe("base64");
	});

	it("cuts a listing at the entry cap and at the scan cap and says it is truncated", async () => {
		for (let index = 0; index < 5; index += 1) writeFileSync(join(workspace, `f${index}`), "x");
		const capped = await ask({ operation: "list", path: workspace, maxEntries: 3, maxScan: 100 });
		expect(capped.ok && capped.entries?.length).toBe(3);
		expect(capped.ok && capped.truncated).toBe(true);
		const scanned = await ask({ operation: "list", path: workspace, maxEntries: 100, maxScan: 2 });
		expect(scanned.ok && scanned.truncated).toBe(true);
		expect(scanned.ok && scanned.entries?.length).toBe(2);
	});

	it("leaves a pipe out of a listing", async () => {
		const { execFileSync } = await import("node:child_process");
		execFileSync("mkfifo", [join(workspace, "pipe")]);
		writeFileSync(join(workspace, "a"), "x");
		const listed = await ask({ operation: "list", path: workspace, maxEntries: 10, maxScan: 10 });
		expect(listed.ok && listed.entries?.map((entry) => entry.name)).toEqual(["a"]);
	});
});

describe("the helper's delete, rename and new folders", () => {
	it("computes the tree hash the way the shared rules define it", async () => {
		mkdirSync(join(workspace, "tree/sub"), { recursive: true });
		writeFileSync(join(workspace, "tree/a.txt"), "abc");
		writeFileSync(join(workspace, "tree/sub/b.txt"), "de");
		symlinkSync("a.txt", join(workspace, "tree/l"));
		const expected = treeHashOf(
			[
				{ relativePath: "a.txt", kind: "file", size: 3 },
				{ relativePath: "sub", kind: "dir" },
				{ relativePath: "sub/b.txt", kind: "file", size: 2 },
				{ relativePath: "l", kind: "symlink", target: "a.txt" },
			],
			sha,
		);
		const stat = await ask({ operation: "stat", path: join(workspace, "tree"), tree: true });
		expect(stat.ok && stat.treeSha256).toBe(expected);
		const emptied = await ask({ operation: "stat", path: join(workspace, "tree/l") });
		expect(emptied.ok && emptied.sha256).toBe(symlinkHashOf("a.txt", sha));
	});

	it("removes a tree whose hash matches, counts the folder itself, and refuses past 5000 entries", async () => {
		mkdirSync(join(workspace, "t/sub"), { recursive: true });
		writeFileSync(join(workspace, "t/sub/x"), "1");
		const tree = (await ask({ operation: "stat", path: join(workspace, "t"), tree: true }))!;
		const removed = await ask({ operation: "rmtree", path: join(workspace, "t"), recursive: true, treeSha256: tree.ok ? tree.treeSha256 : "" });
		expect(removed.ok && removed.removed).toBe(3);
		expect(existsSync(join(workspace, "t"))).toBe(false);
		mkdirSync(join(workspace, "many"));
		for (let index = 0; index < 5001; index += 1) writeFileSync(join(workspace, "many", `f${index}`), "");
		expect(failureCode(await ask({ operation: "stat", path: join(workspace, "many"), tree: true }))).toBe("too_many_entries");
	});

	it("removes a tree that holds a .git directory below the named one", async () => {
		mkdirSync(join(workspace, "repo/.git"), { recursive: true });
		writeFileSync(join(workspace, "repo/.git/config"), "x");
		const tree = await ask({ operation: "stat", path: join(workspace, "repo"), tree: true });
		const removed = await ask({ operation: "rmtree", path: join(workspace, "repo"), recursive: true, treeSha256: tree.ok ? tree.treeSha256 : "" });
		expect(removed.ok).toBe(true);
	});

	it("renames a directory without replacing and refuses a move into itself", async () => {
		mkdirSync(join(workspace, "a/inner"), { recursive: true });
		writeFileSync(join(workspace, "a/inner/f"), "x");
		const tree = await ask({ operation: "stat", path: join(workspace, "a"), tree: true });
		const treeSha256 = tree.ok ? (tree.treeSha256 ?? "") : "";
		expect(failureCode(await ask({ operation: "rename", path: join(workspace, "a"), to: join(workspace, "a/inner/a2"), treeSha256 }))).toBe("invalid_move");
		mkdirSync(join(workspace, "taken"));
		expect(failureCode(await ask({ operation: "rename", path: join(workspace, "a"), to: join(workspace, "taken"), treeSha256 }))).toBe("already_exists");
		expect(readdirSync(workspace).sort()).toEqual(["a", "taken"]);
		const moved = await ask({ operation: "rename", path: join(workspace, "a"), to: join(workspace, "b"), treeSha256 });
		expect(moved.ok).toBe(true);
		expect(readFileSync(join(workspace, "b/inner/f"), "utf8")).toBe("x");
	});

	it("renames a link as a link and a file with the same inode", async () => {
		writeFileSync(join(workspace, "f"), "x");
		symlinkSync("f", join(workspace, "l"));
		const linkMoved = await ask({ operation: "rename", path: join(workspace, "l"), to: join(workspace, "l2"), sha256: symlinkHashOf("f", sha) });
		expect(linkMoved.ok).toBe(true);
		const fileMoved = await ask({ operation: "rename", path: join(workspace, "f"), to: join(workspace, "g"), sha256: sha("x") });
		expect(fileMoved.ok).toBe(true);
		expect(readFileSync(join(workspace, "g"), "utf8")).toBe("x");
		expect(readlinkSync(join(workspace, "l2"))).toBe("f");
	});

	it("makes a folder, treats an existing folder as created false, a file as already_exists and a missing parent as parent_missing", async () => {
		const first = await ask({ operation: "mkdir", path: join(workspace, "d") });
		expect(first.ok && first.created).toBe(true);
		const again = await ask({ operation: "mkdir", path: join(workspace, "d") });
		expect(again.ok && again.created).toBe(false);
		writeFileSync(join(workspace, "file"), "x");
		expect(failureCode(await ask({ operation: "mkdir", path: join(workspace, "file") }))).toBe("already_exists");
		expect(failureCode(await ask({ operation: "mkdir", path: join(workspace, "no/such/parent") }))).toBe("parent_missing");
	});

	it("deletes an empty folder, refuses a folder with children, and refuses the workspace itself", async () => {
		mkdirSync(join(workspace, "empty"));
		mkdirSync(join(workspace, "full"));
		writeFileSync(join(workspace, "full/x"), "1");
		const emptyHash = sha("");
		expect((await ask({ operation: "unlink", path: join(workspace, "empty"), treeSha256: emptyHash })).ok).toBe(true);
		expect(failureCode(await ask({ operation: "unlink", path: join(workspace, "full"), treeSha256: emptyHash }))).toBe("directory_not_empty");
		expect(failureCode(await ask({ operation: "unlink", path: workspace, treeSha256: emptyHash }))).toBe("outside_workspace");
	});

	it("refuses a delete or rename whose path has a .git segment", async () => {
		mkdirSync(join(workspace, ".git"));
		writeFileSync(join(workspace, ".git/config"), "x");
		expect(failureCode(await ask({ operation: "unlink", path: join(workspace, ".git/config"), sha256: sha("x") }))).toBe("path_refused");
		expect(failureCode(await ask({ operation: "mkdir", path: join(workspace, ".git/hooks") }))).toBe("path_refused");
		writeFileSync(join(workspace, "ok.txt"), "x");
		expect(failureCode(await ask({ operation: "rename", path: join(workspace, "ok.txt"), to: join(workspace, ".git/ok.txt"), sha256: sha("x") }))).toBe("path_refused");
	});
});
