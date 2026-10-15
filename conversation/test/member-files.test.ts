import { describe, expect, it } from "vitest";
import { LIVE_FILE_ERROR_STATUS, LIVE_FILE_OWNER_ERROR_CODES, type LiveFileOutcome } from "@chatticus/host-protocol/live-files";
import { StoreOverlayAuditSink, auditExpiryOf, memberAuditRecordOf } from "../src/domain/file-audit.ts";
import { secondsLeftInWindow } from "../src/domain/file-rate-limit.ts";
import { MemberFileRefusal } from "../src/domain/member-file-refusal.ts";
import { fallbackReasonOfOwnerError, refusalOfOwnerError } from "../src/domain/member-files.ts";
import { recursiveFlagOf, removePreconditionOf, writePreconditionOf } from "../src/http/routes/file-preconditions.ts";
import type { FileAuditRecord } from "../src/store/codecs/file-audit.ts";

const HASH = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

describe("the precondition of a save", () => {
	it("reads one strong quoted SHA-256 as If-Match", () => {
		expect(writePreconditionOf(`"${HASH}"`, undefined)).toEqual({ type: "if_match", sha256: HASH });
	});

	it("reads * as If-None-Match", () => {
		expect(writePreconditionOf(undefined, "*")).toEqual({ type: "if_none_match" });
	});

	it.each([
		[undefined, undefined],
		[`"${HASH}"`, "*"],
	])("asks for exactly one of the two: %j and %j is 428", (ifMatch, ifNoneMatch) => {
		expect(() => writePreconditionOf(ifMatch, ifNoneMatch)).toThrowError(expect.objectContaining({ code: "precondition_required", status: 428 }));
	});

	it.each(["*", `W/"${HASH}"`, `"${HASH}", "${HASH}"`, HASH, `"${HASH.slice(1)}"`, `"${HASH.toUpperCase()}"`, '""'])("refuses the If-Match value %j as 400", (value) => {
		expect(() => writePreconditionOf(value, undefined)).toThrowError(expect.objectContaining({ code: "invalid_body", status: 400 }));
	});

	it.each([`"${HASH}"`, "", "**", "W/*"])("refuses the If-None-Match value %j as 400", (value) => {
		expect(() => writePreconditionOf(undefined, value)).toThrowError(expect.objectContaining({ code: "invalid_body", status: 400 }));
	});
});

describe("the precondition of a delete or a rename", () => {
	it("reads one strong quoted hash from If-Match", () => {
		expect(removePreconditionOf(`"${HASH}"`)).toBe(HASH);
	});

	it("asks for If-Match with 428", () => {
		expect(() => removePreconditionOf(undefined)).toThrowError(expect.objectContaining({ code: "precondition_required", status: 428 }));
	});

	it.each(["*", `W/"${HASH}"`, `"${HASH}", "${HASH}"`, HASH, `"${HASH.slice(1)}"`, '""'])("refuses the If-Match value %j as 400", (value) => {
		expect(() => removePreconditionOf(value)).toThrowError(expect.objectContaining({ code: "invalid_body", status: 400 }));
	});

	it.each([
		[undefined, false],
		["false", false],
		["true", true],
	])("reads recursive=%j as %j", (raw, expected) => {
		expect(recursiveFlagOf(raw)).toBe(expected);
	});

	it.each(["", "1", "yes", "TRUE"])("refuses recursive=%j as 400", (raw) => {
		expect(() => recursiveFlagOf(raw)).toThrowError(expect.objectContaining({ code: "invalid_body", status: 400 }));
	});
});

describe("what an error of the owner means to a member", () => {
	const error = (code: (typeof LIVE_FILE_OWNER_ERROR_CODES)[number], extra: { current_sha256?: string | null } = {}) =>
		({ status: "error", code, message: "from the owner", ...extra }) satisfies Extract<LiveFileOutcome, { status: "error" }>;

	it("keeps the codes that describe the file, with the hash a failed precondition found", () => {
		const refusal = refusalOfOwnerError(error("precondition_failed", { current_sha256: HASH }));
		expect(refusal).toBeInstanceOf(MemberFileRefusal);
		expect({ code: refusal.code, status: refusal.status, hash: refusal.detail.currentSha256 }).toEqual({ code: "precondition_failed", status: 409, hash: HASH });
		for (const code of ["not_found", "not_a_file", "not_a_directory", "file_too_large", "already_exists", "parent_missing", "not_text", "directory_not_empty", "invalid_move", "too_many_entries"] as const) {
			expect(refusalOfOwnerError(error(code)).code).toBe(code);
		}
	});

	it("turns every way out of the workspace into path_refused", () => {
		for (const code of ["outside_workspace", "permission_denied", "path_refused"] as const) {
			expect(refusalOfOwnerError(error(code))).toMatchObject({ code: "path_refused", status: 403 });
		}
	});

	it("tells a member what to do about a failure of the channel on a change", () => {
		expect(refusalOfOwnerError(error("owner_stopping"))).toMatchObject({ code: "computer_stopping", status: 503, detail: { retryAfterMs: 5000 } });
		expect(refusalOfOwnerError(error("owner_busy"))).toMatchObject({ code: "too_busy", status: 429 });
		expect(refusalOfOwnerError(error("expired"))).toMatchObject({ code: "owner_timeout", status: 504 });
		expect(refusalOfOwnerError(error("helper_timeout"))).toMatchObject({ code: "outcome_unknown", status: 504 });
		expect(refusalOfOwnerError(error("helper_failed"))).toMatchObject({ code: "owner_error", status: 502 });
		expect(refusalOfOwnerError(error("io_error"))).toMatchObject({ code: "owner_error", status: 502 });
	});

	it("answers every owner error code with a status in the member table", () => {
		for (const code of LIVE_FILE_OWNER_ERROR_CODES) {
			const refusal = refusalOfOwnerError(error(code));
			expect(LIVE_FILE_ERROR_STATUS[refusal.code]).toBe(refusal.status);
		}
	});

	it("makes a read fall back only for a failure of the channel", () => {
		expect(fallbackReasonOfOwnerError("owner_stopping")).toBe("owner_stopping");
		expect(fallbackReasonOfOwnerError("expired")).toBe("owner_timeout");
		expect(fallbackReasonOfOwnerError("helper_timeout")).toBe("owner_timeout");
		expect(fallbackReasonOfOwnerError("helper_failed")).toBe("owner_error");
		expect(fallbackReasonOfOwnerError("io_error")).toBe("owner_error");
		expect(fallbackReasonOfOwnerError("owner_busy")).toBe("owner_error");
		for (const code of ["not_found", "not_a_file", "not_a_directory", "file_too_large", "outside_workspace", "permission_denied", "path_refused"] as const) {
			expect(fallbackReasonOfOwnerError(code)).toBeNull();
		}
	});
});

