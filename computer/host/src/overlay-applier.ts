import { createHash } from "node:crypto";
import { OVERLAY_APPLY_BUDGET_SECONDS, type OverlayEntry } from "@chatticus/host-protocol/edit-overlay";
import { LIVE_FILE_HELPER_TIMEOUT_MILLISECONDS } from "@chatticus/host-protocol/live-files";
import { treeHashOf } from "@chatticus/host-protocol/live-file-rules";
import { errorNameOf, type LogEmitter } from "../../../conversation/src/observability/log-line.ts";
import type { FileHelperLauncher, FileHelperRequest, FileHelperResponse } from "./live-file-helper-launcher.ts";
import { realPathOfLivePath } from "./live-file-operations.ts";
import { HostProtocolError, refusalEndsOwnership } from "./protocol-client.ts";
import type { SupervisorClock, SupervisorPlane } from "./supervisor-ports.ts";

const SEAL_RETRY_PAUSE_MILLISECONDS = 1000;
const CONFLICT_REPORT_ATTEMPTS = 3;
const CONFLICT_REPORT_PAUSE_MILLISECONDS = 1000;
const READ_MAXIMUM_FILE_BYTES = 8_388_608;

const EMPTY_DIRECTORY_TREE_HASH = treeHashOf([], (bytes) => createHash("sha256").update(bytes).digest("hex"));

/** Names an entry of the overlay without its content: what the Front Door needs to clear or flag it. */
export type OverlayEntryReference = { readonly path: string; readonly revision: number };

/** Why an entry was not applied. */
export type OverlayConflictReason = "changed" | "collision" | "not_empty" | "kind_mismatch";

/** An entry the disk did not accept, with what the disk held. */
export type OverlayConflictReport = OverlayEntryReference & {
	readonly diskSha256: string | null;
	readonly reason: OverlayConflictReason;
};

/** What applying the sealed overlay left on the disk. */
export type OverlayApplyResult = {
	/** Entries now on the disk, applied just now or found already applied; they wait for a publish and a clear. */
	readonly applied: readonly OverlayEntryReference[];
	/** Entries that were not applied because the disk held something else. */
	readonly conflicts: readonly OverlayConflictReport[];
};

/** Why the overlay could not be applied safely; the hydrate fails and the owner does not start. */
export type OverlayApplyFailure = "seal_failed" | "blob_unreadable" | "blob_tampered" | "helper_failed" | "budget_exceeded";

/** The overlay could not be sealed or applied. The message names no path and no content. */
export class OverlayApplyError extends Error {
	readonly reason: OverlayApplyFailure;

	constructor(reason: OverlayApplyFailure, message: string) {
		super(message);
		this.name = "OverlayApplyError";
		this.reason = reason;
	}
}

/** Reads the blobs of the overlay with the supervisor's read-only credentials. */
export interface OverlayBlobReader {
	/** The bytes of the blob named by this content hash, or null when the overlay holds none. Throws when the store cannot be read. */
	read(sha256: string): Promise<Buffer | null>;
}

/** What the applier needs to seal, apply and clear. */
export type OverlayApplierOptions = {
	readonly ownerId: string;
	readonly generation: number;
	readonly plane: Pick<SupervisorPlane, "sealOverlay" | "postOverlayApplied">;
	/** The unprivileged file helper: the only thing that opens a workspace path. */
	readonly launcher: FileHelperLauncher;
	/** The real directory that plays `/workspace`. */
	readonly workspaceRoot: string;
	readonly blobs: OverlayBlobReader;
	readonly clock: SupervisorClock;
	readonly log: LogEmitter;
};

/** Seals the edit overlay after the hydrate, applies its entries through the file helper, and asks for them to be cleared. */
export interface OverlayApplier {
	/**
	 * Seal the overlay, apply its entries through the file helper, report conflicts.
	 *
	 * @returns The entries now on the disk and the entries the disk did not accept.
	 * @throws OverlayApplyError When the overlay cannot be sealed, a blob cannot be read or does not hash to its entry, a helper fails, or the budget runs out. A refusal that ends the ownership is thrown as it is.
	 */
	applyAfterHydrate(): Promise<OverlayApplyResult>;
	/** After a recorded publish: ask the Front Door to clear exactly these entries; true when acknowledged. */
	clearApplied(entries: readonly OverlayEntryReference[]): Promise<boolean>;
}

