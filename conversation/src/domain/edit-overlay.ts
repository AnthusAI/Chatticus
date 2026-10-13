/**
 * The edit overlay: what the Front Door does with the edits a member makes while the computer is off, and what it does for
 * the owner that takes them over. The overlay is two kinds of object in the snapshot bucket: one index, replaced only by
 * compare-and-swap, and one immutable blob per edited file. Every write here is a swap of the index; a swap that is lost
 * re-reads and re-judges, at most {@link OVERLAY_CAS_ATTEMPTS} times. The seal in the index is the single point at which a
 * member write and the owner are ordered. See docs/LIVE_FILES_PROTOCOL.md sections 7.7 and 7.8.
 */

import { createHash } from "node:crypto";
import {
	OVERLAY_CAS_ATTEMPTS,
	OVERLAY_INDEX_OBJECT,
	OVERLAY_INDEX_VERSION,
	OVERLAY_SEAL_RETRY_AFTER_MILLISECONDS,
	OVERLAY_STOPPING_RETRY_AFTER_MILLISECONDS,
	overlayBlobObject,
	overlayIndexSchema,
	type OverlayEntry,
	type OverlayIndex,
} from "@chatticus/host-protocol/edit-overlay";
import { LIVE_FILE_CONTENT_MAX_BYTES } from "@chatticus/host-protocol/live-files";
import { looksLikeSecretFile } from "@chatticus/host-protocol/live-file-rules";
import type { Clock, IdSource } from "../http/app.ts";
import { ComputerNotFoundError } from "../http/errors.ts";
import { loadedIndexOf } from "../snapshot/files.ts";
import { indexChecksumOf, parseIndex } from "../snapshot/index-format.ts";
import { type OverlayLocation, type OverlayStore } from "../snapshot/overlay-store.ts";
import {
	createEffectiveView,
	overlayEntryStateOf,
	snapshotViewOfIndex,
	type EffectiveView,
	type OverlayEntryState,
	type OverlaySnapshotView,
} from "../snapshot/overlay-merge.ts";
import { SnapshotObjectMissingError } from "../snapshot/pack.ts";
import type { SnapshotReadStore } from "../snapshot/store.ts";
import { snapshotUri } from "../snapshot/uri.ts";
import type { Computer } from "../store/codecs/computer.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import { consoleLogEmitter } from "../observability/log-line.ts";
import { liveOwnerOf } from "./computers.ts";
import { OwnerRefusal, type OwnerIdentity } from "./owner-supervisor.ts";
import { planOverlayChange, type OverlayChangeRequest, type OverlayPlan, type OverlayRefusalCode } from "./overlay-write-algebra.ts";

/** What a record of the overlay audit trail says was done. */
export type OverlayAuditOperation = "write" | "create" | "discard" | "overlay_apply" | "delete" | "move" | "mkdir";

/** How an audited operation ended. */
export type OverlayAuditOutcome = "pending" | "ok" | "conflict" | "refused" | "failed" | "unknown";

/** One audit record, written before the overlay is touched. It holds hashes and paths, never content. */
export type OverlayAuditRecord = {
	readonly operationId: string;
	readonly tenantId: string;
	readonly computerId: string;
	readonly userId: string;
	readonly operation: OverlayAuditOperation;
	readonly path: string;
	readonly toPath?: string;
	readonly recursive?: boolean;
	readonly source: "overlay";
	readonly ownerId?: string;
	readonly outcome: OverlayAuditOutcome;
	readonly errorCode?: string;
	readonly sha256Before?: string | null;
	readonly sha256After?: string | null;
	readonly treeSha256Before?: string | null;
	readonly bytes?: number;
	readonly secretName?: boolean;
	readonly at: string;
};

/** How an audit record that was begun ended. */
export type OverlayAuditFinish = {
	readonly outcome: Exclude<OverlayAuditOutcome, "pending">;
	readonly errorCode?: string;
	readonly removed?: number;
	readonly finishedAt: string;
};

