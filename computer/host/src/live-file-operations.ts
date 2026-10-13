import { createHash } from "node:crypto";
import {
	LIVE_FILE_HELPER_TIMEOUT_MILLISECONDS,
	LIVE_FILE_LISTING_SCAN_MAX_NAMES,
	LIVE_FILE_MAX_CONCURRENT_HELPERS,
	LIVE_FILE_MAX_QUEUED_REQUESTS,
	LIVE_FILE_MEMORY_REFUSE_PERCENT,
	LIVE_FILE_OWNER_ERROR_CODES,
	LIVE_FILE_READ_MAX_FILE_BYTES,
	liveFileOutcomeSchema,
	type LiveFileOutcome,
	type LiveFileOwnerErrorCode,
	type OwnerFileRequest,
} from "@chatticus/host-protocol/live-files";
import { LIVE_WORKSPACE_ROOT, normalizeLivePath, utf8ByteLength } from "@chatticus/host-protocol/live-file-rules";
import { errorNameOf, type LogEmitter } from "../../../conversation/src/observability/log-line.ts";
import type { FileHelperLauncher, FileHelperRequest, FileHelperResponse } from "./live-file-helper-launcher.ts";
import type { SupervisorClock } from "./supervisor-ports.ts";

const KNOWN_REQUEST_MEMORY_MILLISECONDS = 60_000;
const POST_ATTEMPTS = 3;
const POST_RETRY_PAUSE_MILLISECONDS = 1000;
const PATH_HASH_HEX_CHARACTERS = 12;
const MESSAGE_MAX_CHARACTERS = 500;
const OWNER_ERROR_CODES: ReadonlySet<string> = new Set(LIVE_FILE_OWNER_ERROR_CODES);

/** Why a request was answered without the helper being started. */
export type LiveFileRefusal = "owner_stopping" | "owner_busy" | "expired";

/** Where the file runner gets its time, its helper, its memory reading and its answers posted. */
export type LiveFileOperationsOptions = {
	readonly launcher: FileHelperLauncher;
	/** Post the answer to the control plane. Resolves `recorded` or `closed` (the control plane no longer wants it); rejects on a network error or a 5xx so the runner tries again. */
	readonly postResult: (operationId: string, outcome: LiveFileOutcome) => Promise<"recorded" | "closed">;
	readonly clock: SupervisorClock;
	readonly log: LogEmitter;
	/** The real directory that plays `/workspace`. */
	readonly workspaceRoot: string;
	/** Percent of the container's memory in use; absent or undefined, none is known. */
	readonly memoryUsedPercent: () => number | undefined;
	/** Called once for every request the helper was started for, with the answer it produced. */
	readonly onFinished: (kind: OwnerFileRequest["kind"], outcome: LiveFileOutcome) => void;
};

type Entry = {
	readonly request: OwnerFileRequest;
	readonly receivedAtMilliseconds: number;
	state: "queued" | "running" | "finished";
	outcome: LiveFileOutcome | null;
	finishedAtMilliseconds: number;
	posted: boolean;
	posting: boolean;
};

/**
 * The real path under the workspace directory that a logical `/workspace/...` path names.
 *
 * @param workspaceRoot The real directory that plays `/workspace`, with no trailing slash.
 * @param livePath A lexically valid workspace path.
 * @returns The real path. A string operation only: nothing here touches the disk.
 */
export function realPathOfLivePath(workspaceRoot: string, livePath: string): string {
	return `${workspaceRoot}${normalizeLivePath(livePath).slice(LIVE_WORKSPACE_ROOT.length)}`;
}

/**
 * What the helper is asked for one request of the control plane. Every live request refuses `.git` and stays inside the
 * workspace; a read is a range of a file of at most 8 MiB; a recursive delete is the helper's `rmtree`, a plain delete its `unlink`.
 */