type Verdict =
	| { readonly kind: "applied" }
	| { readonly kind: "already" }
	| { readonly kind: "conflict"; readonly reason: OverlayConflictReason; readonly diskSha256: string | null };

const APPLIED: Verdict = { kind: "applied" };
const ALREADY: Verdict = { kind: "already" };
const conflict = (reason: OverlayConflictReason, diskSha256: string | null = null): Verdict => ({ kind: "conflict", reason, diskSha256 });

const ESCAPE_CODES: ReadonlySet<string> = new Set(["outside_workspace", "path_refused"]);

type DiskState =
	| { readonly kind: "absent" }
	| { readonly kind: "file" | "symlink" | "directory" | "other"; readonly sha256: string | null };

const depthOf = (path: string): number => path.split("/").length;

const byPath = (left: { readonly path: string }, right: { readonly path: string }): number => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

type PutEntry = Extract<OverlayEntry, { op: "put" }>;
type DeleteEntry = Extract<OverlayEntry, { op: "delete" }>;
type MoveEntry = Extract<OverlayEntry, { op: "move" }>;
type MkdirEntry = Extract<OverlayEntry, { op: "mkdir" }>;

/**
 * The overlay applier of the owner supervisor. After the snapshot is extracted it seals the overlay with the Front Door,
 * applies every entry that has no stored conflict in a fixed order, and reports the entries the disk did not accept. Every
 * operation goes through the unprivileged file helper with the precondition the person saw, so a file the bot changed since is
 * a conflict and never overwritten, a link that leads outside the workspace is a conflict and never followed, and root never
 * opens a workspace path. It reads blobs with the supervisor's read-only credentials and clears nothing itself: it asks the
 * Front Door, which can check what the role cannot.
 */
export class SealingOverlayApplier implements OverlayApplier {
	private readonly options: OverlayApplierOptions;
	private deadlineMilliseconds = 0;

	constructor(options: OverlayApplierOptions) {
		this.options = options;
	}

	async applyAfterHydrate(): Promise<OverlayApplyResult> {
		const { clock } = this.options;
		const startedAt = clock.nowMilliseconds();
		this.deadlineMilliseconds = startedAt + OVERLAY_APPLY_BUDGET_SECONDS * 1000;
		const stopTimer = new AbortController();
		const work = this.sealApplyAndReport();
		const outcome = await Promise.race([
			work.then((result) => ({ kind: "done" as const, result })),
			clock.sleep(OVERLAY_APPLY_BUDGET_SECONDS * 1000, stopTimer.signal).then(() => ({ kind: "timeout" as const })),
		]).catch((error: unknown) => {
			stopTimer.abort();
			throw this.failed(error);
		});
		stopTimer.abort();
		if (outcome.kind === "timeout") throw this.failed(new OverlayApplyError("budget_exceeded", "The overlay was not applied within its budget."));
		return outcome.result;
	}

	async clearApplied(entries: readonly OverlayEntryReference[]): Promise<boolean> {
		if (entries.length === 0) return true;
		const { plane, ownerId, generation, log } = this.options;
		log("overlay_clear_requested", { entries: entries.length });
		try {
			const answer = await plane.postOverlayApplied({
				owner_id: ownerId,
				generation,
				cleared: entries.map((entry) => ({ path: entry.path, revision: entry.revision })),
				conflicts: [],
			});
			log("overlay_cleared", { remaining: answer.remaining });
			return true;
		} catch (error) {
			if (error instanceof HostProtocolError && refusalEndsOwnership(error)) throw error;
			log("overlay_clear_failed", this.failureFieldsOf(error));
			return false;
		}
	}

	private failed(error: unknown): unknown {
		if (error instanceof HostProtocolError && refusalEndsOwnership(error)) return error;
		const failure = error instanceof OverlayApplyError ? error : new OverlayApplyError("helper_failed", "The overlay could not be applied.");
		this.options.log("overlay_apply_failed", { reason: failure.reason });
		return failure;
	}

	private failureFieldsOf(error: unknown): Record<string, string | number | undefined> {
		return error instanceof HostProtocolError ? { status: error.status, code: error.code } : { error_name: errorNameOf(error) };
	}