/**
 * Where overlay audit records go. `begin` must fail rather than lose a record: the overlay is not touched when it does.
 * The production sink is the audit family of the messaging table (part A1/A2); scenarios record in memory.
 */
export interface OverlayAuditSink {
	begin(record: OverlayAuditRecord): Promise<void>;
	finish(operationId: string, finish: OverlayAuditFinish): Promise<void>;
}

/** What the Front Door is composed with to serve the overlay. */
export type EditOverlayRuntime = {
	readonly overlay: OverlayStore;
	readonly snapshots: SnapshotReadStore;
	readonly audit: OverlayAuditSink;
};

/** Everything an overlay operation reads and writes. */
export type EditOverlayDependencies = EditOverlayRuntime & {
	readonly store: Pick<MessagingStore, "getComputer" | "getWorker">;
	readonly clock: Clock;
	readonly ids: IdSource;
	/** Seconds without a heartbeat after which an owner, and so its seal, is taken to be gone. */
	readonly heartbeatTimeoutSeconds: number;
};

/** The code of a refusal the overlay adds to those of the write algebra. */
export type OverlayDomainRefusalCode =
	| OverlayRefusalCode
	| "computer_starting"
	| "computer_stopping"
	| "content_too_large"
	| "audit_unavailable"
	| "overlay_unavailable"
	| "overlay_contended"
	| "snapshot_not_indexed"
	| "precondition_failed"
	| "corrupt_snapshot";

/** The HTTP status of each refusal the overlay raises (section 6.3 of the contract). */
export const OVERLAY_REFUSAL_STATUS: Readonly<Record<OverlayDomainRefusalCode, number>> = {
	path_refused: 403,
	not_in_saved_copy: 422,
	not_found: 404,
	parent_missing: 404,
	not_a_file: 422,
	not_a_directory: 422,
	already_exists: 409,
	precondition_failed: 409,
	overlay_full: 409,
	path_busy: 409,
	directory_not_empty: 409,
	owner_role_required: 403,
	invalid_move: 422,
	too_many_entries: 413,
	file_too_large: 413,
	computer_starting: 503,
	computer_stopping: 503,
	content_too_large: 413,
	audit_unavailable: 503,
	overlay_unavailable: 503,
	overlay_contended: 503,
	snapshot_not_indexed: 409,
	corrupt_snapshot: 500,
};

/** A change the overlay will not take, with the code and status the member route answers with. */
export class EditOverlayRefusal extends Error {
	readonly code: OverlayDomainRefusalCode;
	readonly status: number;
	readonly currentSha256: string | null | undefined;
	readonly retryAfterMs: number | undefined;

	/**
	 * @param code Why.
	 * @param message A description that never carries content.
	 * @param options The hash a failed precondition found, and when to ask again.
	 */
	constructor(code: OverlayDomainRefusalCode, message: string, options: { currentSha256?: string | null; retryAfterMs?: number } = {}) {
		super(message);
		this.name = "EditOverlayRefusal";
		this.code = code;
		this.status = OVERLAY_REFUSAL_STATUS[code];
		this.currentSha256 = options.currentSha256;
		this.retryAfterMs = options.retryAfterMs;
	}
}

/** A member's change. A put carries the text; the other kinds are as the write algebra takes them. */
export type OverlayMemberChange =
	| {
			readonly op: "put";
			readonly path: string;
			readonly content: string;
			readonly precondition: { readonly type: "if_match"; readonly sha256: string } | { readonly type: "if_none_match" };
	  }
	| Exclude<OverlayChangeRequest, { op: "put" }>;

/** What a recorded (or harmlessly repeated) change came to. */
export type OverlayChangeOutcome = {
	readonly operationId: string | null;
	readonly changed: boolean;
	readonly path: string;
	readonly created: boolean;
	readonly directory: boolean;
	/** The effective hash after the change: the content hash of a put or a moved file; null for a delete, a folder or a mkdir. */
	readonly sha256: string | null;
	readonly previousSha256: string | null;
	readonly size: number | null;
	readonly revision: number | null;
	readonly removed: number;
	readonly modifiedAt: string;
};