describe("the rate window", () => {
	it("counts the seconds left in the minute and never answers zero", () => {
		expect(secondsLeftInWindow(new Date("2026-01-01T00:00:00.000Z"))).toBe(60);
		expect(secondsLeftInWindow(new Date("2026-01-01T00:00:59.900Z"))).toBe(1);
		expect(secondsLeftInWindow(new Date("2026-01-01T00:00:30.000Z"))).toBe(30);
	});
});

describe("the audit record of a member action", () => {
	const at = new Date("2026-01-01T00:00:00.000Z");
	const subject = { tenantId: "anthus", computerId: "household", userId: "mia", operationId: "fop-1", at, source: "live" } as const;

	it("expires 90 days after it was written", () => {
		expect(auditExpiryOf(at).toISOString()).toBe("2026-04-01T00:00:00.000Z");
	});

	it("holds the hashes and sizes it was given and no content, and marks a secret name and a reveal", () => {
		const write = memberAuditRecordOf(subject, { operation: "write", path: "/workspace/.env", sha256Before: HASH, sha256After: HASH, bytes: 4 }, "pending");
		expect(write).toMatchObject({ operation: "write", outcome: "pending", secretName: true, revealed: false, sha256Before: HASH, sha256After: HASH, bytes: 4, source: "live" });
		expect(Object.keys(write)).not.toContain("content");
		const reveal = memberAuditRecordOf(subject, { operation: "reveal", path: "/workspace/notes.md" }, "pending");
		expect(reveal).toMatchObject({ secretName: false, revealed: true });
	});

	it("writes a refusal directly with its code", () => {
		expect(memberAuditRecordOf(subject, { operation: "create", path: "/workspace/.git/config" }, "refused", "path_refused")).toMatchObject({ outcome: "refused", errorCode: "path_refused" });
	});
});

describe("the audit sink of the edit overlay", () => {
	const written: FileAuditRecord[] = [];
	const finished: Array<{ tenantId: string; at: number; operationId: string; outcome: string }> = [];
	const store = {
		async putFileAudit(record: FileAuditRecord) {
			written.push(record);
		},
		async finalizeFileAudit(tenantId: string, at: number, operationId: string, finish: { outcome: string }) {
			finished.push({ tenantId, at, operationId, outcome: finish.outcome });
			return true;
		},
	};

	it("writes the record in the audit family with the source overlay and finishes the same record", async () => {
		const sink = new StoreOverlayAuditSink(store);
		const at = "2026-01-01T00:00:00.000Z";
		await sink.begin({ operationId: "fop-9", tenantId: "anthus", computerId: "household", userId: "mia", operation: "write", path: "/workspace/a.md", source: "overlay", outcome: "pending", sha256Before: HASH, sha256After: null, at });
		expect(written[0]).toMatchObject({ source: "overlay", operation: "write", sha256Before: HASH, expiresAt: auditExpiryOf(new Date(at)) });
		expect(written[0]).not.toHaveProperty("sha256After");
		await sink.finish("fop-9", { outcome: "ok", finishedAt: "2026-01-01T00:00:01.000Z" });
		expect(finished).toEqual([{ tenantId: "anthus", at: new Date(at).getTime(), operationId: "fop-9", outcome: "ok" }]);
		await sink.finish("fop-9", { outcome: "ok", finishedAt: "2026-01-01T00:00:02.000Z" });
		expect(finished).toHaveLength(1);
	});

	it("does not wait for a finish of a record that was refused directly", async () => {
		const sink = new StoreOverlayAuditSink(store);
		await sink.begin({ operationId: "fop-10", tenantId: "anthus", computerId: "household", userId: "mia", operation: "write", path: "/workspace/.git/x", source: "overlay", outcome: "refused", errorCode: "path_refused", at: "2026-01-01T00:00:00.000Z" });
		await sink.finish("fop-10", { outcome: "ok", finishedAt: "2026-01-01T00:00:01.000Z" });
		expect(finished.some((entry) => entry.operationId === "fop-10")).toBe(false);
	});
});
