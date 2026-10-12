import { describe, expect, it } from "vitest";
import {
	LIVE_FILE_CONTENT_MAX_BYTES,
	LIVE_FILE_MKDIR_MODE,
	LIVE_FILE_OWNER_ERROR_CODES,
	LIVE_FILE_TREE_MAX_ENTRIES,
	liveFileDiscardBodySchema,
	liveFileEntrySchema,
	liveFileMkdirBodySchema,
	liveFileMoveBodySchema,
	liveFileOutcomeSchema,
	liveFileOwnerErrorCodeSchema,
	liveFileRemovePreconditionSchema,
	liveFileTextSchema,
	liveFileWatchBodySchema,
	liveFileWriteBodySchema,
	livePathSchema,
	ownerFileRequestSchema,
	ownerFileResultRequestSchema,
} from "@chatticus/host-protocol/live-files";

const hash = "a".repeat(64);
const otherHash = "b".repeat(64);
const now = "2026-10-12T11:00:00.000Z";

const requestBase = { operation_id: "op-1", path: "/workspace/a.txt", expires_in_ms: 8000 };

const readResult = {
	kind: "read",
	resolved_path: "/workspace/a.txt",
	size: 10,
	sha256: hash,
	mode: "644",
	modified_at: now,
	encoding: "utf8",
	binary: false,
	offset: 0,
	length: 10,
	content: "0123456789",
	truncated: false,
	masked: false,
} as const;

describe("workspace paths in the schemas", () => {
	it.each(["/workspace", "/workspace/a/b.txt", "/workspace//a"])("accepts %j", (path) => {
		expect(livePathSchema.safeParse(path).success).toBe(true);
	});

	it.each(["/workspace/../etc", "/workspace/a/../../b", "/workspace/a\u0000b", "workspace/a", "relative/path", "", "/etc/passwd", "/workspacex", `/workspace/${"a".repeat(1100)}`])(
		"refuses %j",
		(path) => {
			expect(livePathSchema.safeParse(path).success).toBe(false);
		},
	);

	it("names the problem in the issue message", () => {
		const parsed = livePathSchema.safeParse("/workspace/../x");
		expect(parsed.success).toBe(false);
		expect(JSON.stringify(parsed.error?.issues)).toContain("dot_dot");
	});
});

describe("file content limits", () => {
	it("accepts a write of 262144 bytes of multi-byte text and refuses one byte more", () => {
		const exact = "€".repeat(87381) + "a";
		expect(Buffer.byteLength(exact, "utf8")).toBe(LIVE_FILE_CONTENT_MAX_BYTES);
		expect(liveFileWriteBodySchema.safeParse({ content: exact }).success).toBe(true);
		expect(liveFileWriteBodySchema.safeParse({ content: `${exact}a` }).success).toBe(false);
		expect(liveFileTextSchema.safeParse("a".repeat(LIVE_FILE_CONTENT_MAX_BYTES)).success).toBe(true);
		expect(liveFileTextSchema.safeParse("a".repeat(LIVE_FILE_CONTENT_MAX_BYTES + 1)).success).toBe(false);
	});

	it("counts bytes, not characters", () => {
		expect(liveFileTextSchema.safeParse("€".repeat(87382)).success).toBe(false);
	});

	it("refuses text with a NUL", () => {
		expect(liveFileWriteBodySchema.safeParse({ content: "a\u0000b" }).success).toBe(false);
	});

	it("refuses an unknown field in a write body", () => {
		expect(liveFileWriteBodySchema.safeParse({ content: "a", mode: "777" }).success).toBe(false);
	});

	it("keeps the largest read result as a table item under 380000 bytes", () => {
		const base64 = Buffer.alloc(LIVE_FILE_CONTENT_MAX_BYTES, 0xff).toString("base64");
		const request = {
			owner_id: "owner-1",
			generation: 1,
			operation_id: "op-1",
			outcome: {
				status: "ok",
				result: { ...readResult, size: 8388608, encoding: "base64", binary: true, length: LIVE_FILE_CONTENT_MAX_BYTES, content: base64, truncated: true },
			},
		};
		const parsed = ownerFileResultRequestSchema.parse(request);
		expect(Buffer.byteLength(JSON.stringify(parsed), "utf8")).toBeLessThan(380000);
	});
});

