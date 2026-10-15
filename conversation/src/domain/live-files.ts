/**
 * What the control plane decides about files on a running computer: whether a request is answered by the live owner or
 * by the saved snapshot, how a request is queued for the owner and handed over in its poll, how the owner's answer is
 * recorded and finishes the audit record, and how an open Files panel changes the owner's poll pace.
 *
 * The owner asks; nothing connects to it. A request is a row in the table with a delivery state, so exactly one of
 * "the Front Door gave up" and "the owner took it" wins. See docs/LIVE_FILES_PROTOCOL.md sections 7.1 to 7.5.
 */

import {
	LIVE_FILE_INTERACTIVE_WINDOW_SECONDS,
	LIVE_FILE_MAX_REQUESTS_PER_POLL,
	LIVE_FILE_OPERATION_TTL_SECONDS,
	LIVE_FILE_OUTCOME_GRACE_MILLISECONDS,
	LIVE_FILE_RESULT_CHECK_MILLISECONDS,
	LIVE_FILE_WAIT_MILLISECONDS,
	liveFileOutcomeSchema,
	ownerFileRequestSchema,
	type LiveFileFallbackReason,
	type LiveFileOutcome,
	type OwnerFileRequest,
	type OwnerFileResultRequest,
} from "@chatticus/host-protocol/live-files";
import { OWNER_FILE_REQUESTS_PROTOCOL_VERSION, OWNER_POLL_INTERACTIVE_MILLISECONDS, OWNER_POLL_SLOW_MILLISECONDS, type OwnerPollRequest } from "@chatticus/host-protocol/supervisor";
import type { Clock, IdSource } from "../http/app.ts";
import type { Computer } from "../store/codecs/computer.ts";
import type { FileAuditRecord } from "../store/codecs/file-audit.ts";
import type { LiveFileOperation } from "../store/codecs/live-file-operation.ts";
import type { Worker } from "../store/codecs/worker.ts";
import type { FileAuditFinish, MessagingStore } from "../store/messaging-store.ts";
import { liveOwnerOf } from "./computers.ts";
import type { OwnerIdentity } from "./owner-supervisor.ts";

/** The owner states in which it can serve a file request: it is not booting, hydrating or stopping. */
export const FILE_SERVING_OWNER_STATES: ReadonlySet<string> = new Set(["idle", "serving", "publishing", "draining"]);

/** What the file functions read and write. */
export type LiveFileDependencies = {
	readonly store: MessagingStore;
	readonly clock: Clock;
	readonly ids: IdSource;
	/** Seconds without a heartbeat after which an owner is taken to be gone. */
	readonly heartbeatTimeoutSeconds: number;
};

/** Where a member's file read is answered from: the live owner, or the snapshot with the reason and whether it may be stale. */
export type LiveFileSource =
	| { readonly source: "live" }
	| { readonly source: "snapshot"; readonly reason: LiveFileFallbackReason | null; readonly stale: boolean };

/**
 * Choose between the live owner and the saved snapshot.
 *
 * Live only for an owner that is live, speaks protocol 2, has finished hydrating, is in a state that can serve a file and
 * has no approved stop. A computer that is off, or whose owner stopped heartbeating, is answered from the snapshot and is
 * not stale: the snapshot is the truth. A running owner that cannot serve yet is answered from the snapshot, stale, with
 * the reason.
 *
 * @param computer The organization computer, or null when it has none.
 * @param worker The worker item of the computer's owner, or null.
 * @param now The current time.
 * @param heartbeatTimeoutSeconds Seconds without a heartbeat after which an owner is taken to be gone.
 * @returns The source.
 */