const sha256Of = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const log = consoleLogEmitter({});

const locationOf = (computer: Computer): OverlayLocation => ({ tenantId: computer.tenantId, computerId: computer.computerId });

async function requireComputer(deps: EditOverlayDependencies, tenantId: string): Promise<Computer> {
	const computer = await deps.store.getComputer(tenantId);
	if (computer === null) throw new ComputerNotFoundError(`Organization ${tenantId} has no computer.`);
	return computer;
}

async function storeCall<Result>(run: () => Promise<Result>): Promise<Result> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof EditOverlayRefusal || error instanceof OwnerRefusal) throw error;
		log("overlay_store_failed", { error: error instanceof Error ? error.name : "unknown" });
		throw new EditOverlayRefusal("overlay_unavailable", "The saved edits cannot be reached right now.");
	}
}

const EMPTY_INDEX: OverlayIndex = { version: OVERLAY_INDEX_VERSION, sealed: null, entries: [] };

/**
 * The overlay index and the entity tag it was read with; an absent index is an empty one with no tag.
 *
 * @throws EditOverlayRefusal `overlay_unavailable` when the store fails or the index does not parse.
 */
export async function readOverlayState(deps: EditOverlayDependencies, location: OverlayLocation): Promise<{ index: OverlayIndex; etag: string | null }> {
	const read = await storeCall(() => deps.overlay.get(location, OVERLAY_INDEX_OBJECT));
	if (read.kind !== "found") return { index: EMPTY_INDEX, etag: null };
	const parsed = overlayIndexSchema.safeParse(safeJson(read.object.body));
	if (!parsed.success) {
		log("overlay_index_corrupt", { tenant_id: location.tenantId });
		throw new EditOverlayRefusal("overlay_unavailable", "The saved edits cannot be read.");
	}
	return { index: parsed.data, etag: read.object.etag };
}

function safeJson(body: Buffer): unknown {
	try {
		return JSON.parse(body.toString("utf8"));
	} catch {
		return null;
	}
}

/**
 * The snapshot the overlay is merged over: the published index, or an empty workspace when nothing was published.
 *
 * @throws EditOverlayRefusal `snapshot_not_indexed` for a pack published before indexes existed.
 */
export async function loadOverlaySnapshotView(deps: EditOverlayDependencies, location: OverlayLocation): Promise<OverlaySnapshotView> {
	const uri = snapshotUri(location.tenantId, location.computerId, { bucket: deps.snapshots.bucket });
	let manifest;
	try {
		manifest = await Promise.resolve(deps.snapshots.getManifest(uri));
	} catch (error) {
		if (error instanceof SnapshotObjectMissingError) return snapshotViewOfIndex(null);
		throw error;
	}
	if (manifest.index_checksum === undefined) {
		throw new EditOverlayRefusal("snapshot_not_indexed", "The snapshot has no index yet; it needs to be published again.");
	}
	const bytes = await Promise.resolve(deps.snapshots.getIndexBytes(uri, manifest.checksum));
	if (indexChecksumOf(bytes) !== manifest.index_checksum) {
		throw new EditOverlayRefusal("corrupt_snapshot", "The snapshot index does not match the manifest.");
	}
	return snapshotViewOfIndex(loadedIndexOf(parseIndex(bytes).entries));
}

/** The overlay merged over the snapshot for one organization, as every read and every judgement sees it. */
export async function loadEffectiveOverlayView(
	deps: EditOverlayDependencies,
	tenantId: string,
): Promise<{ view: EffectiveView; index: OverlayIndex; snapshot: OverlaySnapshotView }> {
	const computer = await requireComputer(deps, tenantId);
	const location = locationOf(computer);
	const [{ index }, snapshot] = await Promise.all([readOverlayState(deps, location), loadOverlaySnapshotView(deps, location)]);
	return { view: createEffectiveView(snapshot, index.entries), index, snapshot };
}

/**
 * The text of an overlay blob, verified against its name.
 *
 * @throws EditOverlayRefusal `corrupt_snapshot` when the blob is missing or does not hash to its name.
 */