describe("owner file requests", () => {
	it("parses each of the seven kinds", () => {
		const requests = [
			{ ...requestBase, kind: "list", max_entries: 2000 },
			{ ...requestBase, kind: "stat" },
			{ ...requestBase, kind: "stat", tree: true },
			{ ...requestBase, kind: "read", offset: 0, length: 262144, mask: true },
			{ ...requestBase, kind: "write", content: "hello", precondition: { type: "if_none_match" } },
			{ ...requestBase, kind: "write", content: "hello", precondition: { type: "if_match", sha256: hash } },
			{ ...requestBase, kind: "delete", recursive: false, precondition: { type: "if_match", sha256: hash } },
			{ ...requestBase, kind: "delete", recursive: true, precondition: { type: "if_match_tree", tree_sha256: hash } },
			{ ...requestBase, kind: "move", to: "/workspace/b.txt", precondition: { type: "if_match", sha256: hash } },
			{ ...requestBase, kind: "mkdir" },
		];
		for (const request of requests) expect(ownerFileRequestSchema.safeParse(request).success).toBe(true);
	});

	it("defaults the tree flag of a stat to false", () => {
		const parsed = ownerFileRequestSchema.parse({ ...requestBase, kind: "stat" });
		expect(parsed.kind === "stat" && parsed.tree).toBe(false);
	});

	it("refuses a kind it does not know, a missing field and a bad bound", () => {
		expect(ownerFileRequestSchema.safeParse({ ...requestBase, kind: "chmod" }).success).toBe(false);
		expect(ownerFileRequestSchema.safeParse({ ...requestBase, kind: "list" }).success).toBe(false);
		expect(ownerFileRequestSchema.safeParse({ ...requestBase, kind: "list", max_entries: 2001 }).success).toBe(false);
		expect(ownerFileRequestSchema.safeParse({ ...requestBase, kind: "read", offset: 0, length: 262145, mask: false }).success).toBe(false);
		expect(ownerFileRequestSchema.safeParse({ ...requestBase, expires_in_ms: 8001, kind: "stat" }).success).toBe(false);
		expect(ownerFileRequestSchema.safeParse({ ...requestBase, kind: "move", precondition: { type: "if_match", sha256: hash } }).success).toBe(false);
	});

	it("refuses paths outside the workspace in the path and in the move target", () => {
		expect(ownerFileRequestSchema.safeParse({ ...requestBase, path: "/workspace/../x", kind: "stat" }).success).toBe(false);
		expect(ownerFileRequestSchema.safeParse({ ...requestBase, path: "relative", kind: "stat" }).success).toBe(false);
		expect(ownerFileRequestSchema.safeParse({ ...requestBase, kind: "move", to: "/etc/passwd", precondition: { type: "if_match", sha256: hash } }).success).toBe(false);
	});

	it("refuses a write with a bad precondition and a delete with a write precondition", () => {
		expect(ownerFileRequestSchema.safeParse({ ...requestBase, kind: "write", content: "x", precondition: { type: "if_match", sha256: "short" } }).success).toBe(false);
		expect(ownerFileRequestSchema.safeParse({ ...requestBase, kind: "delete", recursive: false, precondition: { type: "if_none_match" } }).success).toBe(false);
		expect(liveFileRemovePreconditionSchema.safeParse({ type: "if_match_tree", tree_sha256: hash }).success).toBe(true);
	});

	it("ignores a field a newer server adds, so an older owner keeps reading", () => {
		const parsed = ownerFileRequestSchema.parse({ ...requestBase, kind: "stat", future_field: true });
		expect(Object.keys(parsed)).not.toContain("future_field");
	});
});