export function liveFileSourceOf(computer: Computer | null, worker: Worker | null, now: Date, heartbeatTimeoutSeconds: number): LiveFileSource {
	if (computer === null || computer.ownerId === undefined) return { source: "snapshot", reason: null, stale: false };
	if (!liveOwnerOf(computer, worker, now, heartbeatTimeoutSeconds)) return { source: "snapshot", reason: null, stale: false };
	if (computer.ownerProtocolVersion === undefined || computer.ownerProtocolVersion < OWNER_FILE_REQUESTS_PROTOCOL_VERSION) {
		return { source: "snapshot", reason: "owner_too_old", stale: true };
	}
	if (worker!.pollState === "booting" || worker!.pollState === "hydrating") return { source: "snapshot", reason: "owner_not_ready", stale: true };
	if (worker!.pollState === "stopping" || computer.ownerStopApprovedAt !== undefined) return { source: "snapshot", reason: "owner_stopping", stale: true };
	if (computer.hydrateRequired || worker!.pollState === undefined || !FILE_SERVING_OWNER_STATES.has(worker!.pollState)) {
		return { source: "snapshot", reason: "owner_not_ready", stale: true };
	}
	return { source: "live" };
}

/**
 * The poll pace while a Files panel is open: the normal pace, but at most one second, in the states that can serve a file.
 *
 * @param state What the owner reported.
 * @param normalMilliseconds The pace the owner's state and idleness give.
 * @param interactiveUntilAt Until when the interactive window is open, if it is.
 * @param now The current time.
 * @returns The pace.
 */
export function ownerFilePanelPace(state: string, normalMilliseconds: number, interactiveUntilAt: Date | undefined, now: Date): number {
	const open = interactiveUntilAt !== undefined && interactiveUntilAt.getTime() > now.getTime();
	return open && FILE_SERVING_OWNER_STATES.has(state) ? Math.min(normalMilliseconds, OWNER_POLL_INTERACTIVE_MILLISECONDS) : normalMilliseconds;
}

/**
 * How long until the owner polls again, judged from its last heartbeat and the pace it was told then. Zero when the poll is
 * due. A request queued now is picked up about this much later.
 *
 * @param worker The owner's worker item.
 * @param now The current time.
 * @returns Milliseconds until the next expected poll.
 */
export function expectedPickupMilliseconds(worker: Worker, now: Date): number {
	const pace = worker.pollPaceMilliseconds ?? OWNER_POLL_SLOW_MILLISECONDS;
	return Math.max(0, worker.lastHeartbeatAt.getTime() + pace - now.getTime());
}

/** The request as a member route builds it: everything the owner receives except the id and the time left. */
export type LiveFileRequestBody = OwnerFileRequest extends infer Request
	? Request extends OwnerFileRequest
		? Omit<Request, "operation_id" | "expires_in_ms">
		: never
	: never;

/** What queueing a file request needs. */
export type QueueLiveFileRequestInput = {
	/** The computer record the caller judged the owner from. The owner named on it is the only one that can hold the request. */
	readonly computer: Computer;
	/** The member the request is for; from the principal, never from a body. */
	readonly userId: string;
	readonly request: LiveFileRequestBody;
	/** The id the audit record already names; generated when the request has no audit record. */
	readonly operationId?: string;
	/** The epoch milliseconds of the audit record already written for this request; absent for a read. */
	readonly auditAtMilliseconds?: number;
};

/**
 * A new operation id. A caller that writes an audit record before it queues the request takes the id first and passes it to
 * {@link queueLiveFileRequest}.
 *
 * @param ids The identifier source.
 * @returns The id.
 */
export function newLiveFileOperationId(ids: IdSource): string {
	return `fop-${ids.next()}`;
}

/** The result of queueing: queued under an id, or refused because the owner stopped or changed since the caller judged it. */
export type QueueLiveFileRequestResult =
	| { readonly status: "queued"; readonly operationId: string; readonly queuedAt: Date }
	| { readonly status: "owner_stopping" };

/**
 * Queue one file request for the owner named on the computer record, in one transaction with the record: the interactive
 * window opens for 45 seconds and the record names the request, only while that owner is still the live owner of its
 * generation and no stop is approved. An approved stop and a queued request cannot both win.
 *
 * @param deps Store, clock and identifiers.
 * @param input The computer the caller judged, the member and the request.
 * @returns Queued with the operation id, or owner_stopping.
 */