export function helperRequestOf(request: OwnerFileRequest, workspaceRoot: string): FileHelperRequest {
	const path = realPathOfLivePath(workspaceRoot, request.path);
	const base = { path, allowedRoots: [workspaceRoot], refuseGitSegments: true } as const;
	switch (request.kind) {
		case "list":
			return { ...base, operation: "list", maxEntries: request.max_entries, maxScan: LIVE_FILE_LISTING_SCAN_MAX_NAMES };
		case "stat":
			return { ...base, operation: "stat", tree: request.tree };
		case "read":
			return { ...base, operation: "read", range: { offset: request.offset, length: request.length, maxFileBytes: LIVE_FILE_READ_MAX_FILE_BYTES, mask: request.mask } };
		case "write":
			return { ...base, operation: "write", content: request.content, precondition: request.precondition };
		case "delete": {
			const seen = request.precondition.type === "if_match" ? { sha256: request.precondition.sha256 } : { treeSha256: request.precondition.tree_sha256 };
			return { ...base, operation: request.recursive ? "rmtree" : "unlink", recursive: request.recursive, ...seen };
		}
		case "move": {
			const seen = request.precondition.type === "if_match" ? { sha256: request.precondition.sha256 } : { treeSha256: request.precondition.tree_sha256 };
			return { ...base, operation: "rename", to: realPathOfLivePath(workspaceRoot, request.to), ...seen };
		}
		case "mkdir":
			return { ...base, operation: "mkdir" };
	}
}

const iso = (milliseconds: number): string => new Date(milliseconds).toISOString();

const errorOutcome = (code: LiveFileOwnerErrorCode, message: string, currentSha256?: string | null): LiveFileOutcome => ({
	status: "error",
	code,
	message: message.slice(0, MESSAGE_MAX_CHARACTERS),
	...(currentSha256 === undefined ? {} : { current_sha256: currentSha256 }),
});

const childPathOf = (directory: string, name: string): string => (directory === LIVE_WORKSPACE_ROOT ? `${LIVE_WORKSPACE_ROOT}/${name}` : `${directory}/${name}`);

/**
 * Turn the helper's answer into the outcome the protocol carries, validated against the schema. An answer that does not
 * match is `helper_failed`; the control plane never sees a shape it did not define.
 */
export function outcomeFromHelperResponse(request: OwnerFileRequest, response: FileHelperResponse): LiveFileOutcome {
	if (!response.ok) {
		const code: LiveFileOwnerErrorCode = OWNER_ERROR_CODES.has(response.code) ? (response.code as LiveFileOwnerErrorCode) : "io_error";
		return errorOutcome(code, response.message, response.currentSha256);
	}
	const resolvedPath = response.resolvedPath ?? request.path;
	let result: Record<string, unknown>;
	switch (request.kind) {
		case "list":
			result = {
				kind: "list",
				resolved_path: resolvedPath,
				truncated: response.truncated ?? false,
				entries: (response.entries ?? []).map((entry) => ({
					name: entry.name,
					path: childPathOf(resolvedPath, entry.name),
					kind: entry.kind,
					size: entry.size,
					mode: entry.mode,
					sha256: null,
					link_target: entry.linkTarget,
					modified_at: iso(entry.modifiedMs),
					overlay: "none",
					tree_sha256: null,
				})),
			};
			break;
		case "stat": {
			if (response.kind === undefined || response.kind === "other") return errorOutcome("not_a_file", "The path is neither a file, a folder nor a link.");
			result = {
				kind: "stat",
				entry: {
					name: resolvedPath.split("/").at(-1) ?? "",
					path: resolvedPath,
					kind: response.kind,
					size: response.kind === "file" ? (response.size ?? 0) : null,
					mode: response.mode ?? null,
					sha256: response.sha256 ?? null,
					link_target: response.linkTarget ?? null,
					modified_at: iso(response.mtimeMs ?? 0),
					overlay: "none",
					tree_sha256: response.treeSha256 ?? null,
				},
			};
			break;
		}
		case "read":
			result = {
				kind: "read",
				resolved_path: resolvedPath,
				size: response.size,
				sha256: response.sha256,
				mode: response.mode,
				modified_at: iso(response.modifiedMs ?? 0),
				encoding: response.encoding,
				binary: response.binary,
				offset: response.offset,
				length: response.length,
				content: response.content,
				truncated: response.truncated,
				masked: response.masked,
			};
			break;
		case "write":
			result = {
				kind: "write",
				resolved_path: resolvedPath,
				created: response.created,
				size: response.size,
				sha256_before: response.sha256Before ?? null,
				sha256_after: response.sha256,
				modified_at: iso(response.modifiedMs ?? 0),
				...(response.keptAs === undefined ? {} : { kept_as: response.keptAs }),
			};
			break;
		case "delete":
			result = {
				kind: "delete",
				resolved_path: resolvedPath,
				directory: response.directory,
				removed: response.removed,
				sha256_before: response.sha256Before ?? null,
				tree_sha256_before: response.treeSha256Before ?? null,
				...(response.keptAs === undefined ? {} : { kept_as: response.keptAs }),
			};
			break;
		case "move":
			result = { kind: "move", from: response.from, to: response.to, directory: response.directory, sha256: response.sha256 ?? null, tree_sha256: response.treeSha256 ?? null };
			break;
		case "mkdir":
			result = { kind: "mkdir", resolved_path: resolvedPath, created: response.created };
			break;
	}
	const parsed = liveFileOutcomeSchema.safeParse({ status: "ok", result });
	return parsed.success ? parsed.data : errorOutcome("helper_failed", "The file helper's answer did not match the protocol.");
}