export async function readOverlayBlobText(deps: EditOverlayDependencies, location: OverlayLocation, sha256: string): Promise<string> {
	const read = await storeCall(() => deps.overlay.get(location, overlayBlobObject(sha256)));
	if (read.kind !== "found" || sha256Of(read.object.body) !== sha256) {
		throw new EditOverlayRefusal("corrupt_snapshot", "A saved edit does not match its record.");
	}
	return read.object.body.toString("utf8");
}

/**
 * Whether a seal still binds: its owner is the computer's current owner of that generation and is alive. A seal that no
 * longer binds is stale, and the next writer replaces it.
 */
export function sealBinds(index: OverlayIndex, computer: Computer, worker: Awaited<ReturnType<MessagingStore["getWorker"]>>, now: Date, heartbeatTimeoutSeconds: number): boolean {
	const seal = index.sealed;
	return seal !== null && computer.ownerId === seal.owner_id && computer.ownerGeneration === seal.generation && liveOwnerOf(computer, worker, now, heartbeatTimeoutSeconds);
}

async function refuseWhileSealed(deps: EditOverlayDependencies, tenantId: string, index: OverlayIndex): Promise<void> {
	if (index.sealed === null) return;
	const computer = await requireComputer(deps, tenantId);
	const worker = computer.ownerId === undefined ? null : await deps.store.getWorker(tenantId, computer.ownerId);
	if (!sealBinds(index, computer, worker, deps.clock.now(), deps.heartbeatTimeoutSeconds)) return;
	if (worker?.pollState === "stopping" || computer.ownerStopApprovedAt !== undefined) {
		throw new EditOverlayRefusal("computer_stopping", "The computer is stopping; try again in a moment.", { retryAfterMs: OVERLAY_STOPPING_RETRY_AFTER_MILLISECONDS });
	}
	throw new EditOverlayRefusal("computer_starting", "The computer is starting; try again in a moment.", { retryAfterMs: OVERLAY_SEAL_RETRY_AFTER_MILLISECONDS });
}

async function swapIndex(deps: EditOverlayDependencies, location: OverlayLocation, etag: string | null, entries: readonly OverlayEntry[], sealed: OverlayIndex["sealed"]): Promise<boolean> {
	const body = Buffer.from(JSON.stringify({ version: OVERLAY_INDEX_VERSION, sealed, entries }));
	const written = await storeCall(() =>
		etag === null ? deps.overlay.putIfAbsent(location, OVERLAY_INDEX_OBJECT, body) : deps.overlay.putIfMatch(location, OVERLAY_INDEX_OBJECT, body, etag),
	);
	return written.kind === "written";
}

const blobHashesOf = (entries: readonly OverlayEntry[]): Set<string> => new Set(entries.flatMap((entry) => (entry.op === "put" ? [entry.sha256] : [])));

async function deleteUnreferencedBlobs(deps: EditOverlayDependencies, location: OverlayLocation, before: readonly OverlayEntry[], after: readonly OverlayEntry[]): Promise<void> {
	const still = blobHashesOf(after);
	for (const sha256 of blobHashesOf(before)) {
		if (still.has(sha256)) continue;
		try {
			await deps.overlay.delete(location, overlayBlobObject(sha256));
		} catch {
			log("overlay_blob_delete_failed", { tenant_id: location.tenantId });
		}
	}
}

async function beginAudit(deps: EditOverlayDependencies, record: OverlayAuditRecord): Promise<void> {
	try {
		await deps.audit.begin(record);
	} catch {
		throw new EditOverlayRefusal("audit_unavailable", "The record of this change cannot be kept right now, so nothing was changed.");
	}
}

async function finishAudit(deps: EditOverlayDependencies, operationId: string, finish: Omit<OverlayAuditFinish, "finishedAt">): Promise<void> {
	try {
		await deps.audit.finish(operationId, { ...finish, finishedAt: deps.clock.now().toISOString() });
	} catch {
		log("overlay_audit_finish_failed", { operation_id: operationId });
	}
}