export async function queueLiveFileRequest(deps: LiveFileDependencies, input: QueueLiveFileRequestInput): Promise<QueueLiveFileRequestResult> {
	const { computer } = input;
	if (computer.ownerId === undefined || computer.ownerGeneration === undefined) return { status: "owner_stopping" };
	const queuedAt = deps.clock.now();
	const operationId = input.operationId ?? newLiveFileOperationId(deps.ids);
	const operation: LiveFileOperation = {
		operationId,
		tenantId: computer.tenantId,
		computerId: computer.computerId,
		userId: input.userId,
		ownerId: computer.ownerId,
		generation: computer.ownerGeneration,
		kind: input.request.kind,
		status: "pending",
		request: JSON.stringify(input.request),
		queuedAt,
		...(input.auditAtMilliseconds === undefined ? {} : { auditAtMilliseconds: input.auditAtMilliseconds }),
		expiresAt: new Date(queuedAt.getTime() + LIVE_FILE_OPERATION_TTL_SECONDS * 1000),
	};
	const windowEnd = new Date(queuedAt.getTime() + LIVE_FILE_INTERACTIVE_WINDOW_SECONDS * 1000);
	return (await deps.store.queueLiveFileOperation(operation, windowEnd)) ? { status: "queued", operationId, queuedAt } : { status: "owner_stopping" };
}

const asOwnerRequest = (operation: LiveFileOperation, now: Date): OwnerFileRequest => {
	const body = JSON.parse(operation.request ?? "{}") as Record<string, unknown>;
	const left = Math.max(0, LIVE_FILE_WAIT_MILLISECONDS - (now.getTime() - operation.queuedAt.getTime()));
	return ownerFileRequestSchema.parse({ ...body, operation_id: operation.operationId, expires_in_ms: left });
};

/**
 * The file requests a poll hands to the owner: the pending requests queued for this owner and generation, oldest first,
 * each handed over by one conditional write so that no other poll takes it too, and the requests this very poll sequence
 * already delivered, so a repeat of a poll whose answer was lost gets the same requests again. Nothing is delivered to an
 * owner below protocol 2, in a state that cannot serve a file, with an approved stop, or while no Files panel or request
 * has opened the interactive window. A request that has waited out its eight seconds is not delivered: its Front Door
 * handler is giving up on it.
 *
 * @param deps Store and clock.
 * @param identity The verified owner.
 * @param poll The poll body.
 * @param computer The computer record as the poll read it.
 * @returns The requests, at most four.
 */
export async function deliverLiveFileRequests(
	deps: Pick<LiveFileDependencies, "store" | "clock">,
	identity: OwnerIdentity,
	poll: OwnerPollRequest,
	computer: Computer,
): Promise<OwnerFileRequest[]> {
	const now = deps.clock.now();
	const windowOpen = computer.interactiveUntilAt !== undefined && computer.interactiveUntilAt.getTime() > now.getTime();
	if (
		poll.protocol_version < OWNER_FILE_REQUESTS_PROTOCOL_VERSION ||
		!FILE_SERVING_OWNER_STATES.has(poll.state) ||
		computer.ownerStopApprovedAt !== undefined ||
		!windowOpen
	) {
		return [];
	}
	const mine = (await deps.store.listLiveFileOperations(identity.tenantId, now)).filter(
		(operation) => operation.ownerId === identity.ownerId && operation.generation === identity.startGeneration,
	);
	const repeated = mine.filter((operation) => operation.status === "delivered" && operation.deliveredSequence === poll.sequence);
	const waitingMilliseconds = (operation: LiveFileOperation): number => now.getTime() - operation.queuedAt.getTime();
	const candidates = mine
		.filter((operation) => operation.status === "pending" && waitingMilliseconds(operation) < LIVE_FILE_WAIT_MILLISECONDS)
		.slice(0, Math.max(0, LIVE_FILE_MAX_REQUESTS_PER_POLL - repeated.length));
	const handed: LiveFileOperation[] = [...repeated];
	for (const candidate of candidates) {
		const delivered = await deps.store.deliverLiveFileOperation(identity.tenantId, candidate.operationId, {
			ownerId: identity.ownerId,
			generation: identity.startGeneration,
			sequence: poll.sequence,
			at: now,
		});
		if (delivered) handed.push(candidate);
	}
	return handed.filter((operation) => operation.request !== undefined).map((operation) => asOwnerRequest(operation, now));
}

