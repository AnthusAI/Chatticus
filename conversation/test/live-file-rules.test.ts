import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	LIVE_FILE_PATH_MAX_CHARACTERS,
	LIVE_WORKSPACE_ROOT,
	livePathHasGitSegment,
	livePathProblem,
	looksBinary,
	looksLikeSecretFile,
	normalizeLivePath,
	symlinkHashInputOf,
	symlinkHashOf,
	treeHashInputOf,
	treeHashOf,
	trimToCharacterBoundary,
	utf8ByteLength,
} from "@chatticus/host-protocol/live-file-rules";

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("live path rules", () => {
	it("exposes the workspace root and the path limit", () => {
		expect(LIVE_WORKSPACE_ROOT).toBe("/workspace");
		expect(LIVE_FILE_PATH_MAX_CHARACTERS).toBe(1024);
	});

	it.each(["/workspace", "/workspace/", "/workspace/src/a.c", "/workspace//src///a.c", "/workspace/./a", "/workspace/a b/ü.txt"])(
		"accepts %j",
		(raw) => {
			expect(livePathProblem(raw)).toBeNull();
		},
	);

	it.each([
		["", "empty"],
		["workspace/a", "not_absolute"],
		["a/../b", "not_absolute"],
		["/workspace/../etc", "dot_dot"],
		["/workspace/a/../b", "dot_dot"],
		["/workspace/a\u0000b", "nul"],
		[`/workspace/${"a".repeat(1100)}`, "too_long"],
		["/etc/passwd", "outside_workspace"],
		["/workspacex/a", "outside_workspace"],
		["/", "outside_workspace"],
		["/browser-profiles/untrusted", "outside_workspace"],
	])("refuses %j as %s", (raw, problem) => {
		expect(livePathProblem(raw)).toBe(problem);
	});

	it("accepts a path of exactly 1024 characters and refuses 1025", () => {
		const exact = `/workspace/${"a".repeat(1024 - "/workspace/".length)}`;
		expect(exact.length).toBe(1024);
		expect(livePathProblem(exact)).toBeNull();
		expect(livePathProblem(`${exact}a`)).toBe("too_long");
	});

	it("normalises to one form without a trailing slash, repeated slash or dot segment", () => {
		expect(normalizeLivePath("/workspace/")).toBe("/workspace");
		expect(normalizeLivePath("/workspace//src///a.c")).toBe("/workspace/src/a.c");
		expect(normalizeLivePath("/workspace/./src/./a.c/")).toBe("/workspace/src/a.c");
	});

	it("finds a .git segment of a file or a directory and only a whole segment", () => {
		expect(livePathHasGitSegment("/workspace/.git")).toBe(true);
		expect(livePathHasGitSegment("/workspace/project/.git/config")).toBe(true);
		expect(livePathHasGitSegment("/workspace/.gitignore")).toBe(false);
		expect(livePathHasGitSegment("/workspace/a.git/b")).toBe(false);
		expect(livePathHasGitSegment("/workspace")).toBe(false);
	});
});

describe("secret file names", () => {
	it.each([
		"workspace/.env",
		"workspace/app/.env.local",
		"workspace/key.pem",
		"workspace/server.key",
		"workspace/id_rsa",
		"workspace/id_rsa.pub",
		"workspace/id_ed25519",
		"workspace/credentials",
		"workspace/.netrc",
		"workspace/.npmrc",
		"workspace/.git-credentials",
		"/workspace/home/.git-credentials",
		"workspace/a.p12",
		"workspace/a.pfx",
		"workspace/home/.ssh/config",
		"workspace/home/.aws/anything",
		"/workspace/.ENV",
		"/workspace/Home/.SSH/config",
	])("treats %s as secret-looking", (path) => {
		expect(looksLikeSecretFile(path)).toBe(true);
	});

	it.each(["workspace/environment.ts", "workspace/README.md", "workspace/keys.md", "workspace/ssh/config", "workspace/git-credentials.md"])(
		"lists %s as ordinary",
		(path) => {
			expect(looksLikeSecretFile(path)).toBe(false);
		},
	);
});