	private async sealApplyAndReport(): Promise<OverlayApplyResult> {
		const { clock, log } = this.options;
		const startedAt = clock.nowMilliseconds();
		const entries = await this.seal();
		log("overlay_sealed", { entries: entries.length });
		const pending = entries.filter((entry) => entry.conflict === null);
		const verdicts = new Map<string, Verdict>();
		await this.applyInOrder(pending, verdicts);
		const applied: OverlayEntryReference[] = [];
		const conflicts: OverlayConflictReport[] = [];
		let freshlyApplied = 0;
		let alreadyApplied = 0;
		for (const entry of pending) {
			const verdict = verdicts.get(entry.path);
			if (verdict === undefined) continue;
			if (verdict.kind === "conflict") {
				conflicts.push({ path: entry.path, revision: entry.revision, diskSha256: verdict.diskSha256, reason: verdict.reason });
			} else {
				applied.push({ path: entry.path, revision: entry.revision });
				if (verdict.kind === "applied") freshlyApplied += 1;
				else alreadyApplied += 1;
			}
		}
		log("overlay_applied", { applied: freshlyApplied, already: alreadyApplied, conflicts: conflicts.length, duration_ms: clock.nowMilliseconds() - startedAt });
		await this.reportConflicts(conflicts);
		return { applied, conflicts };
	}

	private async seal(): Promise<readonly OverlayEntry[]> {
		const { plane, ownerId, generation, clock } = this.options;
		for (;;) {
			try {
				return (await plane.sealOverlay({ owner_id: ownerId, generation })).entries;
			} catch (error) {
				if (error instanceof HostProtocolError) {
					if (refusalEndsOwnership(error)) throw error;
					if (error.status < 500) throw new OverlayApplyError("seal_failed", "The Front Door refused to seal the overlay.");
				}
				if (clock.nowMilliseconds() + SEAL_RETRY_PAUSE_MILLISECONDS >= this.deadlineMilliseconds) throw new OverlayApplyError("seal_failed", "The overlay could not be sealed in time.");
				await clock.sleep(SEAL_RETRY_PAUSE_MILLISECONDS);
			}
		}
	}

	private async reportConflicts(conflicts: readonly OverlayConflictReport[]): Promise<void> {
		if (conflicts.length === 0) return;
		const { plane, ownerId, generation, clock, log } = this.options;
		for (let attempt = 1; attempt <= CONFLICT_REPORT_ATTEMPTS; attempt += 1) {
			try {
				await plane.postOverlayApplied({
					owner_id: ownerId,
					generation,
					cleared: [],
					conflicts: conflicts.map((report) => ({ path: report.path, revision: report.revision, reason: report.reason, disk_sha256: report.diskSha256 })),
				});
				return;
			} catch (error) {
				if (error instanceof HostProtocolError && refusalEndsOwnership(error)) throw error;
				log("overlay_conflict_report_failed", { attempt, ...this.failureFieldsOf(error) });
				if (attempt < CONFLICT_REPORT_ATTEMPTS) await clock.sleep(CONFLICT_REPORT_PAUSE_MILLISECONDS);
			}
		}
	}

	private async applyInOrder(pending: readonly OverlayEntry[], verdicts: Map<string, Verdict>): Promise<void> {
		const mkdirs = pending.filter((entry): entry is MkdirEntry => entry.op === "mkdir").sort((left, right) => depthOf(left.path) - depthOf(right.path) || byPath(left, right));
		const moves = pending.filter((entry): entry is MoveEntry => entry.op === "move");
		const directoryMoves = moves.filter((entry) => entry.directory).sort((left, right) => depthOf(left.from) - depthOf(right.from) || (left.from < right.from ? -1 : 1));
		const fileMoves = moves.filter((entry) => !entry.directory).sort(byPath);
		const puts = pending.filter((entry): entry is PutEntry => entry.op === "put").sort(byPath);
		const deletes = pending.filter((entry): entry is DeleteEntry => entry.op === "delete");
		const fileDeletes = deletes.filter((entry) => !entry.directory);
		const directoryDeletes = deletes.filter((entry) => entry.directory).sort((left, right) => depthOf(right.path) - depthOf(left.path) || byPath(left, right));

		for (const entry of mkdirs) verdicts.set(entry.path, await this.applyMkdir(entry));
		for (const entry of directoryMoves) verdicts.set(entry.path, await this.applyMove(entry));
		for (const entry of fileMoves) verdicts.set(entry.path, await this.applyMove(entry));
		for (const entry of puts) verdicts.set(entry.path, await this.applyPut(entry));

		type FileDeletion = { readonly sortPath: string; readonly run: () => Promise<void> };
		const deletions: FileDeletion[] = fileDeletes.map((entry) => ({ sortPath: entry.path, run: async () => void verdicts.set(entry.path, await this.applyFileDelete(entry)) }));
		for (const entry of puts) {
			const verdict = verdicts.get(entry.path);
			if (entry.from === null || entry.from_sha256 === null || verdict === undefined || verdict.kind === "conflict") continue;
			deletions.push({
				sortPath: entry.from,
				run: async () => {
					const removal = await this.removeFile(entry.from!, entry.from_sha256);
					if (removal.kind === "conflict") verdicts.set(entry.path, removal);
				},
			});
		}
		for (const deletion of deletions.sort((left, right) => (left.sortPath < right.sortPath ? -1 : 1))) await deletion.run();
		for (const entry of directoryDeletes) verdicts.set(entry.path, await this.applyDirectoryDelete(entry));
	}