function auditRecordFor(
	base: Pick<OverlayAuditRecord, "operationId" | "tenantId" | "computerId" | "userId" | "at">,
	change: OverlayMemberChange,
	plan: Extract<OverlayPlan, { kind: "changed" }> | null,
	outcome: OverlayAuditOutcome,
	errorCode?: string,
): OverlayAuditRecord {
	const common = { ...base, source: "overlay" as const, outcome, ...(errorCode === undefined ? {} : { errorCode }) };
	switch (change.op) {
		case "put": {
			const bytes = Buffer.from(change.content, "utf8");
			return {
				...common,
				operation: change.precondition.type === "if_none_match" ? "create" : "write",
				path: change.path,
				sha256Before: change.precondition.type === "if_match" ? change.precondition.sha256 : null,
				sha256After: sha256Of(bytes),
				bytes: bytes.length,
				secretName: looksLikeSecretFile(change.path),
			};
		}
		case "delete":
			return {
				...common,
				operation: "delete",
				path: change.path,
				recursive: change.recursive,
				...(plan?.directory === true ? { treeSha256Before: change.ifMatchSha256 } : { sha256Before: change.ifMatchSha256 }),
				secretName: looksLikeSecretFile(change.path),
			};
		case "move":
			return { ...common, operation: "move", path: change.from, toPath: change.to, sha256Before: change.ifMatchSha256 };
		case "mkdir":
			return { ...common, operation: "mkdir", path: change.path };
	}
}

/**
 * Record a member's change in the overlay: judge it against the effective view, write the audit record, store the blob
 * of a put, and swap the index. A swap lost to another writer re-reads and re-judges, at most three times; a seal that
 * appeared in the meantime refuses the change with `computer_starting`.
 *
 * @param deps Stores, clock and ids.
 * @param input The organization, the member, and the change.
 * @returns What the change came to; `changed` is false for a repeat that wrote nothing.
 * @throws EditOverlayRefusal When the change is refused, with the code, status and any hash or retry time to answer with.
 */
