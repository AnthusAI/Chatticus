/**
 * What the Front Door does for a member's file request: choose between the running owner and the saved copy, carry a read or
 * a change to the owner and wait for the answer, or put a change into the edit overlay when no owner can take it. The route
 * parses and shapes; this decides. Delete, rename and new folder go through the same functions with their own request and
 * audit intent. See docs/LIVE_FILES_PROTOCOL.md sections 6.3, 7.2, 7.3 and 7.8.6.
 */

import {
	LIVE_FILE_MAX_OPEN_OPERATIONS,
	LIVE_FILE_RETRY_AFTER_MAX_MILLISECONDS,
	LIVE_FILE_RETRY_AFTER_MIN_MILLISECONDS,
	LIVE_FILE_WAIT_MILLISECONDS,
	type LiveFileErrorCode,
	type LiveFileFallbackReason,
	type LiveFileOutcome,
	type LiveFileOwnerErrorCode,
} from "@chatticus/host-protocol/live-files";
import { livePathHasGitSegment, normalizeLivePath } from "@chatticus/host-protocol/live-file-rules";
import { OWNER_FILE_REQUESTS_PROTOCOL_VERSION } from "@chatticus/host-protocol/supervisor";
import { OVERLAY_STOPPING_RETRY_AFTER_MILLISECONDS } from "@chatticus/host-protocol/edit-overlay";
import type { Computer } from "../store/codecs/computer.ts";
import type { Worker } from "../store/codecs/worker.ts";
import { liveOwnerOf } from "./computers.ts";
import { changeOverlay, type EditOverlayDependencies, type OverlayChangeOutcome, type OverlayMemberChange } from "./edit-overlay.ts";
import { beginMemberAudit, finishMemberAudit, memberAuditRecordOf, type MemberAuditIntent } from "./file-audit.ts";
import {
	awaitLiveFileOutcome,
	expectedPickupMilliseconds,
	liveFileSourceOf,
	newLiveFileOperationId,
	queueLiveFileRequest,
	type FileWaitPort,
	type LiveFileDependencies,
	type LiveFileRequestBody,
	type LiveFileSource,
} from "./live-files.ts";
import { MemberFileRefusal } from "./member-file-refusal.ts";

/** Everything a member file operation reads and writes. */
export type MemberFileDependencies = LiveFileDependencies & {
	/** The edit overlay; null where the deployment has none. */
	readonly overlay: EditOverlayDependencies | null;
	/** How the Front Door sleeps while it waits for the owner. */
	readonly wait: FileWaitPort;
	/** The deployment's own AWS account; an organization homed in another account is a customer-account organization. */
	readonly deploymentAwsAccountId: string | undefined;
};

/** The member a request is for: the organization, the user id from the principal, and the role in the organization. */
export type FileMember = {
	readonly tenantId: string;
	readonly userId: string;
	readonly role: "owner" | "member" | null;
};

/** What a request finds when it asks where to go. */
export type FileRoutingContext = {
	readonly computer: Computer | null;
	readonly worker: Worker | null;
	readonly source: LiveFileSource;
	/** The organization runs its computer in the customer's own AWS account, whose files can be read but not changed. */
	readonly customerAccount: boolean;
};

/** The largest wait for the owner's next poll that is still worth queueing a request for (L27). */
const LARGEST_WORTH_WAITING_MILLISECONDS = LIVE_FILE_WAIT_MILLISECONDS - 1000;

const clampRetryAfter = (milliseconds: number): number =>
	Math.min(LIVE_FILE_RETRY_AFTER_MAX_MILLISECONDS, Math.max(LIVE_FILE_RETRY_AFTER_MIN_MILLISECONDS, Math.ceil(milliseconds)));

/**
 * The computer, its owner, the source the contract's one predicate chooses, and whether the organization is homed in a
 * customer account.
 *
 * @param deps Store, clock and settings.
 * @param tenantId The organization.
 * @returns The context a read or a change routes by.
 */
export async function routingContextOf(deps: MemberFileDependencies, tenantId: string): Promise<FileRoutingContext> {
	const computer = await deps.store.getComputer(tenantId);
	const worker = computer?.ownerId === undefined ? null : await deps.store.getWorker(tenantId, computer.ownerId);
	const organization = await deps.store.getOrganization(tenantId);
	const homedIn = organization?.awsAccountId ?? null;
	return {
		computer,
		worker,
		source: liveFileSourceOf(computer, worker, deps.clock.now(), deps.heartbeatTimeoutSeconds),
		customerAccount: homedIn !== null && homedIn !== "" && deps.deploymentAwsAccountId !== undefined && homedIn !== deps.deploymentAwsAccountId,
	};
}

