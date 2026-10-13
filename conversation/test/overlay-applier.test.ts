import { createHash } from "node:crypto";
import { overlayEntrySchema, type OverlayEntry } from "@chatticus/host-protocol/edit-overlay";
import { describe, expect, it } from "vitest";
import type { FileHelperLauncher, FileHelperRequest, FileHelperResponse } from "../../computer/host/src/live-file-helper-launcher.ts";
import { OverlayApplyError, SealingOverlayApplier, type OverlayBlobReader } from "../../computer/host/src/overlay-applier.ts";
import { HostProtocolError } from "../../computer/host/src/protocol-client.ts";
import type { SupervisorClock } from "../../computer/host/src/supervisor-ports.ts";

const sha256Of = (text: string): string => createHash("sha256").update(text).digest("hex");

const ROOT = "/computer/workspace";
const EDITED_AT = "2026-10-12T08:00:00.000Z";

class SteppingClock implements SupervisorClock {
	current = Date.parse(EDITED_AT);
	nowMilliseconds(): number {
		return this.current;
	}
	async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
		if (milliseconds >= 30_000) {
			await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
			return;
		}
		this.current += milliseconds;
	}
}

type Script = (request: FileHelperRequest) => FileHelperResponse;

class ScriptedLauncher implements FileHelperLauncher {
	readonly requests: FileHelperRequest[] = [];
	private readonly script: Script;
	constructor(script: Script) {
		this.script = script;
	}
	async run(request: FileHelperRequest): Promise<FileHelperResponse> {
		this.requests.push(request);
		return this.script(request);
	}
}

const failure = (code: string, currentSha256?: string | null): FileHelperResponse => ({ ok: false, code, message: code, ...(currentSha256 === undefined ? {} : { currentSha256 }) });

const entryCommon = (path: string, revision: number) => ({ path, revision, edited_by: "mia", edited_at: EDITED_AT, conflict: null });

const putEntry = (path: string, content: string, base: string | null, revision = 1): OverlayEntry =>
	overlayEntrySchema.parse({
		...entryCommon(path, revision),
		op: "put",
		sha256: sha256Of(content),
		size: Buffer.byteLength(content),
		mode: "664",
		base_sha256: base,
		from: null,
		from_sha256: null,
	});

const mkdirEntry = (path: string): OverlayEntry => overlayEntrySchema.parse({ ...entryCommon(path, 1), op: "mkdir", mode: "775" });

const fileDeleteEntry = (path: string, base: string): OverlayEntry =>
	overlayEntrySchema.parse({ ...entryCommon(path, 1), op: "delete", directory: false, recursive: false, base_sha256: base, tree_sha256: null });

const directoryDeleteEntry = (path: string, recursive: boolean, tree: string | null): OverlayEntry =>
	overlayEntrySchema.parse({ ...entryCommon(path, 1), op: "delete", directory: true, recursive, base_sha256: null, tree_sha256: tree });

const fileMoveEntry = (from: string, to: string, kept: string): OverlayEntry =>
	overlayEntrySchema.parse({ ...entryCommon(to, 1), op: "move", from, directory: false, sha256: kept, tree_sha256: null, size: 1, mode: "664" });

const blobsOf = (contents: readonly string[]): OverlayBlobReader => ({
	read: async (sha256) => {
		const found = contents.find((content) => sha256Of(content) === sha256);
		return found === undefined ? null : Buffer.from(found, "utf8");
	},
});

type Harness = {
	readonly applier: SealingOverlayApplier;
	readonly launcher: ScriptedLauncher;
	readonly posts: unknown[];
	readonly logs: string[];
};

function harness(entries: OverlayEntry[], script: Script, options: { blobs?: OverlayBlobReader; seal?: () => Promise<{ entries: OverlayEntry[] }>; applied?: () => Promise<{ remaining: number }> } = {}): Harness {
	const launcher = new ScriptedLauncher(script);
	const posts: unknown[] = [];
	const logs: string[] = [];
	const applier = new SealingOverlayApplier({
		ownerId: "owner-1",
		generation: 1,
		plane: {
			sealOverlay: options.seal ?? (async () => ({ entries })),
			postOverlayApplied: async (request) => {
				posts.push(request);
				return (options.applied ?? (async () => ({ remaining: 0 })))();
			},
		},
		launcher,
		workspaceRoot: ROOT,
		blobs: options.blobs ?? blobsOf(["second draft", "x"]),
		clock: new SteppingClock(),
		log: (event) => logs.push(event),
	});
	return { applier, launcher, posts, logs };
}