function bytesOf(request: OwnerFileRequest, outcome: LiveFileOutcome): number {
	if (outcome.status !== "ok") return 0;
	if (outcome.result.kind === "read") return outcome.result.length;
	if (request.kind === "write") return utf8ByteLength(request.content);
	return 0;
}

/**
 * Carries out the file requests of the control plane for the supervisor, and nothing more: it turns each request into one
 * helper request, runs at most two helpers at a time, enforces the queue, the expiry and the memory bounds, validates the
 * answer, posts it, and logs one line that names no path and no content. It never opens a path itself; the helper, started
 * through the unprivileged launcher, is the only thing that does.
 *
 * It excludes the sweep of the shell user's processes and the stop sequence: {@link pause} waits for the helpers that run
 * and holds the queue, {@link stopAccepting} waits for the helpers and their answers and refuses the rest.
 */
export class LiveFileOperations {
	private readonly options: LiveFileOperationsOptions;
	private readonly entries = new Map<string, Entry>();
	private readonly queue: Entry[] = [];
	private readonly inFlight = new Set<Promise<void>>();
	private running = 0;
	private paused = false;
	private stopping = false;
	private idleWaiters: Array<() => void> = [];

	constructor(options: LiveFileOperationsOptions) {
		this.options = options;
	}

	/**
	 * Take the file requests of one poll answer.
	 *
	 * @param requests The requests; one already known is ignored, or its answer is posted again when the first post failed.
	 * @param refuseAllWith When set, every new request is answered with this code at once (the supervisor is not ready).
	 */
	accept(requests: readonly OwnerFileRequest[], refuseAllWith?: "owner_busy"): void {
		this.forgetOldEntries();
		for (const request of requests) {
			const known = this.entries.get(request.operation_id);
			if (known !== undefined) {
				if (known.state === "finished" && !known.posted && !known.posting && known.outcome !== null) this.track(this.post(known));
				continue;
			}
			const entry: Entry = {
				request,
				receivedAtMilliseconds: this.options.clock.nowMilliseconds(),
				state: "queued",
				outcome: null,
				finishedAtMilliseconds: 0,
				posted: false,
				posting: false,
			};
			this.entries.set(request.operation_id, entry);
			if (this.stopping) this.refuse(entry, "owner_stopping");
			else if (refuseAllWith !== undefined || this.queue.length >= LIVE_FILE_MAX_QUEUED_REQUESTS || this.memoryIsShort()) this.refuse(entry, "owner_busy");
			else this.queue.push(entry);
		}
		this.pump();
	}

	/** Hold the queue and wait until no helper runs. A paused runner queues new requests and does not answer them. */
	async pause(): Promise<void> {
		this.paused = true;
		await this.helpersIdle();
	}

	/** Let the queue run again after {@link pause}. */
	resume(): void {
		this.paused = false;
		this.pump();
	}

	/**
	 * Stop for good: answer every request that has not started, and every later one, `owner_stopping`, and wait until the
	 * helpers that run have finished and their answers are posted.
	 */
	async stopAccepting(): Promise<void> {
		this.stopping = true;
		for (const entry of this.queue.splice(0)) this.refuse(entry, "owner_stopping");
		await this.helpersIdle();
		while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
	}