	private async ask(request: Omit<FileHelperRequest, "allowedRoots" | "refuseGitSegments">): Promise<FileHelperResponse> {
		if (this.options.clock.nowMilliseconds() >= this.deadlineMilliseconds) throw new OverlayApplyError("budget_exceeded", "The overlay was not applied within its budget.");
		return this.options.launcher.run({ ...request, allowedRoots: [this.options.workspaceRoot], refuseGitSegments: true }, LIVE_FILE_HELPER_TIMEOUT_MILLISECONDS);
	}

	private realPathOf(livePath: string): string {
		return realPathOfLivePath(this.options.workspaceRoot, livePath);
	}

	private unexpected(response: Extract<FileHelperResponse, { ok: false }>): never {
		throw new OverlayApplyError("helper_failed", `The file helper failed with ${response.code}.`);
	}

	private async stateOf(livePath: string, wantTreeHash: boolean): Promise<DiskState> {
		const path = this.realPathOf(livePath);
		const stat = await this.ask({ operation: "stat", path });
		if (!stat.ok) {
			if (stat.code === "not_found" || stat.code === "not_a_directory") return { kind: "absent" };
			if (ESCAPE_CODES.has(stat.code)) return { kind: "other", sha256: null };
			return this.unexpected(stat);
		}
		if (stat.kind === "symlink") return { kind: "symlink", sha256: stat.sha256 ?? null };
		if (stat.kind === "directory") {
			if (!wantTreeHash) return { kind: "directory", sha256: null };
			const tree = await this.ask({ operation: "stat", path, tree: true });
			return { kind: "directory", sha256: tree.ok ? (tree.treeSha256 ?? null) : null };
		}
		if (stat.kind === "file") {
			const read = await this.ask({ operation: "read", path, range: { offset: 0, length: 0, maxFileBytes: READ_MAXIMUM_FILE_BYTES, mask: false } });
			return { kind: "file", sha256: read.ok ? (read.sha256 ?? null) : null };
		}
		return { kind: "other", sha256: null };
	}

	private async applyMkdir(entry: MkdirEntry): Promise<Verdict> {
		const response = await this.ask({ operation: "mkdir", path: this.realPathOf(entry.path) });
		if (response.ok) return response.created === true ? APPLIED : ALREADY;
		if (response.code === "already_exists" || ESCAPE_CODES.has(response.code)) return conflict("kind_mismatch");
		if (response.code === "parent_missing" || response.code === "not_a_directory") return conflict("collision");
		return this.unexpected(response);
	}

	private async applyMove(entry: MoveEntry): Promise<Verdict> {
		const seen = entry.directory ? { treeSha256: entry.tree_sha256 ?? undefined } : { sha256: entry.sha256 ?? undefined };
		const response = await this.ask({ operation: "rename", path: this.realPathOf(entry.from), to: this.realPathOf(entry.path), ...seen });
		if (response.ok) return APPLIED;
		const kept = entry.directory ? entry.tree_sha256 : entry.sha256;
		switch (response.code) {
			case "precondition_failed":
				return conflict("changed", response.currentSha256 ?? null);
			case "not_found": {
				const target = await this.stateOf(entry.path, entry.directory);
				return target.kind !== "absent" && target.sha256 !== null && target.sha256 === kept ? ALREADY : conflict("changed");
			}
			case "already_exists": {
				const target = await this.stateOf(entry.path, entry.directory);
				return conflict("collision", target.kind === "absent" ? null : target.sha256);
			}
			case "parent_missing":
			case "not_a_directory":
			case "invalid_move":
				return conflict("collision");
			default:
				if (ESCAPE_CODES.has(response.code)) return conflict("kind_mismatch");
				return this.unexpected(response);
		}
	}