describe("binary and text boundaries", () => {
	it("calls a NUL byte or invalid UTF-8 binary and accepts multi-byte text cut at the sniff limit", () => {
		expect(looksBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true);
		expect(looksBinary(Buffer.from([0xff, 0xfe, 0x41]))).toBe(true);
		expect(looksBinary(Buffer.from("plain text"))).toBe(false);
		expect(looksBinary(Buffer.from("é".repeat(5000)))).toBe(false);
		expect(looksBinary(new Uint8Array([0x61, 0x00]))).toBe(true);
	});

	it("drops an incomplete UTF-8 sequence from the end and keeps a complete one", () => {
		const euro = Buffer.from("€");
		expect(euro.length).toBe(3);
		expect(trimToCharacterBoundary(euro.subarray(0, 2)).length).toBe(0);
		expect(trimToCharacterBoundary(Buffer.concat([Buffer.from("ab"), euro.subarray(0, 1)])).toString("utf8")).toBe("ab");
		expect(trimToCharacterBoundary(Buffer.concat([Buffer.from("ab"), euro])).toString("utf8")).toBe("ab€");
		expect(trimToCharacterBoundary(Buffer.from("plain")).toString("utf8")).toBe("plain");
		expect(trimToCharacterBoundary(Buffer.alloc(0)).length).toBe(0);
	});

	it("counts the bytes of the UTF-8 encoding", () => {
		expect(utf8ByteLength("")).toBe(0);
		expect(utf8ByteLength("abc")).toBe(3);
		expect(utf8ByteLength("é")).toBe(2);
		expect(utf8ByteLength("€")).toBe(3);
		expect(utf8ByteLength("\u{1F600}")).toBe(4);
	});
});

describe("symlink and tree hashes", () => {
	it("hashes a symlink as the word symlink, a NUL byte and the target", () => {
		expect(Buffer.from(symlinkHashInputOf("../a")).toString("latin1")).toBe("symlink\u0000../a");
		expect(symlinkHashOf("../a", sha256Hex)).toBe(createHash("sha256").update("symlink\u0000../a").digest("hex"));
		expect(symlinkHashOf("../a", sha256Hex)).not.toBe(symlinkHashOf("../b", sha256Hex));
	});

	it("hashes an empty directory as the hash of nothing", () => {
		expect(treeHashInputOf([]).length).toBe(0);
		expect(treeHashOf([], sha256Hex)).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});

	it("writes one line per descendant: kind, relative path and value, separated by NUL and ended by LF", () => {
		const text = Buffer.from(
			treeHashInputOf([
				{ relativePath: "link", kind: "symlink", target: "a.txt" },
				{ relativePath: "sub", kind: "dir" },
				{ relativePath: "a.txt", kind: "file", size: 12 },
			]),
		).toString("utf8");
		expect(text).toBe("file\u0000a.txt\u000012\nsymlink\u0000link\u0000a.txt\ndir\u0000sub\u00000\n");
	});

	it("sorts by the bytes of the relative path, not by code units", () => {
		const text = Buffer.from(
			treeHashInputOf([
				{ relativePath: "\u{1F600}", kind: "file", size: 1 },
				{ relativePath: "Ａ", kind: "file", size: 2 },
				{ relativePath: "B", kind: "file", size: 3 },
				{ relativePath: "a/b", kind: "file", size: 4 },
				{ relativePath: "a", kind: "dir" },
			]),
		).toString("utf8");
		expect(text.split("\n").filter((line) => line !== "").map((line) => line.split("\u0000")[1])).toEqual(["B", "a", "a/b", "Ａ", "\u{1F600}"]);
	});

	it("does not depend on the order the descendants are given in", () => {
		const forward = [
			{ relativePath: "a", kind: "file" as const, size: 1 },
			{ relativePath: "b", kind: "dir" as const },
		];
		expect(treeHashOf(forward, sha256Hex)).toBe(treeHashOf([...forward].reverse(), sha256Hex));
	});

	it("changes when a size, a link target or a kind changes", () => {
		const base = treeHashOf([{ relativePath: "a", kind: "file", size: 1 }], sha256Hex);
		expect(treeHashOf([{ relativePath: "a", kind: "file", size: 2 }], sha256Hex)).not.toBe(base);
		expect(treeHashOf([{ relativePath: "a", kind: "dir" }], sha256Hex)).not.toBe(base);
		expect(treeHashOf([{ relativePath: "a", kind: "symlink", target: "1" }], sha256Hex)).not.toBe(base);
	});
});