export async function changeOverlay(
	deps: EditOverlayDependencies,
	input: { readonly tenantId: string; readonly userId: string; readonly request: OverlayMemberChange },
): Promise<OverlayChangeOutcome> {
	const computer = await requireComputer(deps, input.tenantId);
	const location = locationOf(computer);
	const at = deps.clock.now().toISOString();
	const operationId = `fop-${deps.ids.next()}`;
	const snapshot = await loadOverlaySnapshotView(deps, location);
	const change = input.request;
	let blob: { sha256: string; size: number; body: Buffer } | null = null;
	if (change.op === "put") {
		const body = Buffer.from(change.content, "utf8");
		if (body.length > LIVE_FILE_CONTENT_MAX_BYTES) throw new EditOverlayRefusal("content_too_large", "Content over 256 KiB is not saved here.");
		blob = { sha256: sha256Of(body), size: body.length, body };
	}
	const algebraRequest: OverlayChangeRequest =
		change.op === "put" && blob !== null ? { op: "put", path: change.path, sha256: blob.sha256, size: blob.size, precondition: change.precondition } : (change as OverlayChangeRequest);
	const auditBase = { operationId, tenantId: computer.tenantId, computerId: computer.computerId, userId: input.userId, at };
	let begun = false;
	let blobStored = false;

	for (let attempt = 1; attempt <= OVERLAY_CAS_ATTEMPTS; attempt += 1) {
		const { index, etag } = await readOverlayState(deps, location);
		try {
			await refuseWhileSealed(deps, computer.tenantId, index);
		} catch (error) {
			if (begun) await finishAudit(deps, operationId, { outcome: "failed", errorCode: error instanceof EditOverlayRefusal ? error.code : "failed" });
			throw error;
		}
		const plan = planOverlayChange({ snapshot, entries: index.entries, request: algebraRequest, editedBy: input.userId, editedAt: at });
		if (plan.kind === "refused") {
			if (begun) await finishAudit(deps, operationId, { outcome: "refused", errorCode: plan.code });
			else await deps.audit.begin(auditRecordFor(auditBase, change, null, "refused", plan.code)).catch(() => undefined);
			throw new EditOverlayRefusal(plan.code, plan.message, plan.currentSha256 === undefined ? {} : { currentSha256: plan.currentSha256 });
		}
		if (plan.kind === "unchanged") {
			if (begun) await finishAudit(deps, operationId, { outcome: "ok" });
			return {
				operationId: begun ? operationId : null,
				changed: false,
				path: change.op === "move" ? change.to : change.path,
				created: plan.created,
				directory: change.op === "mkdir",
				sha256: plan.sha256,
				previousSha256: plan.previousSha256,
				size: blob?.size ?? null,
				revision: null,
				removed: 0,
				modifiedAt: at,
			};
		}
		if (!begun) {
			await beginAudit(deps, auditRecordFor(auditBase, change, plan, "pending"));
			begun = true;
		}
		if (blob !== null && !blobStored) {
			const stored = blob;
			await storeCall(() => deps.overlay.putIfAbsent(location, overlayBlobObject(stored.sha256), stored.body));
			blobStored = true;
		}
		if (await swapIndex(deps, location, etag, plan.entries, null)) {
			await finishAudit(deps, operationId, { outcome: "ok", ...(change.op === "delete" ? { removed: plan.removed } : {}) });
			await deleteUnreferencedBlobs(deps, location, index.entries, plan.entries);
			const entry = plan.entries.find((candidate) => candidate.path === plan.path);
			return {
				operationId,
				changed: true,
				path: plan.path,
				created: plan.created,
				directory: plan.directory,
				sha256: plan.resultSha256,
				previousSha256: plan.previousSha256,
				size: entry?.op === "put" ? entry.size : (blob?.size ?? null),
				revision: entry?.revision ?? null,
				removed: plan.removed,
				modifiedAt: at,
			};
		}
	}
	if (begun) await finishAudit(deps, operationId, { outcome: "failed", errorCode: "overlay_contended" });
	throw new EditOverlayRefusal("overlay_contended", "Other changes are being saved at the same moment; try again.", { retryAfterMs: 1000 });
}

/**
 * Drop one pending change of any kind, by the revision the member saw. Works only while the overlay is writable.
 *
 * @throws EditOverlayRefusal `precondition_failed` when the entry is gone or has a newer revision; `computer_starting` or `computer_stopping` while sealed.
 */
export async function discardOverlayEntry(
	deps: EditOverlayDependencies,
	input: { readonly tenantId: string; readonly userId: string; readonly path: string; readonly revision: number },
): Promise<void> {
	const computer = await requireComputer(deps, input.tenantId);
	const location = locationOf(computer);
	const operationId = `fop-${deps.ids.next()}`;
	const at = deps.clock.now().toISOString();
	let begun = false;
	for (let attempt = 1; attempt <= OVERLAY_CAS_ATTEMPTS; attempt += 1) {
		const { index, etag } = await readOverlayState(deps, location);
		try {
			await refuseWhileSealed(deps, computer.tenantId, index);
		} catch (error) {
			if (begun) await finishAudit(deps, operationId, { outcome: "failed", errorCode: error instanceof EditOverlayRefusal ? error.code : "failed" });
			throw error;
		}
		const entry = index.entries.find((candidate) => candidate.path === input.path);
		if (entry === undefined || entry.revision !== input.revision) {
			if (begun) await finishAudit(deps, operationId, { outcome: "refused", errorCode: "precondition_failed" });
			throw new EditOverlayRefusal("precondition_failed", "That change is no longer waiting, or it changed since it was shown.");
		}
		if (!begun) {
			await beginAudit(deps, {
				operationId,
				tenantId: computer.tenantId,
				computerId: computer.computerId,
				userId: input.userId,
				operation: "discard",
				path: input.path,
				source: "overlay",
				outcome: "pending",
				sha256Before: entry.op === "put" ? entry.sha256 : null,
				at,
			});
			begun = true;
		}
		const remaining = index.entries.filter((candidate) => candidate.path !== input.path);
		if (await swapIndex(deps, location, etag, remaining, null)) {
			await finishAudit(deps, operationId, { outcome: "ok" });
			await deleteUnreferencedBlobs(deps, location, index.entries, remaining);
			return;
		}
	}
	await finishAudit(deps, operationId, { outcome: "failed", errorCode: "overlay_contended" });
	throw new EditOverlayRefusal("overlay_contended", "Other changes are being saved at the same moment; try again.", { retryAfterMs: 1000 });
}