	private async applyPut(entry: PutEntry): Promise<Verdict> {
		const bytes = await this.blobOf(entry);
		const precondition = entry.base_sha256 === null ? ({ type: "if_none_match" } as const) : ({ type: "if_match", sha256: entry.base_sha256 } as const);
		const response = await this.ask({ operation: "write", path: this.realPathOf(entry.path), content: bytes.toString("utf8"), precondition });
		if (response.ok) return APPLIED;
		switch (response.code) {
			case "precondition_failed":
				return response.currentSha256 === entry.sha256 ? ALREADY : conflict("changed", response.currentSha256 ?? null);
			case "already_exists": {
				const disk = await this.stateOf(entry.path, false);
				if (disk.kind === "file") return disk.sha256 === entry.sha256 ? ALREADY : conflict("changed", disk.sha256);
				return conflict("kind_mismatch");
			}
			case "not_a_file":
				return conflict("kind_mismatch");
			case "not_found":
			case "file_too_large":
				return conflict("changed");
			case "parent_missing":
			case "not_a_directory":
				return conflict("collision");
			default:
				if (ESCAPE_CODES.has(response.code)) return conflict("kind_mismatch");
				return this.unexpected(response);
		}
	}

	private async blobOf(entry: PutEntry): Promise<Buffer> {
		let bytes: Buffer | null;
		try {
			bytes = await this.options.blobs.read(entry.sha256);
		} catch {
			throw new OverlayApplyError("blob_unreadable", "An overlay blob could not be read.");
		}
		if (bytes === null) throw new OverlayApplyError("blob_unreadable", "An overlay blob is missing.");
		if (sha256Of(bytes) !== entry.sha256 || Buffer.from(bytes.toString("utf8"), "utf8").compare(bytes) !== 0) {
			throw new OverlayApplyError("blob_tampered", "An overlay blob does not hash to its entry.");
		}
		return bytes;
	}

	private async applyFileDelete(entry: DeleteEntry): Promise<Verdict> {
		return this.removeFile(entry.path, entry.base_sha256);
	}

	private async removeFile(livePath: string, seen: string | null): Promise<Verdict> {
		const response = await this.ask({ operation: "unlink", path: this.realPathOf(livePath), sha256: seen ?? undefined });
		if (response.ok) return APPLIED;
		switch (response.code) {
			case "not_found":
				return ALREADY;
			case "precondition_failed":
				return conflict("changed", response.currentSha256 ?? null);
			case "directory_not_empty":
				return conflict("kind_mismatch");
			case "not_a_directory":
				return conflict("collision");
			default:
				if (ESCAPE_CODES.has(response.code)) return conflict("kind_mismatch");
				return this.unexpected(response);
		}
	}

	private async applyDirectoryDelete(entry: DeleteEntry): Promise<Verdict> {
		const path = this.realPathOf(entry.path);
		const response = entry.recursive
			? await this.ask({ operation: "rmtree", path, recursive: true, treeSha256: entry.tree_sha256 ?? undefined })
			: await this.ask({ operation: "unlink", path, treeSha256: EMPTY_DIRECTORY_TREE_HASH });
		if (response.ok) return APPLIED;
		switch (response.code) {
			case "not_found":
				return ALREADY;
			case "precondition_failed":
				return entry.recursive ? conflict("changed", response.currentSha256 ?? null) : conflict("kind_mismatch", response.currentSha256 ?? null);
			case "directory_not_empty":
				return conflict("not_empty");
			case "too_many_entries":
				return conflict("changed");
			case "not_a_directory":
				return conflict("kind_mismatch");
			default:
				if (ESCAPE_CODES.has(response.code)) return conflict("kind_mismatch");
				return this.unexpected(response);
		}
	}
}