	private memoryIsShort(): boolean {
		const used = this.options.memoryUsedPercent();
		return used !== undefined && used >= LIVE_FILE_MEMORY_REFUSE_PERCENT;
	}

	private forgetOldEntries(): void {
		const now = this.options.clock.nowMilliseconds();
		for (const [id, entry] of this.entries) {
			if (entry.state === "finished" && entry.posted && now - entry.finishedAtMilliseconds > KNOWN_REQUEST_MEMORY_MILLISECONDS) this.entries.delete(id);
		}
	}

	private helpersIdle(): Promise<void> {
		if (this.running === 0) return Promise.resolve();
		return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
	}

	private track(work: Promise<void>): void {
		this.inFlight.add(work);
		void work.finally(() => this.inFlight.delete(work));
	}

	private refuse(entry: Entry, reason: LiveFileRefusal): void {
		this.options.log("file_operation_refused", { reason, kind: entry.request.kind });
		this.finish(entry, errorOutcome(reason, reason === "expired" ? "The request could not start in time." : reason === "owner_busy" ? "The computer is busy." : "The computer is stopping."));
	}

	private finish(entry: Entry, outcome: LiveFileOutcome): void {
		entry.state = "finished";
		entry.outcome = outcome;
		entry.finishedAtMilliseconds = this.options.clock.nowMilliseconds();
		this.track(this.post(entry));
	}

	private pump(): void {
		while (!this.paused && this.running < LIVE_FILE_MAX_CONCURRENT_HELPERS && this.queue.length > 0) {
			const entry = this.queue.shift()!;
			if (this.options.clock.nowMilliseconds() - entry.receivedAtMilliseconds > entry.request.expires_in_ms) {
				this.refuse(entry, "expired");
				continue;
			}
			this.running += 1;
			entry.state = "running";
			this.track(this.runHelper(entry));
		}
	}

	private async runHelper(entry: Entry): Promise<void> {
		const startedAt = this.options.clock.nowMilliseconds();
		let response: FileHelperResponse;
		try {
			response = await this.options.launcher.run(helperRequestOf(entry.request, this.options.workspaceRoot), LIVE_FILE_HELPER_TIMEOUT_MILLISECONDS);
		} catch {
			response = { ok: false, code: "helper_failed", message: "The file helper failed." };
		}
		const outcome = outcomeFromHelperResponse(entry.request, response);
		const finishedAt = this.options.clock.nowMilliseconds();
		this.options.log("file_operation", {
			kind: entry.request.kind,
			bytes: bytesOf(entry.request, outcome),
			path_hash: createHash("sha256").update(entry.request.path).digest("hex").slice(0, PATH_HASH_HEX_CHARACTERS),
			source: "live",
			outcome: outcome.status === "ok" ? "ok" : outcome.code,
			duration_ms: finishedAt - startedAt,
			queue_ms: startedAt - entry.receivedAtMilliseconds,
		});
		this.running -= 1;
		this.finish(entry, outcome);
		this.options.onFinished(entry.request.kind, outcome);
		this.pump();
		if (this.running === 0) {
			const waiters = this.idleWaiters;
			this.idleWaiters = [];
			for (const wake of waiters) wake();
		}
	}

	private async post(entry: Entry): Promise<void> {
		if (entry.outcome === null || entry.posting) return;
		entry.posting = true;
		try {
			for (let attempt = 1; attempt <= POST_ATTEMPTS; attempt += 1) {
				try {
					await this.options.postResult(entry.request.operation_id, entry.outcome);
					entry.posted = true;
					return;
				} catch (error) {
					const status = typeof (error as { status?: unknown } | null)?.status === "number" ? (error as { status: number }).status : undefined;
					this.options.log("file_operation_post_failed", { status, error_name: status === undefined ? errorNameOf(error) : undefined, attempt });
					if (attempt < POST_ATTEMPTS) await this.options.clock.sleep(POST_RETRY_PAUSE_MILLISECONDS);
				}
			}
		} finally {
			entry.posting = false;
		}
	}
}