/** The pending changes of an organization, each with where it stands against the snapshot. */
export async function listOverlayEntries(
	deps: EditOverlayDependencies,
	tenantId: string,
): Promise<ReadonlyArray<OverlayEntry & { readonly state: OverlayEntryState }>> {
	const { view, index } = await loadEffectiveOverlayView(deps, tenantId);
	return index.entries.map((entry) => ({ ...entry, state: view.states.get(entry.path) ?? "pending" }));
}

/**
 * Seal the overlay for an owner: from now on member writes wait, and the owner applies the entries this returns. The seal
 * is one swap; a lost swap re-reads, so an edit that won the swap is in the set. A seal this owner already holds is
 * returned as it is (a retry). Any other seal is stale by construction, since the caller is the live owner.
 *
 * @returns Every entry of the overlay.
 * @throws EditOverlayRefusal `overlay_unavailable` or `overlay_contended`, which the route answers with 503.
 */
export async function sealOverlay(deps: EditOverlayDependencies, owner: Pick<OwnerIdentity, "tenantId" | "ownerId" | "startGeneration">): Promise<{ entries: OverlayEntry[] }> {
	const computer = await requireComputer(deps, owner.tenantId);
	const location = locationOf(computer);
	for (let attempt = 1; attempt <= OVERLAY_CAS_ATTEMPTS; attempt += 1) {
		const { index, etag } = await readOverlayState(deps, location);
		if (index.sealed?.owner_id === owner.ownerId && index.sealed.generation === owner.startGeneration) return { entries: index.entries };
		const seal = {
			owner_id: owner.ownerId,
			generation: owner.startGeneration,
			sealed_at: deps.clock.now().toISOString(),
			snapshot_generation: computer.snapshotGeneration,
		};
		if (await swapIndex(deps, location, etag, index.entries, seal)) return { entries: index.entries };
	}
	throw new EditOverlayRefusal("overlay_contended", "The overlay is being changed at the same moment; try again.", { retryAfterMs: 1000 });
}

/** One entry the owner names, by path and the revision it applied. */
export type OverlayEntryReference = { readonly path: string; readonly revision: number };

/**
 * Clear the entries an owner applied, and store the conflicts it found. An entry is cleared only when the caller holds the
 * seal, the entry still has the named revision, and a publish is on record: the computer's snapshot generation is past the
 * seal's, or the snapshot already shows the entry's result. Anything else stays and is counted in `remaining`.
 *
 * @throws OwnerRefusal `overlay_not_sealed` when the overlay is not sealed by this owner and generation.
 * @throws EditOverlayRefusal `audit_unavailable`, `overlay_unavailable` or `overlay_contended`, answered with 503.
 */
