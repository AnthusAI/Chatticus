/**
 * The audit trail of file changes and reveals. The Front Door writes a record before it asks the owner or touches the
 * overlay, and fails closed when it cannot; the record is finished by the result route (a live change) or by the Front Door
 * (a change to the overlay, a reveal from the saved copy). A record holds hashes, sizes and names, never content. See
 * docs/LIVE_FILES_PROTOCOL.md sections 7.1 and 7.3.
 */

import { LIVE_FILE_AUDIT_RETENTION_DAYS } from "@chatticus/host-protocol/live-files";
import { looksLikeSecretFile } from "@chatticus/host-protocol/live-file-rules";
import type { FileAuditOperation, FileAuditOutcome, FileAuditRecord, FileAuditSource } from "../store/codecs/file-audit.ts";
import type { FileAuditFinish, MessagingStore } from "../store/messaging-store.ts";
import type { OverlayAuditFinish, OverlayAuditRecord, OverlayAuditSink } from "./edit-overlay.ts";
import { MemberFileRefusal } from "./member-file-refusal.ts";

const MILLISECONDS_PER_DAY = 24 * 3600 * 1000;

/** The most records a sink remembers as begun and not finished; a request that dies between the two leaves one behind. */
const MAX_UNFINISHED_RECORDS = 500;

/** When an audit record written at `at` expires: 90 days later. */
export const auditExpiryOf = (at: Date): Date => new Date(at.getTime() + LIVE_FILE_AUDIT_RETENTION_DAYS * MILLISECONDS_PER_DAY);

/** What an audited member action did, as far as the Front Door knows before anything is carried out. */
export type MemberAuditIntent = {
	readonly operation: FileAuditOperation;
	readonly path: string;
	readonly toPath?: string;
	readonly recursive?: boolean;
	/** The hash the person expected (`If-Match`). */
	readonly sha256Before?: string;
	readonly treeSha256Before?: string;
	/** The hash of the bytes the Front Door sends. */
	readonly sha256After?: string;
	readonly bytes?: number;
};

/** Who and where an audited action belongs to. */
export type MemberAuditSubject = {
	readonly tenantId: string;
	readonly computerId: string;
	/** From the principal, never from a body. */
	readonly userId: string;
	readonly operationId: string;
	readonly at: Date;
	readonly source: FileAuditSource;
};

/**
 * Build an audit record.
 *
 * @param subject Who, which computer, which operation id, when, and where it is carried out.
 * @param intent What is done.
 * @param outcome `pending` for a record begun before the action, `refused` for a refusal written directly.
 * @param errorCode The code of a refusal.
 * @returns The record, expiring in 90 days.
 */
export function memberAuditRecordOf(
	subject: MemberAuditSubject,
	intent: MemberAuditIntent,
	outcome: Extract<FileAuditOutcome, "pending" | "refused">,
	errorCode?: string,
): FileAuditRecord {
	return {
		tenantId: subject.tenantId,
		computerId: subject.computerId,
		userId: subject.userId,
		operationId: subject.operationId,
		operation: intent.operation,
		path: intent.path,
		source: subject.source,
		outcome,
		at: subject.at,
		expiresAt: auditExpiryOf(subject.at),
		secretName: looksLikeSecretFile(intent.path),
		revealed: intent.operation === "reveal",
		...(intent.toPath === undefined ? {} : { toPath: intent.toPath }),
		...(intent.recursive === undefined ? {} : { recursive: intent.recursive }),
		...(intent.sha256Before === undefined ? {} : { sha256Before: intent.sha256Before }),
		...(intent.treeSha256Before === undefined ? {} : { treeSha256Before: intent.treeSha256Before }),
		...(intent.sha256After === undefined ? {} : { sha256After: intent.sha256After }),
		...(intent.bytes === undefined ? {} : { bytes: intent.bytes }),
		...(errorCode === undefined ? {} : { errorCode }),
	};
}

/**
 * Write the record that precedes an action. When the record cannot be written the action is refused and nothing is done.
 *
 * @throws MemberFileRefusal `audit_unavailable`.
 */
export async function beginMemberAudit(store: Pick<MessagingStore, "putFileAudit">, record: FileAuditRecord): Promise<void> {
	try {
		await store.putFileAudit(record);
	} catch {
		throw new MemberFileRefusal("audit_unavailable", "The record of this action cannot be kept right now, so nothing was done.");
	}
}

/** Finish a record the Front Door began. A failure is the caller's to log: the action already happened. */
export async function finishMemberAudit(
	store: Pick<MessagingStore, "finalizeFileAudit">,
	record: Pick<FileAuditRecord, "tenantId" | "at" | "operationId">,
	finish: FileAuditFinish,
): Promise<void> {
	await store.finalizeFileAudit(record.tenantId, record.at.getTime(), record.operationId, finish);
}

/**
 * The audit sink of the edit overlay over the messaging table: the same record family as a live change, with the source
 * `overlay`. A record that cannot be begun refuses the change; the sink remembers where each record lives so that it can be
 * finished later in the same request.
 */
export class StoreOverlayAuditSink implements OverlayAuditSink {
	private readonly store: Pick<MessagingStore, "putFileAudit" | "finalizeFileAudit">;
	private readonly begun = new Map<string, { tenantId: string; at: Date }>();

	constructor(store: Pick<MessagingStore, "putFileAudit" | "finalizeFileAudit">) {
		this.store = store;
	}

	async begin(record: OverlayAuditRecord): Promise<void> {
		const at = new Date(record.at);
		await this.store.putFileAudit({
			tenantId: record.tenantId,
			computerId: record.computerId,
			userId: record.userId,
			operationId: record.operationId,
			operation: record.operation,
			path: record.path,
			source: "overlay",
			outcome: record.outcome,
			at,
			expiresAt: auditExpiryOf(at),
			...(record.toPath === undefined ? {} : { toPath: record.toPath }),
			...(record.recursive === undefined ? {} : { recursive: record.recursive }),
			...(record.ownerId === undefined ? {} : { ownerId: record.ownerId }),
			...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
			...(record.sha256Before === undefined || record.sha256Before === null ? {} : { sha256Before: record.sha256Before }),
			...(record.sha256After === undefined || record.sha256After === null ? {} : { sha256After: record.sha256After }),
			...(record.treeSha256Before === undefined || record.treeSha256Before === null ? {} : { treeSha256Before: record.treeSha256Before }),
			...(record.bytes === undefined ? {} : { bytes: record.bytes }),
			...(record.secretName === undefined ? {} : { secretName: record.secretName }),
			revealed: false,
		});
		if (record.outcome !== "pending") return;
		if (this.begun.size >= MAX_UNFINISHED_RECORDS) this.begun.delete(this.begun.keys().next().value!);
		this.begun.set(record.operationId, { tenantId: record.tenantId, at });
	}

	async finish(operationId: string, finish: OverlayAuditFinish): Promise<void> {
		const where = this.begun.get(operationId);
		if (where === undefined) return;
		this.begun.delete(operationId);
		await this.store.finalizeFileAudit(where.tenantId, where.at.getTime(), operationId, {
			outcome: finish.outcome === "unknown" ? "failed" : finish.outcome,
			finishedAt: new Date(finish.finishedAt),
			...(finish.errorCode === undefined ? {} : { errorCode: finish.errorCode }),
			...(finish.removed === undefined ? {} : { removed: finish.removed }),
		});
	}
}