const CHANNEL_FALLBACK: Readonly<Partial<Record<LiveFileOwnerErrorCode, LiveFileFallbackReason>>> = {
	owner_stopping: "owner_stopping",
	expired: "owner_timeout",
	helper_timeout: "owner_timeout",
	helper_failed: "owner_error",
	io_error: "owner_error",
	owner_busy: "owner_error",
};

/**
 * The reason a read falls back to the saved copy for an error of the owner, or null when the error describes the file and
 * is an answer in its own right (a live "not found" is never replaced by a snapshot that may still hold the file, L28).
 */
export function fallbackReasonOfOwnerError(code: LiveFileOwnerErrorCode): LiveFileFallbackReason | null {
	return CHANNEL_FALLBACK[code] ?? null;
}

const SAME_CODE: ReadonlySet<LiveFileOwnerErrorCode> = new Set([
	"not_found",
	"not_a_file",
	"not_a_directory",
	"file_too_large",
	"already_exists",
	"precondition_failed",
	"parent_missing",
	"not_text",
	"directory_not_empty",
	"invalid_move",
	"too_many_entries",
]);

/**
 * The refusal a member is answered with for an error the owner returned (section 6.3). A failure of the channel on a change
 * is the member's to retry, or, for a helper that timed out, unknown: the change may have happened.
 *
 * @param error The owner's error.
 * @returns The refusal, with the hash a failed precondition found.
 */
export function refusalOfOwnerError(error: Extract<LiveFileOutcome, { status: "error" }>): MemberFileRefusal {
	if (SAME_CODE.has(error.code)) {
		return new MemberFileRefusal(error.code as LiveFileErrorCode, error.message, error.current_sha256 === undefined ? {} : { currentSha256: error.current_sha256 });
	}
	switch (error.code) {
		case "outside_workspace":
		case "permission_denied":
		case "path_refused":
			return new MemberFileRefusal("path_refused", error.message);
		case "owner_stopping":
			return new MemberFileRefusal("computer_stopping", "The computer is stopping; try again in a moment.", { retryAfterMs: OVERLAY_STOPPING_RETRY_AFTER_MILLISECONDS });
		case "owner_busy":
			return new MemberFileRefusal("too_busy", "The computer is busy with other file requests.");
		case "expired":
			return new MemberFileRefusal("owner_timeout", "The computer did not start the request in time; nothing was changed.");
		case "helper_timeout":
			return new MemberFileRefusal("outcome_unknown", "The computer did not answer in time. Read the file again to see whether the change was made.");
		default:
			return new MemberFileRefusal("owner_error", error.message);
	}
}

/** The result of a successful owner answer. */
export type LiveFileResult = Extract<LiveFileOutcome, { status: "ok" }>["result"];

/** How a read through the owner ended: answered (a result, or an error that describes the file), or to be answered from the saved copy. */
export type LiveReadOutcome =
	| { readonly kind: "answered"; readonly outcome: LiveFileOutcome }
	| { readonly kind: "fallback"; readonly reason: LiveFileFallbackReason; readonly retryAfterMs?: number };

/**
 * Carry a read to the running owner and wait for its answer, at most eight seconds.
 *
 * An owner that will not poll within 7 seconds is not waited for: the interactive window opens so that it polls quickly from
 * now on, and the read is answered from the saved copy with `owner_warming` and the time to ask again (L27). An owner that
 * stops between the judgement and the queueing, an owner that does not take the request, and one that takes it and does not
 * answer in time all fall back to the saved copy as well; the file errors of the owner are answers.
 *
 * @param deps Stores, clock and the wait.
 * @param ctx The context, whose source is live.
 * @param member Who asks.
 * @param request The read, list or stat the owner receives.
 * @param beginAudit Writes the audit record of this request just before it is queued, when it has one (a reveal), and names it.
 * @returns The answer or the reason to fall back.
 * @throws MemberFileRefusal `too_busy` when the computer has 16 open requests.
 */