describe("the overlay applier", () => {
	it("applies mkdir, directory moves, file moves, puts, file deletes and directory deletes in that order, shallowest first and deepest last", async () => {
		const entries = [
			directoryDeleteEntry("/workspace/a", true, "a".repeat(64)),
			directoryDeleteEntry("/workspace/a/b", false, null),
			fileDeleteEntry("/workspace/z.txt", sha256Of("z")),
			putEntry("/workspace/p.txt", "x", null),
			fileMoveEntry("/workspace/m.txt", "/workspace/n.txt", sha256Of("m")),
			overlayEntrySchema.parse({ ...entryCommon("/workspace/d2", 1), op: "move", from: "/workspace/d1", directory: true, sha256: null, tree_sha256: "d".repeat(64), size: 0, mode: "775" }),
			mkdirEntry("/workspace/q/r"),
			mkdirEntry("/workspace/q"),
		];
		const { applier, launcher } = harness(entries, (request) => (request.operation === "write" ? { ok: true } : request.operation === "mkdir" ? { ok: true, created: true } : { ok: true }));
		await applier.applyAfterHydrate();
		expect(launcher.requests.map((request) => `${request.operation} ${request.path.replace(ROOT, "")}`)).toEqual([
			"mkdir /q",
			"mkdir /q/r",
			"rename /d1",
			"rename /m.txt",
			"write /p.txt",
			"unlink /z.txt",
			"unlink /a/b",
			"rmtree /a",
		]);
	});

	it("passes the precondition the person saw, refuses .git and stays inside the workspace on every request", async () => {
		const { applier, launcher } = harness([putEntry("/workspace/a.txt", "second draft", sha256Of("first draft")), putEntry("/workspace/b.txt", "second draft", null)], () => ({ ok: true }));
		await applier.applyAfterHydrate();
		expect(launcher.requests[0]).toMatchObject({ operation: "write", path: `${ROOT}/a.txt`, content: "second draft", precondition: { type: "if_match", sha256: sha256Of("first draft") }, allowedRoots: [ROOT], refuseGitSegments: true });
		expect(launcher.requests[1]).toMatchObject({ precondition: { type: "if_none_match" } });
	});

	it("never applies an entry that carries a stored conflict", async () => {
		const flagged = overlayEntrySchema.parse({ ...putEntry("/workspace/a.txt", "second draft", null), conflict: { reason: "changed", disk_sha256: null, found_at: EDITED_AT } });
		const { applier, launcher } = harness([flagged], () => ({ ok: true }));
		const result = await applier.applyAfterHydrate();
		expect(launcher.requests).toEqual([]);
		expect(result).toEqual({ applied: [], conflicts: [] });
	});

	const putRows: Array<[string, string | null, FileHelperResponse, "applied" | "conflict", string?]> = [
		["a stale base hash that equals the entry is already applied", sha256Of("first draft"), failure("precondition_failed", sha256Of("second draft")), "applied"],
		["a stale base hash that equals a third version is a changed conflict", sha256Of("first draft"), failure("precondition_failed", sha256Of("third")), "conflict", "changed"],
		["a file that is gone under an if-match is a changed conflict", sha256Of("first draft"), failure("not_found"), "conflict", "changed"],
		["a directory under an if-match is a kind mismatch", sha256Of("first draft"), failure("not_a_file"), "conflict", "kind_mismatch"],
		["a missing parent is a collision", null, failure("parent_missing"), "conflict", "collision"],
		["a link that leads outside the workspace is a kind mismatch", sha256Of("first draft"), failure("outside_workspace"), "conflict", "kind_mismatch"],
		["a .git path is a kind mismatch", null, failure("path_refused"), "conflict", "kind_mismatch"],
	];
	for (const [name, base, response, kind, reason] of putRows) {
		it(`reports ${name}`, async () => {
			const { applier } = harness([putEntry("/workspace/a.txt", "second draft", base)], () => response);
			const result = await applier.applyAfterHydrate();
			if (kind === "applied") expect(result.applied).toEqual([{ path: "/workspace/a.txt", revision: 1 }]);
			else expect(result.conflicts).toMatchObject([{ path: "/workspace/a.txt", reason }]);
		});
	}

	it("tells an existing identical file from an existing different file and from a directory when creating", async () => {
		const stateOf = (kind: "file" | "directory", content: string): Script => (request) => {
			if (request.operation === "write") return failure("already_exists");
			if (request.operation === "stat") return { ok: true, kind };
			return { ok: true, sha256: sha256Of(content) };
		};
		expect((await harness([putEntry("/workspace/a.txt", "second draft", null)], stateOf("file", "second draft")).applier.applyAfterHydrate()).applied).toHaveLength(1);
		expect((await harness([putEntry("/workspace/a.txt", "second draft", null)], stateOf("file", "other")).applier.applyAfterHydrate()).conflicts).toMatchObject([{ reason: "changed", diskSha256: sha256Of("other") }]);
		expect((await harness([putEntry("/workspace/a.txt", "second draft", null)], stateOf("directory", "")).applier.applyAfterHydrate()).conflicts).toMatchObject([{ reason: "kind_mismatch" }]);
	});

	it("reads a rename whose source is gone and whose target holds the kept hash as already applied, and any other target as changed", async () => {
		const kept = sha256Of("m");
		const rename = (targetHash: string): Script => (request) => {
			if (request.operation === "rename") return failure("not_found");
			if (request.operation === "stat") return { ok: true, kind: "file" };
			return { ok: true, sha256: targetHash };
		};
		expect((await harness([fileMoveEntry("/workspace/m.txt", "/workspace/n.txt", kept)], rename(kept)).applier.applyAfterHydrate()).applied).toHaveLength(1);
		expect((await harness([fileMoveEntry("/workspace/m.txt", "/workspace/n.txt", kept)], rename(sha256Of("other"))).applier.applyAfterHydrate()).conflicts).toMatchObject([{ reason: "changed" }]);
	});

	it("reports a rename onto an existing path as a collision with what the path holds", async () => {
		const script: Script = (request) => {
			if (request.operation === "rename") return failure("already_exists");
			if (request.operation === "stat") return { ok: true, kind: "file" };
			return { ok: true, sha256: sha256Of("other") };
		};
		const result = await harness([fileMoveEntry("/workspace/a.txt", "/workspace/b.txt", sha256Of("a"))], script).applier.applyAfterHydrate();
		expect(result.conflicts).toMatchObject([{ path: "/workspace/b.txt", reason: "collision", diskSha256: sha256Of("other") }]);
	});

	it("maps the results of deleting a file and a folder", async () => {
		const run = async (entry: OverlayEntry, response: FileHelperResponse) => (await harness([entry], () => response).applier.applyAfterHydrate());
		expect((await run(fileDeleteEntry("/workspace/a", sha256Of("a")), failure("not_found"))).applied).toHaveLength(1);
		expect((await run(fileDeleteEntry("/workspace/a", sha256Of("a")), failure("precondition_failed", sha256Of("b")))).conflicts).toMatchObject([{ reason: "changed", diskSha256: sha256Of("b") }]);
		expect((await run(directoryDeleteEntry("/workspace/d", false, null), failure("directory_not_empty"))).conflicts).toMatchObject([{ reason: "not_empty" }]);
		expect((await run(directoryDeleteEntry("/workspace/d", true, "a".repeat(64)), failure("precondition_failed", "b".repeat(64)))).conflicts).toMatchObject([{ reason: "changed", diskSha256: "b".repeat(64) }]);
		expect((await run(directoryDeleteEntry("/workspace/d", true, "a".repeat(64)), failure("not_found"))).applied).toHaveLength(1);
	});

	it("fails the hydrate on a blob that is missing, unreadable or does not hash to its entry, and writes nothing", async () => {
		const entry = putEntry("/workspace/a.txt", "second draft", null);
		const cases: Array<[OverlayBlobReader, string]> = [
			[{ read: async () => null }, "blob_unreadable"],
			[{ read: async () => { throw new Error("denied"); } }, "blob_unreadable"],
			[{ read: async () => Buffer.from("tampered", "utf8") }, "blob_tampered"],
		];
		for (const [blobs, reason] of cases) {
			const { applier, launcher, logs } = harness([entry], () => ({ ok: true }), { blobs });
			await expect(applier.applyAfterHydrate()).rejects.toMatchObject({ name: "OverlayApplyError", reason });
			expect(launcher.requests).toEqual([]);
			expect(logs).toContain("overlay_apply_failed");
		}
	});

	it("fails the hydrate on a helper failure that is not a precondition", async () => {
		for (const code of ["io_error", "permission_denied", "helper_timeout", "helper_failed"]) {
			const { applier } = harness([putEntry("/workspace/a.txt", "second draft", null)], () => failure(code));
			await expect(applier.applyAfterHydrate()).rejects.toBeInstanceOf(OverlayApplyError);
		}
	});

	it("retries a seal that fails with a server error within the budget and gives up after it", async () => {
		let attempts = 0;
		const retried = harness([], () => ({ ok: true }), {
			seal: async () => {
				attempts += 1;
				if (attempts < 3) throw new HostProtocolError("busy", 503);
				return { entries: [] };
			},
		});
		await retried.applier.applyAfterHydrate();
		expect(attempts).toBe(3);
		const never = harness([], () => ({ ok: true }), { seal: async () => { throw new HostProtocolError("busy", 503); } });
		await expect(never.applier.applyAfterHydrate()).rejects.toMatchObject({ reason: "seal_failed" });
		const refused = harness([], () => ({ ok: true }), { seal: async () => { throw new HostProtocolError("bad", 422, "invalid_request"); } });
		await expect(refused.applier.applyAfterHydrate()).rejects.toMatchObject({ reason: "seal_failed" });
	});

	it("lets a refusal that ends the ownership through as it is", async () => {
		const { applier } = harness([], () => ({ ok: true }), { seal: async () => { throw new HostProtocolError("old", 403, "stale_generation"); } });
		await expect(applier.applyAfterHydrate()).rejects.toBeInstanceOf(HostProtocolError);
	});

	it("reports conflicts and retries a report that fails, without failing the hydrate", async () => {
		let calls = 0;
		const { applier, posts } = harness([putEntry("/workspace/a.txt", "second draft", sha256Of("v1"))], () => failure("precondition_failed", sha256Of("third")), {
			applied: async () => {
				calls += 1;
				if (calls < 3) throw new Error("network");
				return { remaining: 1 };
			},
		});
		const result = await applier.applyAfterHydrate();
		expect(result.conflicts).toHaveLength(1);
		expect(posts).toHaveLength(3);
		expect(posts[2]).toMatchObject({ cleared: [], conflicts: [{ path: "/workspace/a.txt", revision: 1, disk_sha256: sha256Of("third") }] });
	});

	it("asks to clear exactly the entries it is given and says whether the Front Door acknowledged", async () => {
		const acknowledged = harness([], () => ({ ok: true }));
		expect(await acknowledged.applier.clearApplied([{ path: "/workspace/a.txt", revision: 2 }])).toBe(true);
		expect(acknowledged.posts).toEqual([{ owner_id: "owner-1", generation: 1, cleared: [{ path: "/workspace/a.txt", revision: 2 }], conflicts: [] }]);
		const lost = harness([], () => ({ ok: true }), { applied: async () => { throw new Error("network"); } });
		expect(await lost.applier.clearApplied([{ path: "/workspace/a.txt", revision: 2 }])).toBe(false);
		const superseded = harness([], () => ({ ok: true }), { applied: async () => { throw new HostProtocolError("old", 403, "not_current_owner"); } });
		await expect(superseded.applier.clearApplied([{ path: "/workspace/a.txt", revision: 2 }])).rejects.toBeInstanceOf(HostProtocolError);
		expect(await acknowledged.applier.clearApplied([])).toBe(true);
		expect(acknowledged.posts).toHaveLength(1);
	});
});