describe("owner file outcomes", () => {
	it("parses one result of each kind", () => {
		const results = [
			{ kind: "list", resolved_path: "/workspace", entries: [], truncated: false },
			{
				kind: "stat",
				entry: { name: "a", path: "/workspace/a", kind: "directory", size: null, mode: "755", sha256: null, link_target: null, modified_at: now, overlay: "none", tree_sha256: hash },
			},
			readResult,
			{ kind: "write", resolved_path: "/workspace/a.txt", created: false, size: 1, sha256_before: hash, sha256_after: otherHash, modified_at: now },
			{ kind: "write", resolved_path: "/workspace/a.txt", created: false, size: 1, sha256_before: hash, sha256_after: otherHash, modified_at: now, kept_as: "/workspace/a.txt.chatticus-replaced-0a1b2c3d" },
			{ kind: "delete", resolved_path: "/workspace/d", directory: true, removed: 5000, sha256_before: null, tree_sha256_before: hash },
			{ kind: "move", from: "/workspace/a", to: "/workspace/b", directory: false, sha256: hash, tree_sha256: null },
			{ kind: "mkdir", resolved_path: "/workspace/new", created: true },
		];
		for (const result of results) expect(liveFileOutcomeSchema.safeParse({ status: "ok", result }).success).toBe(true);
	});

	it("refuses a delete that removed more than the tree limit", () => {
		const result = { kind: "delete", resolved_path: "/workspace/d", directory: true, removed: LIVE_FILE_TREE_MAX_ENTRIES + 1, sha256_before: null, tree_sha256_before: hash };
		expect(liveFileOutcomeSchema.safeParse({ status: "ok", result }).success).toBe(false);
	});

	it("refuses a masked read result that carries content or a length", () => {
		const masked = { ...readResult, masked: true, content: "", length: 0 };
		expect(liveFileOutcomeSchema.safeParse({ status: "ok", result: masked }).success).toBe(true);
		expect(liveFileOutcomeSchema.safeParse({ status: "ok", result: { ...masked, content: "secret" } }).success).toBe(false);
		expect(liveFileOutcomeSchema.safeParse({ status: "ok", result: { ...masked, length: 6 } }).success).toBe(false);
		expect(liveFileOutcomeSchema.safeParse({ status: "ok", result: { ...readResult, masked: true } }).success).toBe(false);
	});

	it("refuses an unknown field in a result and in an error", () => {
		expect(liveFileOutcomeSchema.safeParse({ status: "ok", result: { ...readResult, extra: 1 } }).success).toBe(false);
		expect(liveFileOutcomeSchema.safeParse({ status: "error", code: "not_found", message: "no", extra: 1 }).success).toBe(false);
	});

	it("parses every owner error code and refuses another", () => {
		for (const code of LIVE_FILE_OWNER_ERROR_CODES) {
			expect(liveFileOutcomeSchema.safeParse({ status: "error", code, message: "m" }).success).toBe(true);
		}
		expect(LIVE_FILE_OWNER_ERROR_CODES).toEqual(expect.arrayContaining(["directory_not_empty", "invalid_move", "too_many_entries"]));
		expect(liveFileOwnerErrorCodeSchema.safeParse("teapot").success).toBe(false);
		expect(liveFileOutcomeSchema.safeParse({ status: "error", code: "precondition_failed", message: "m", current_sha256: hash }).success).toBe(true);
	});

	it("refuses an error message longer than 500 characters", () => {
		expect(liveFileOutcomeSchema.safeParse({ status: "error", code: "io_error", message: "m".repeat(501) }).success).toBe(false);
	});
});

describe("owner file result request", () => {
	const outcome = { status: "error", code: "not_found", message: "no such file" };

	it("parses a result and refuses an unknown field or a missing generation", () => {
		expect(ownerFileResultRequestSchema.safeParse({ owner_id: "o", generation: 1, operation_id: "op", outcome }).success).toBe(true);
		expect(ownerFileResultRequestSchema.safeParse({ owner_id: "o", generation: 1, operation_id: "op", outcome, extra: 1 }).success).toBe(false);
		expect(ownerFileResultRequestSchema.safeParse({ owner_id: "o", operation_id: "op", outcome }).success).toBe(false);
	});
});

describe("directory entries and member bodies", () => {
	const entry = { name: "a", path: "/workspace/a", kind: "file", size: 1, mode: "644", sha256: hash, link_target: null, modified_at: null, overlay: "none", tree_sha256: null };

	it("requires the tree hash field and the overlay flag, and nothing unknown", () => {
		expect(liveFileEntrySchema.safeParse(entry).success).toBe(true);
		const { tree_sha256: _tree, ...withoutTree } = entry;
		expect(liveFileEntrySchema.safeParse(withoutTree).success).toBe(false);
		expect(liveFileEntrySchema.safeParse({ ...entry, overlay: "gone" }).success).toBe(false);
		expect(liveFileEntrySchema.safeParse({ ...entry, extra: 1 }).success).toBe(false);
	});

	it("validates the discard, move, mkdir and watch bodies", () => {
		expect(liveFileDiscardBodySchema.safeParse({ path: "/workspace/a", revision: 3 }).success).toBe(true);
		expect(liveFileDiscardBodySchema.safeParse({ path: "/workspace/a", revision: 0 }).success).toBe(false);
		expect(liveFileDiscardBodySchema.safeParse({ path: "/workspace/a" }).success).toBe(false);
		expect(liveFileMoveBodySchema.safeParse({ from: "/workspace/a", to: "/workspace/b" }).success).toBe(true);
		expect(liveFileMoveBodySchema.safeParse({ from: "/workspace/a", to: "/tmp/b" }).success).toBe(false);
		expect(liveFileMkdirBodySchema.safeParse({ path: "/workspace/new" }).success).toBe(true);
		expect(liveFileMkdirBodySchema.safeParse({ path: "/workspace/new", mode: "777" }).success).toBe(false);
		expect(liveFileWatchBodySchema.safeParse({ open: true }).success).toBe(true);
		expect(liveFileWatchBodySchema.safeParse({}).success).toBe(false);
	});

	it("fixes the mkdir mode and the tree limit", () => {
		expect(LIVE_FILE_MKDIR_MODE).toBe(0o775);
		expect(LIVE_FILE_TREE_MAX_ENTRIES).toBe(5000);
	});
});