export async function readThroughOwner(
	deps: MemberFileDependencies,
	ctx: FileRoutingContext,
	member: FileMember,
	request: LiveFileRequestBody,
	beginAudit?: () => Promise<{ readonly operationId: string; readonly atMilliseconds: number }>,
): Promise<LiveReadOutcome> {
	const { computer, worker } = ctx;
	if (computer === null || worker === null) return { kind: "fallback", reason: "owner_stopping" };
	const pickup = expectedPickupMilliseconds(worker, deps.clock.now());
	if (pickup > LARGEST_WORTH_WAITING_MILLISECONDS) {
		await openInteractiveWindow(deps, computer);
		return { kind: "fallback", reason: "owner_warming", retryAfterMs: clampRetryAfter(pickup) };
	}
	await refuseWhenTooBusy(deps, member.tenantId);
	const audit = beginAudit === undefined ? undefined : await beginAudit();
	const queued = await queueLiveFileRequest(deps, {
		computer,
		userId: member.userId,
		request,
		...(audit === undefined ? {} : { operationId: audit.operationId, auditAtMilliseconds: audit.atMilliseconds }),
	});
	if (queued.status === "owner_stopping") return { kind: "fallback", reason: "owner_stopping" };
	const waited = await awaitLiveFileOutcome(deps, deps.wait, {
		tenantId: member.tenantId,
		operationId: queued.operationId,
		queuedAt: queued.queuedAt,
		graceForDelivered: false,
	});
	if (waited.kind !== "done") return { kind: "fallback", reason: "owner_timeout" };
	if (waited.outcome.status === "error") {
		const reason = fallbackReasonOfOwnerError(waited.outcome.code);
		if (reason !== null) return { kind: "fallback", reason };
	}
	return { kind: "answered", outcome: waited.outcome };
}

async function openInteractiveWindow(deps: MemberFileDependencies, computer: Computer): Promise<void> {
	if (computer.ownerId === undefined || computer.ownerGeneration === undefined) return;
	const until = new Date(deps.clock.now().getTime() + 45 * 1000);
	await deps.store.touchInteractiveWindow(computer.tenantId, computer.ownerId, computer.ownerGeneration, until);
}

async function refuseWhenTooBusy(deps: MemberFileDependencies, tenantId: string): Promise<void> {
	if ((await deps.store.countOpenLiveFileOperations(tenantId, deps.clock.now())) >= LIVE_FILE_MAX_OPEN_OPERATIONS) {
		throw new MemberFileRefusal("too_busy", "The computer has too many file requests waiting; try again in a moment.");
	}
}

/** A change a member asks for, in the two forms it can take: for the owner and for the overlay, and what the audit says. */
export type MemberFileChange = {
	readonly audit: MemberAuditIntent;
	readonly liveRequest: LiveFileRequestBody;
	readonly overlayRequest: OverlayMemberChange;
	/** The paths the request names, for the `.git` refusal. */
	readonly paths: readonly string[];
};

/** What a change came to. */
export type MemberChangeResult =
	| { readonly source: "live"; readonly operationId: string; readonly result: LiveFileResult }
	| { readonly source: "overlay"; readonly outcome: OverlayChangeOutcome };

/**
 * Carry out a change a member asked for: through the owner when it can serve (the live path), into the overlay otherwise.
 * First failure wins (7.3 step 4): a customer-account organization cannot be edited; a running owner of protocol 1 would
 * never apply an overlay, so it blocks edits; a sealed overlay of an owner that is starting or stopping makes the change wait.
 * Everything else goes to the overlay and starts nothing.
 *
 * @param deps Stores, clock and the wait.
 * @param member Who asks; the user id is the one in the principal.
 * @param change The change in both forms.
 * @param ctx The routing context the caller already read, when it has.
 * @returns What the change came to, from the owner or from the overlay.
 * @throws MemberFileRefusal and EditOverlayRefusal, which the route answers with their code and status.
 */