/** What the result route decided. */
export type LiveFileResultDecision = { readonly kind: "recorded" } | { readonly kind: "closed" } | { readonly kind: "kind_mismatch" };

const sortedJson = (value: unknown): string =>
	JSON.stringify(value, (_key, nested: unknown) =>
		nested !== null && typeof nested === "object" && !Array.isArray(nested)
			? Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
			: nested,
	);

const REFUSED_OWNER_CODES: ReadonlySet<string> = new Set(["path_refused", "outside_workspace", "permission_denied"]);
const CONFLICT_OWNER_CODES: ReadonlySet<string> = new Set(["precondition_failed", "already_exists"]);

function auditFinishOf(outcome: LiveFileOutcome, audit: FileAuditRecord, finishedAt: Date): FileAuditFinish {
	if (outcome.status === "error") {
		return {
			outcome: CONFLICT_OWNER_CODES.has(outcome.code) ? "conflict" : REFUSED_OWNER_CODES.has(outcome.code) ? "refused" : "failed",
			finishedAt,
			errorCode: outcome.code,
		};
	}
	const { result } = outcome;
	const resolvedPath = result.kind === "move" ? undefined : result.kind === "stat" ? result.entry.path : result.resolved_path;
	const keptAs = result.kind === "write" || result.kind === "delete" ? result.kept_as : undefined;
	const beforeReported = result.kind === "write" || result.kind === "delete" ? (result.sha256_before ?? undefined) : undefined;
	const afterReported = result.kind === "write" ? result.sha256_after : undefined;
	const mismatch = afterReported !== undefined && audit.sha256After !== undefined && afterReported !== audit.sha256After;
	return {
		outcome: "ok",
		finishedAt,
		...(resolvedPath === undefined ? {} : { resolvedPath }),
		...(keptAs === undefined ? {} : { keptAs }),
		...(beforeReported === undefined ? {} : { sha256BeforeReported: beforeReported }),
		...(afterReported === undefined ? {} : { sha256AfterReported: afterReported }),
		...(result.kind === "delete" ? { removed: result.removed } : {}),
		...(mismatch ? { flags: ["integrity_mismatch"] } : {}),
	};
}

async function finishAudit(deps: Pick<LiveFileDependencies, "store" | "clock">, operation: LiveFileOperation, outcome: LiveFileOutcome): Promise<void> {
	if (operation.auditAtMilliseconds === undefined) return;
	const now = deps.clock.now();
	const audit = await deps.store.getFileAudit(operation.tenantId, operation.auditAtMilliseconds, operation.operationId, now);
	if (audit === null) return;
	await deps.store.finalizeFileAudit(operation.tenantId, operation.auditAtMilliseconds, operation.operationId, auditFinishOf(outcome, audit, now));
}

/**
 * Record the owner's answer to one request. Only the owner, generation and computer the request was queued for may answer,
 * once, and only while the request is delivered: an answer to a pending, abandoned, expired or unknown request is closed.
 * The same answer repeated is recorded again without changing anything (and finishes the audit record and the clean-up a
 * lost response left undone). The waiting handler's request item is deleted by that handler after it reads the answer; when
 * the handler gave up, the answer is not kept: the audit record is finished and the item deleted.
 *
 * @param deps Store and clock.
 * @param identity The verified owner.
 * @param body The answer.
 * @returns Recorded, closed, or a result whose kind is not the request's.
 */