export async function clearOverlay(
	deps: EditOverlayDependencies,
	owner: Pick<OwnerIdentity, "tenantId" | "ownerId" | "startGeneration">,
	request: { readonly cleared: readonly OverlayEntryReference[]; readonly conflicts: ReadonlyArray<OverlayEntryReference & { readonly disk_sha256: string | null }> },
): Promise<{ remaining: number }> {
	const location = { tenantId: owner.tenantId, computerId: (await requireComputer(deps, owner.tenantId)).computerId };
	const auditIds = new Map<string, string>();
	for (let attempt = 1; attempt <= OVERLAY_CAS_ATTEMPTS; attempt += 1) {
		const { index, etag } = await readOverlayState(deps, location);
		const seal = index.sealed;
		if (seal === null || seal.owner_id !== owner.ownerId || seal.generation !== owner.startGeneration) {
			throw new OwnerRefusal("overlay_not_sealed", "the overlay is not sealed by this owner");
		}
		const computer = await requireComputer(deps, owner.tenantId);
		const publishRecorded = computer.snapshotGeneration > seal.snapshot_generation;
		const snapshot = publishRecorded ? null : await loadOverlaySnapshotView(deps, location);
		const matching = (reference: OverlayEntryReference): OverlayEntry | undefined =>
			index.entries.find((entry) => entry.path === reference.path && entry.revision === reference.revision);
		const toClear = request.cleared.flatMap((reference) => {
			const entry = matching(reference);
			if (entry === undefined) return [];
			if (snapshot !== null && overlayEntryStateOf(entry, snapshot) !== "applied") return [];
			return [entry];
		});
		const clearedPaths = new Set(toClear.map((entry) => entry.path));
		const toFlag = request.conflicts.flatMap((reference) => {
			const entry = matching(reference);
			return entry === undefined || clearedPaths.has(entry.path) ? [] : [{ entry, diskSha256: reference.disk_sha256 }];
		});
		if (toClear.length === 0 && toFlag.length === 0) return { remaining: index.entries.length };

		const at = deps.clock.now().toISOString();
		const auditKey = (entry: OverlayEntry): string => `${entry.path}#${entry.revision}`;
		for (const entry of [...toClear, ...toFlag.map(({ entry }) => entry)]) {
			const key = auditKey(entry);
			if (auditIds.has(key)) continue;
			const operationId = `fop-${deps.ids.next()}`;
			auditIds.set(key, operationId);
			await beginAudit(deps, {
				operationId,
				tenantId: owner.tenantId,
				computerId: location.computerId,
				userId: entry.edited_by,
				operation: "overlay_apply",
				path: entry.path,
				source: "overlay",
				ownerId: owner.ownerId,
				outcome: "pending",
				...(entry.op === "put" ? { sha256After: entry.sha256 } : {}),
				at,
			});
		}
		const flagged = new Map(toFlag.map(({ entry, diskSha256 }) => [entry.path, diskSha256]));
		const next = index.entries
			.filter((entry) => !clearedPaths.has(entry.path))
			.map((entry): OverlayEntry =>
				flagged.has(entry.path) ? ({ ...entry, conflict: { reason: "changed", disk_sha256: flagged.get(entry.path) ?? null, found_at: at } } as OverlayEntry) : entry,
			);
		if (await swapIndex(deps, location, etag, next, seal)) {
			for (const entry of [...toClear, ...toFlag.map(({ entry }) => entry)]) {
				const operationId = auditIds.get(auditKey(entry));
				if (operationId !== undefined) await finishAudit(deps, operationId, { outcome: clearedPaths.has(entry.path) ? "ok" : "conflict" });
			}
			await deleteUnreferencedBlobs(deps, location, index.entries, next);
			return { remaining: next.length };
		}
	}
	throw new EditOverlayRefusal("overlay_contended", "The overlay is being changed at the same moment; try again.", { retryAfterMs: 1000 });
}

/**
 * End the seal of an owner that reports the computer stopped. Best effort and one swap: a failure is logged, and the stale
 * seal rule covers it. No entry is lost.
 */
export async function unsealOverlay(deps: EditOverlayDependencies, owner: Pick<OwnerIdentity, "tenantId" | "ownerId" | "startGeneration">): Promise<void> {
	try {
		const computer = await requireComputer(deps, owner.tenantId);
		const location = locationOf(computer);
		for (let attempt = 1; attempt <= OVERLAY_CAS_ATTEMPTS; attempt += 1) {
			const { index, etag } = await readOverlayState(deps, location);
			if (index.sealed?.owner_id !== owner.ownerId || index.sealed.generation !== owner.startGeneration) return;
			if (await swapIndex(deps, location, etag, index.entries, null)) return;
		}
	} catch (error) {
		log("overlay_unseal_failed", { tenant_id: owner.tenantId, error: error instanceof Error ? error.name : "unknown" });
	}
}