export async function performMemberChange(
	deps: MemberFileDependencies,
	member: FileMember,
	change: MemberFileChange,
	ctx?: FileRoutingContext,
): Promise<MemberChangeResult> {
	const routing = ctx ?? (await routingContextOf(deps, member.tenantId));
	if (routing.source.source === "live") {
		if (change.paths.some((path) => livePathHasGitSegment(normalizeLivePath(path)))) {
			await auditRefusal(deps, member, routing, change, "live", "path_refused");
			throw new MemberFileRefusal("path_refused", "Changes inside a .git folder are refused.");
		}
		if (routing.customerAccount) throw editUnsupported();
		return changeThroughOwner(deps, routing, member, change);
	}
	if (routing.customerAccount) throw editUnsupported();
	const { computer, worker } = routing;
	if (computer !== null && liveOwnerOf(computer, worker, deps.clock.now(), deps.heartbeatTimeoutSeconds) && (computer.ownerProtocolVersion ?? 0) < OWNER_FILE_REQUESTS_PROTOCOL_VERSION) {
		throw new MemberFileRefusal("owner_too_old", "The computer is running an older version that cannot take edits yet; try again when it has restarted.");
	}
	if (deps.overlay === null) throw new MemberFileRefusal("snapshot_store_unavailable", "This deployment has no snapshot store.");
	const outcome = await changeOverlay(deps.overlay, { tenantId: member.tenantId, userId: member.userId, request: change.overlayRequest });
	return { source: "overlay", outcome };
}

const editUnsupported = (): MemberFileRefusal =>
	new MemberFileRefusal("edit_unsupported", "Files of a computer in your own AWS account can be read here but not changed yet.");

async function auditRefusal(
	deps: MemberFileDependencies,
	member: FileMember,
	ctx: FileRoutingContext,
	change: MemberFileChange,
	source: "live" | "overlay",
	code: LiveFileErrorCode,
): Promise<void> {
	if (ctx.computer === null) return;
	const record = memberAuditRecordOf(
		{ tenantId: member.tenantId, computerId: ctx.computer.computerId, userId: member.userId, operationId: newLiveFileOperationId(deps.ids), at: deps.clock.now(), source },
		change.audit,
		"refused",
		code,
	);
	try {
		await deps.store.putFileAudit(record);
	} catch {
		return;
	}
}

async function changeThroughOwner(deps: MemberFileDependencies, ctx: FileRoutingContext, member: FileMember, change: MemberFileChange): Promise<MemberChangeResult> {
	const { computer, worker } = ctx;
	if (computer === null || worker === null) throw new MemberFileRefusal("computer_stopping", "The computer is stopping; try again in a moment.", { retryAfterMs: OVERLAY_STOPPING_RETRY_AFTER_MILLISECONDS });
	await refuseWhenTooBusy(deps, member.tenantId);
	const pickup = expectedPickupMilliseconds(worker, deps.clock.now());
	if (pickup > LARGEST_WORTH_WAITING_MILLISECONDS) {
		await openInteractiveWindow(deps, computer);
		throw new MemberFileRefusal("owner_warming", "The computer is not ready to take the change yet; try again in a moment.", { retryAfterMs: clampRetryAfter(pickup) });
	}
	const at = deps.clock.now();
	const operationId = newLiveFileOperationId(deps.ids);
	const record = memberAuditRecordOf(
		{ tenantId: member.tenantId, computerId: computer.computerId, userId: member.userId, operationId, at, source: "live" },
		change.audit,
		"pending",
	);
	await beginMemberAudit(deps.store, record);
	await deps.store.markComputerDiskDirty(member.tenantId);
	const queued = await queueLiveFileRequest(deps, { computer, userId: member.userId, request: change.liveRequest, operationId, auditAtMilliseconds: at.getTime() });
	if (queued.status === "owner_stopping") {
		await finishMemberAudit(deps.store, record, { outcome: "failed", finishedAt: deps.clock.now(), errorCode: "owner_stopping" });
		throw new MemberFileRefusal("computer_stopping", "The computer is stopping; try again in a moment.", { retryAfterMs: OVERLAY_STOPPING_RETRY_AFTER_MILLISECONDS });
	}
	const waited = await awaitLiveFileOutcome(deps, deps.wait, {
		tenantId: member.tenantId,
		operationId,
		queuedAt: queued.queuedAt,
		graceForDelivered: true,
	});
	if (waited.kind === "abandoned") {
		await finishMemberAudit(deps.store, record, { outcome: "failed", finishedAt: deps.clock.now(), errorCode: "owner_timeout" });
		throw new MemberFileRefusal("owner_timeout", "The computer did not take the change in time; nothing was changed.");
	}
	if (waited.kind === "unknown") {
		throw new MemberFileRefusal("outcome_unknown", "The computer took the change but did not answer in time. Read the file again to see whether it was made.");
	}
	if (waited.outcome.status === "error") throw refusalOfOwnerError(waited.outcome);
	if (waited.outcome.result.kind !== change.liveRequest.kind) throw new MemberFileRefusal("owner_error", "The computer answered a different request.");
	return { source: "live", operationId, result: waited.outcome.result };
}