export async function recordLiveFileResult(
	deps: Pick<LiveFileDependencies, "store" | "clock">,
	identity: OwnerIdentity,
	body: OwnerFileResultRequest,
): Promise<LiveFileResultDecision> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const now = deps.clock.now();
		const operation = await deps.store.getLiveFileOperation(identity.tenantId, body.operation_id, now);
		if (
			operation === null ||
			operation.ownerId !== identity.ownerId ||
			operation.generation !== identity.startGeneration ||
			operation.computerId !== identity.computerId
		) {
			return { kind: "closed" };
		}
		if (operation.status === "done") {
			if (operation.outcome === undefined || sortedJson(JSON.parse(operation.outcome)) !== sortedJson(body.outcome)) return { kind: "closed" };
			await finishAudit(deps, operation, body.outcome);
			if (operation.waiterGone === true) await deps.store.deleteLiveFileOperation(identity.tenantId, operation.operationId);
			return { kind: "recorded" };
		}
		if (operation.status !== "delivered") return { kind: "closed" };
		if (body.outcome.status === "ok" && body.outcome.result.kind !== operation.kind) return { kind: "kind_mismatch" };
		const completed = await deps.store.completeLiveFileOperation(identity.tenantId, operation.operationId, JSON.stringify(body.outcome), now);
		if (completed === null) continue;
		await finishAudit(deps, completed, body.outcome);
		if (completed.waiterGone === true) await deps.store.deleteLiveFileOperation(identity.tenantId, completed.operationId);
		return { kind: "recorded" };
	}
	return { kind: "closed" };
}

/** What a Files panel ping is answered with: whether the computer is live, starting or off, and how fast the owner polls. */
export type FilePanelWatchResult = {
	readonly state: "off" | "starting" | "live";
	readonly interactive_until: string | null;
	readonly poll_interval_ms: number | null;
};

/**
 * A Files panel is open (true) or closed (false). With a live owner able to serve files, the interactive window is set to
 * 45 seconds from now (open) or to now (closed); nothing is queued, no stop is vetoed, nothing is audited, and no
 * computer is started, so a forgotten panel does not keep the computer awake. The answer says whether the computer is live,
 * starting (an owner that is booting or hydrating, or an unexpired start lease) or off.
 *
 * @param deps Store and clock.
 * @param tenantId The organization.
 * @param open Whether the panel is open.
 * @returns The state, the end of the interactive window and the pace the owner is polled at.
 */
export async function watchFilePanel(
	deps: Pick<LiveFileDependencies, "store" | "clock" | "heartbeatTimeoutSeconds">,
	tenantId: string,
	open: boolean,
): Promise<FilePanelWatchResult> {
	const now = deps.clock.now();
	const computer = await deps.store.getComputer(tenantId);
	const worker = computer?.ownerId === undefined ? null : await deps.store.getWorker(tenantId, computer.ownerId);
	const chosen = liveFileSourceOf(computer, worker, now, deps.heartbeatTimeoutSeconds);
	if (computer !== null && worker !== null && chosen.source === "live") {
		const until = open ? new Date(now.getTime() + LIVE_FILE_INTERACTIVE_WINDOW_SECONDS * 1000) : now;
		await deps.store.touchInteractiveWindow(tenantId, computer.ownerId!, computer.ownerGeneration!, until);
		const lastPace = worker.pollPaceMilliseconds ?? OWNER_POLL_SLOW_MILLISECONDS;
		return {
			state: "live",
			interactive_until: open ? until.toISOString() : null,
			poll_interval_ms: open ? Math.min(lastPace, OWNER_POLL_INTERACTIVE_MILLISECONDS) : lastPace,
		};
	}
	const starting =
		computer !== null &&
		((worker !== null && liveOwnerOf(computer, worker, now, deps.heartbeatTimeoutSeconds) && (worker.pollState === "booting" || worker.pollState === "hydrating")) ||
			(computer.hostStartLeaseExpiresAt !== undefined && computer.hostStartLeaseExpiresAt.getTime() > now.getTime()));
	return { state: starting ? "starting" : "off", interactive_until: null, poll_interval_ms: null };
}

/** How the Front Door sleeps between looks at a request. A deployed Front Door sleeps for real; scenarios drive it by hand. */
export interface FileWaitPort {
	sleep(milliseconds: number): Promise<void>;
}

/** The sleep of a deployed Front Door. */
export const realFileWait: FileWaitPort = { sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) };

/** How a wait for the owner's answer ended. */
export type LiveFileWaitResult =
	| { readonly kind: "done"; readonly outcome: LiveFileOutcome }
	| { readonly kind: "abandoned" }
	| { readonly kind: "unknown" };

/** What a wait is for. */
export type LiveFileWaitTarget = {
	readonly tenantId: string;
	readonly operationId: string;
	readonly queuedAt: Date;
	/** A write the owner took is waited for 7 seconds more, because it may still land; a read gives up at once. */
	readonly graceForDelivered: boolean;
};

type LookResult = { readonly kind: "done"; readonly outcome: LiveFileOutcome } | { readonly kind: "gone" } | { readonly kind: "open" };

async function lookAtRequest(deps: Pick<LiveFileDependencies, "store" | "clock">, target: LiveFileWaitTarget): Promise<LookResult> {
	const operation = await deps.store.getLiveFileOperation(target.tenantId, target.operationId, deps.clock.now());
	if (operation === null) return { kind: "gone" };
	if (operation.status === "done" && operation.outcome !== undefined) {
		await deps.store.deleteLiveFileOperation(target.tenantId, target.operationId);
		return { kind: "done", outcome: liveFileOutcomeSchema.parse(JSON.parse(operation.outcome)) };
	}
	return operation.status === "abandoned" ? { kind: "gone" } : { kind: "open" };
}

/**
 * Wait for the owner's answer to a queued request: look at the request every 250 milliseconds for up to 8 seconds from the
 * moment it was queued. At the deadline exactly one of two things is true. Still pending: the request is abandoned in one
 * conditional write and will never be delivered. Already delivered: the owner has it. A read stops there and leaves the
 * request marked so that the result route deletes it when the late answer comes. A write waits 7 more seconds, because it
 * may still land, and is then reported as unknown. The answer is deleted once read, so the table does not keep content.
 *
 * @param deps Store and clock.
 * @param wait How to sleep between looks.
 * @param target The request and when it was queued.
 * @returns The answer; abandoned (the owner never took it and never will); or unknown (the owner took it and did not answer in time).
 */
export async function awaitLiveFileOutcome(
	deps: Pick<LiveFileDependencies, "store" | "clock">,
	wait: FileWaitPort,
	target: LiveFileWaitTarget,
): Promise<LiveFileWaitResult> {
	const deadline = target.queuedAt.getTime() + LIVE_FILE_WAIT_MILLISECONDS;
	for (;;) {
		const look = await lookAtRequest(deps, target);
		if (look.kind === "done") return look;
		if (look.kind === "gone") return { kind: "abandoned" };
		if (deps.clock.now().getTime() >= deadline) break;
		await wait.sleep(LIVE_FILE_RESULT_CHECK_MILLISECONDS);
	}
	const abandoned = await deps.store.abandonLiveFileOperation(target.tenantId, target.operationId, deps.clock.now());
	if (abandoned === "abandoned" || abandoned === "absent") return { kind: "abandoned" };
	if (abandoned === "done") {
		const look = await lookAtRequest(deps, target);
		return look.kind === "done" ? look : { kind: "abandoned" };
	}
	if (target.graceForDelivered) {
		const graceDeadline = deadline + LIVE_FILE_OUTCOME_GRACE_MILLISECONDS;
		for (;;) {
			await wait.sleep(LIVE_FILE_RESULT_CHECK_MILLISECONDS);
			const look = await lookAtRequest(deps, target);
			if (look.kind === "done") return look;
			if (look.kind === "gone") return { kind: "abandoned" };
			if (deps.clock.now().getTime() >= graceDeadline) break;
		}
	}
	if (await deps.store.markLiveFileOperationWaiterGone(target.tenantId, target.operationId)) return { kind: "unknown" };
	const last = await lookAtRequest(deps, target);
	return last.kind === "done" ? last : { kind: "unknown" };
}
