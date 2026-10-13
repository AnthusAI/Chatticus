import { createHash } from "node:crypto";
import type { Context } from "hono";
import {
	LIVE_FILE_CONTENT_MAX_BYTES,
	LIVE_FILE_LISTING_MAX_ENTRIES,
	liveFileContentResponseSchema,
	liveFileListingResponseSchema,
	liveFileRevealBodySchema,
	liveFileStatResponseSchema,
	liveFileWatchBodySchema,
	liveFileWatchResponseSchema,
	liveFileWriteBodySchema,
	liveFileWriteResponseSchema,
	type LiveFileFallbackReason,
} from "@chatticus/host-protocol/live-files";
import { looksLikeSecretFile, utf8ByteLength } from "@chatticus/host-protocol/live-file-rules";
import type { Principal } from "../../auth/principal.ts";
import { EditOverlayRefusal, readOverlayBlobBytes, readOverlayState, type EditOverlayDependencies } from "../../domain/edit-overlay.ts";
import { beginMemberAudit, finishMemberAudit, memberAuditRecordOf } from "../../domain/file-audit.ts";
import { countFileRequest } from "../../domain/file-rate-limit.ts";
import { newLiveFileOperationId, watchFilePanel, type FileWaitPort } from "../../domain/live-files.ts";
import { MemberFileRefusal } from "../../domain/member-file-refusal.ts";
import { ComputerNotFoundError } from "../errors.ts";
import {
	performMemberChange,
	readThroughOwner,
	refusalOfOwnerError,
	routingContextOf,
	type FileMember,
	type FileRoutingContext,
	type LiveFileResult,
	type MemberChangeResult,
	type MemberFileChange,
	type MemberFileDependencies,
} from "../../domain/member-files.ts";
import {
	MAX_CONTENT_RANGE_BYTES,
	SnapshotFileError,
	indexPathOf,
	type FileContent,
	type OverlayReadView,
	type SnapshotFileService,
} from "../../snapshot/files.ts";
import type { LiveFileDependencies } from "../../domain/live-files.ts";
import type { FileAuditRecord, FileAuditSource } from "../../store/codecs/file-audit.ts";
import type { Clock, IdSource } from "../app.ts";
import { isRefusal, resolveUserPrincipal, type UserPrincipalDependencies } from "../user-principal.ts";
import { writePreconditionOf } from "./file-preconditions.ts";

/** Everything the member file routes depend on. */
export interface ComputerFileRouteDependencies extends UserPrincipalDependencies {
	/** Reads the published snapshot; null when the deployment has no snapshot store, which the routes answer with 503. */
	files: SnapshotFileService | null;
	/** The edit overlay; null where the deployment has none. */
	overlay: EditOverlayDependencies | null;
	clock: Clock;
	ids: IdSource;
	heartbeatTimeoutSeconds: number;
	deploymentAwsAccountId: string | undefined;
	/** How the Front Door sleeps while it waits for the owner. */
	wait: FileWaitPort;
}

/** The largest request body a save is read from: a body of 256 KiB of text may be JSON-escaped to six times its size. */
const WRITE_BODY_MAX_BYTES = LIVE_FILE_CONTENT_MAX_BYTES * 6 + 4096;

const sha256Of = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** The dependencies of the member file domain functions, taken from the route dependencies. */
export function memberFileDependencies(deps: ComputerFileRouteDependencies): MemberFileDependencies {
	return {
		store: deps.store,
		clock: deps.clock,
		ids: deps.ids,
		heartbeatTimeoutSeconds: deps.heartbeatTimeoutSeconds,
		overlay: deps.overlay,
		wait: deps.wait,
		deploymentAwsAccountId: deps.deploymentAwsAccountId,
	};
}

function liveFileDependencies(deps: ComputerFileRouteDependencies): LiveFileDependencies {
	return { store: deps.store, clock: deps.clock, ids: deps.ids, heartbeatTimeoutSeconds: deps.heartbeatTimeoutSeconds };
}

type ErrorBody = { error: string; message: string; current_sha256?: string | null; retry_after_ms?: number; kept_as?: string };

/** Answer a refusal of the file domain with its code, status and details; any other error is the caller's to throw. */
export function respondWithError(c: Context, error: unknown): Response {
	c.header("X-Content-Type-Options", "nosniff");
	c.header("Cache-Control", "private, no-store");
	if (error instanceof SnapshotFileError) return c.json({ error: error.code, message: error.message }, error.status as 400);
	if (error instanceof ComputerNotFoundError) return c.json({ error: "no_snapshot", message: "This computer has not published a snapshot." }, 404);
	if (error instanceof MemberFileRefusal) {
		const body: ErrorBody = { error: error.code, message: error.message };
		if (error.detail.currentSha256 !== undefined) body.current_sha256 = error.detail.currentSha256;
		if (error.detail.retryAfterMs !== undefined) body.retry_after_ms = error.detail.retryAfterMs;
		if (error.detail.keptAs !== undefined) body.kept_as = error.detail.keptAs;
		if (error.detail.retryAfterSeconds !== undefined) c.header("Retry-After", String(error.detail.retryAfterSeconds));
		return c.json(body, error.status as 400);
	}
	if (error instanceof EditOverlayRefusal) {
		const body: ErrorBody = { error: error.code, message: error.message };
		if (error.currentSha256 !== undefined) body.current_sha256 = error.currentSha256;
		if (error.retryAfterMs !== undefined) body.retry_after_ms = error.retryAfterMs;
		return c.json(body, error.status as 400);
	}
	throw error;
}

function integerQuery(c: Context, name: string, fallback: number): number {
	const raw = c.req.query(name);
	if (raw === undefined || raw === "") return fallback;
	if (!/^\d{1,15}$/.test(raw)) throw new SnapshotFileError("invalid_range", `${name} must be a non-negative integer.`);
	return Number(raw);
}

/** The path of a request, normalised; a path that is not under /workspace is `invalid_path` before anything else happens. */
export function requestedPathOf(raw: string | undefined): string {
	return `/${indexPathOf(raw)}`;
}

/** The authenticated caller of a file route and the member the domain functions act for. */
export type Caller ={ readonly principal: Principal; readonly member: FileMember };

function memberOf(principal: Principal): FileMember {
	return { tenantId: principal.tenantId, userId: principal.userId ?? principal.workerId ?? "caller", role: principal.role };
}

/** Resolve the caller, answering the principal's own refusal as it is. A change needs a member with a user id (L24). */
export async function resolveCaller(c: Context, deps: ComputerFileRouteDependencies, options: { requireUser: boolean }): Promise<Caller | Response> {
	const principal = await resolveUserPrincipal(c, deps);
	if (isRefusal(principal)) {
		principal.headers.set("X-Content-Type-Options", "nosniff");
		return principal;
	}
	if (options.requireUser && (principal.kind !== "user" || principal.userId === null)) {
		c.header("X-Content-Type-Options", "nosniff");
		return c.json({ detail: "a member is required" }, 403);
	}
	return { principal, member: memberOf(principal) };
}

/** The key a caller's requests are counted under: the member, or the organization for a caller that is not a user. */
export const rateKeyOf = (caller: Caller): string => caller.principal.userId ?? `tenant:${caller.principal.tenantId}`;

async function overlayReadViewOf(deps: ComputerFileRouteDependencies, ctx: FileRoutingContext): Promise<OverlayReadView | null> {
	const overlay = deps.overlay;
	if (overlay === null || ctx.customerAccount || ctx.computer === null) return null;
	const location = { tenantId: ctx.computer.tenantId, computerId: ctx.computer.computerId };
	const { index } = await readOverlayState(overlay, location);
	return { entries: index.entries, readBlob: (sha256) => readOverlayBlobBytes(overlay, location, sha256) };
}

type SnapshotProvenance = { stale: boolean; fallback_reason: LiveFileFallbackReason | null; retry_after_ms?: number };

function provenanceOf(ctx: FileRoutingContext, fallback: { reason: LiveFileFallbackReason; retryAfterMs?: number } | null): SnapshotProvenance {
	const reason = fallback?.reason ?? (ctx.source.source === "snapshot" ? ctx.source.reason : null);
	return {
		stale: reason !== null || ctx.source.source === "live",
		fallback_reason: reason,
		...(fallback?.retryAfterMs === undefined ? {} : { retry_after_ms: fallback.retryAfterMs }),
	};
}

/** Whether the person may be offered an editor for what a content response holds. */
function textFitsEditor(content: Pick<FileContent, "masked" | "revealed" | "binary" | "truncated" | "size" | "offset">): boolean {
	return (!content.masked || content.revealed) && !content.binary && !content.truncated && content.offset === 0 && content.size <= LIVE_FILE_CONTENT_MAX_BYTES;
}

type ServedFile = { body: Record<string, unknown>; headers?: Record<string, string> };

async function serveRead(
	c: Context,
	deps: ComputerFileRouteDependencies,
	produce: (caller: Caller, ctx: FileRoutingContext, requestedPath: string) => Promise<ServedFile>,
): Promise<Response> {
	const caller = await resolveCaller(c, deps, { requireUser: false });
	if (caller instanceof Response) return caller;
	try {
		c.header("X-Content-Type-Options", "nosniff");
		c.header("Cache-Control", "private, no-store");
		if (deps.files === null) return c.json({ error: "snapshot_store_unavailable", message: "This deployment has no snapshot store." }, 503);
		await countFileRequest(deps.store, rateKeyOf(caller), "read", deps.clock.now());
		const requestedPath = requestedPathOf(c.req.query("path"));
		const ctx = await routingContextOf(memberFileDependencies(deps), caller.member.tenantId);
		const { body, headers } = await produce(caller, ctx, requestedPath);
		for (const [name, value] of Object.entries(headers ?? {})) c.header(name, value);
		return c.json(body, 200);
	} catch (error) {
		return respondWithError(c, error);
	}
}

function snapshotComputerOf(ctx: FileRoutingContext) {
	if (ctx.computer === null) throw new SnapshotFileError("no_snapshot", "This computer has not published a snapshot.");
	return ctx.computer;
}

/** The clock's time as an ISO string, for the `as_of` of a response. */
export const nowIso =(deps: ComputerFileRouteDependencies): string => deps.clock.now().toISOString();

/** GET /orgs/{tenant_id}/computer/files?path=: list one directory, live when the owner can answer and from the saved copy otherwise. */
export async function listComputerFilesHandler(c: Context, deps: ComputerFileRouteDependencies): Promise<Response> {
	return serveRead(c, deps, async (caller, ctx, path) => {
		let fallback: { reason: LiveFileFallbackReason; retryAfterMs?: number } | null = null;
		if (ctx.source.source === "live") {
			const read = await readThroughOwner(memberFileDependencies(deps), ctx, caller.member, { kind: "list", path, max_entries: LIVE_FILE_LISTING_MAX_ENTRIES });
			if (read.kind === "answered") {
				if (read.outcome.status === "error") throw refusalOfOwnerError(read.outcome);
				const result = read.outcome.result;
				if (result.kind !== "list") throw new MemberFileRefusal("owner_error", "The computer answered a different request.");
				return {
					body: liveFileListingResponseSchema.parse({
						source: "live",
						as_of: nowIso(deps),
						stale: false,
						fallback_reason: null,
						path,
						truncated: result.truncated,
						entries: result.entries.map((entry) => ({ ...entry, overlay: "none" })),
					}),
				};
			}
			fallback = { reason: read.reason, ...(read.retryAfterMs === undefined ? {} : { retryAfterMs: read.retryAfterMs }) };
		}
		const computer = snapshotComputerOf(ctx);
		const listing = await deps.files!.list(computer.tenantId, computer.computerId, path, await overlayReadViewOf(deps, ctx));
		return { body: liveFileListingResponseSchema.parse({ ...listing, ...provenanceOf(ctx, fallback) }) };
	});
}

/** The hash a delete or a rename must send back for an entry: a folder's tree hash, a link's or a file's own hash; null when the answer carries none. */
function effectiveHashOfEntry(entry: { kind: string; sha256: string | null; tree_sha256: string | null }): string | null {
	return entry.kind === "directory" ? entry.tree_sha256 : entry.sha256;
}

function etagHeadersOf(hash: string | null): Record<string, string> {
	return hash === null ? { Vary: "Authorization" } : { ETag: `"${hash}"`, Vary: "Authorization" };
}

/**
 * GET /orgs/{tenant_id}/computer/files/stat?path=: one entry, as it is, without following a link. The `ETag` is the hash a
 * delete or a rename of the entry must give back: the tree hash of a folder, the link hash of a link, the content hash of a
 * file (a running computer does not hash a file for a stat, so a live file has none; its content response carries it).
 */
export async function statComputerFileHandler(c: Context, deps: ComputerFileRouteDependencies): Promise<Response> {
	return serveRead(c, deps, async (caller, ctx, path) => {
		let fallback: { reason: LiveFileFallbackReason; retryAfterMs?: number } | null = null;
		if (ctx.source.source === "live") {
			const read = await readThroughOwner(memberFileDependencies(deps), ctx, caller.member, { kind: "stat", path, tree: true });
			if (read.kind === "answered") {
				if (read.outcome.status === "error") throw refusalOfOwnerError(read.outcome);
				const result = read.outcome.result;
				if (result.kind !== "stat") throw new MemberFileRefusal("owner_error", "The computer answered a different request.");
				return {
					body: liveFileStatResponseSchema.parse({
						source: "live",
						as_of: nowIso(deps),
						stale: false,
						fallback_reason: null,
						entry: { ...result.entry, overlay: "none" },
					}),
					headers: etagHeadersOf(effectiveHashOfEntry(result.entry)),
				};
			}
			fallback = { reason: read.reason, ...(read.retryAfterMs === undefined ? {} : { retryAfterMs: read.retryAfterMs }) };
		}
		const computer = snapshotComputerOf(ctx);
		const stat = await deps.files!.stat(computer.tenantId, computer.computerId, path, await overlayReadViewOf(deps, ctx));
		return { body: liveFileStatResponseSchema.parse({ ...stat, ...provenanceOf(ctx, fallback) }), headers: etagHeadersOf(effectiveHashOfEntry(stat.entry)) };
	});
}

function liveContentBody(
	deps: ComputerFileRouteDependencies,
	result: Extract<LiveFileResult, { kind: "read" }>,
	requestedPath: string,
	reveal: boolean,
): Record<string, unknown> {
	const secret = !reveal && !result.masked && (looksLikeSecretFile(result.resolved_path) || looksLikeSecretFile(requestedPath));
	const masked = result.masked || secret;
	const shown = masked
		? { encoding: "utf8" as const, binary: false, length: 0, content: "", truncated: false }
		: { encoding: result.encoding, binary: result.binary, length: result.length, content: result.content, truncated: result.truncated };
	const body = {
		source: "live" as const,
		as_of: nowIso(deps),
		stale: false,
		fallback_reason: null,
		path: requestedPath,
		size: result.size,
		sha256: result.sha256,
		offset: result.offset,
		masked,
		revealed: reveal,
		modified_at: result.modified_at,
		overlay: "none" as const,
		...shown,
	};
	return liveFileContentResponseSchema.parse({ ...body, editable: textFitsEditor({ ...body }) });
}

function snapshotContentBody(
	ctx: FileRoutingContext,
	deps: ComputerFileRouteDependencies,
	content: FileContent,
	fallback: { reason: LiveFileFallbackReason; retryAfterMs?: number } | null,
	variant: "mine" | undefined,
): Record<string, unknown> {
	const provenance = provenanceOf(ctx, fallback);
	const writable = !provenance.stale && !ctx.customerAccount && deps.overlay !== null && variant === undefined;
	return liveFileContentResponseSchema.parse({
		...content,
		...provenance,
		editable: writable && textFitsEditor(content),
	});
}

/** GET /orgs/{tenant_id}/computer/files/content?path=&offset=&length=&variant=: a byte range of one file, hash-verified, with the hash of the whole file as its ETag. */
export async function readComputerFileContentHandler(c: Context, deps: ComputerFileRouteDependencies): Promise<Response> {
	return serveRead(c, deps, async (caller, ctx, path) => {
		const offset = integerQuery(c, "offset", 0);
		const length = integerQuery(c, "length", MAX_CONTENT_RANGE_BYTES);
		if (length > MAX_CONTENT_RANGE_BYTES) throw new SnapshotFileError("range_too_large", `A read returns at most ${MAX_CONTENT_RANGE_BYTES} bytes.`);
		const variantRaw = c.req.query("variant");
		if (variantRaw !== undefined && variantRaw !== "mine") throw new MemberFileRefusal("invalid_body", "The variant is mine, or absent.");
		const variant = variantRaw === "mine" ? ("mine" as const) : undefined;
		let fallback: { reason: LiveFileFallbackReason; retryAfterMs?: number } | null = null;
		if (ctx.source.source === "live" && variant === undefined) {
			const read = await readThroughOwner(memberFileDependencies(deps), ctx, caller.member, { kind: "read", path, offset, length: Math.max(length, 1), mask: true });
			if (read.kind === "answered") {
				if (read.outcome.status === "error") throw refusalOfOwnerError(read.outcome);
				const result = read.outcome.result;
				if (result.kind !== "read") throw new MemberFileRefusal("owner_error", "The computer answered a different request.");
				const body = liveContentBody(deps, result, path, false);
				return { body, headers: { ETag: `"${result.sha256}"`, Vary: "Authorization" } };
			}
			fallback = { reason: read.reason, ...(read.retryAfterMs === undefined ? {} : { retryAfterMs: read.retryAfterMs }) };
		}
		const computer = snapshotComputerOf(ctx);
		const content = await deps.files!.content(computer.tenantId, computer.computerId, path, { offset, length }, { overlay: await overlayReadViewOf(deps, ctx), ...(variant === undefined ? {} : { variant }) });
		return { body: snapshotContentBody(ctx, deps, content, fallback, variant), headers: { ETag: `"${content.sha256}"`, Vary: "Authorization" } };
	});
}

/** Read a JSON body of at most `maximumBytes` (by `Content-Length`); anything else is `invalid_body` or `content_too_large`. */
export async function readJsonBody(c: Context, maximumBytes: number): Promise<unknown> {
	const declared = Number(c.req.header("content-length") ?? "0");
	if (Number.isFinite(declared) && declared > maximumBytes) {
		throw new MemberFileRefusal("content_too_large", `A save carries at most ${LIVE_FILE_CONTENT_MAX_BYTES} bytes of text.`);
	}
	try {
		return JSON.parse(await c.req.text());
	} catch {
		throw new MemberFileRefusal("invalid_body", "The body must be JSON.");
	}
}

/**
 * PUT /orgs/{tenant_id}/computer/files/content?path=: save UTF-8 text with `If-Match` of the hash last seen, or create it with
 * `If-None-Match: *`. To the owner when it can serve, into the overlay otherwise.
 */
export async function writeComputerFileContentHandler(c: Context, deps: ComputerFileRouteDependencies): Promise<Response> {
	const caller = await resolveCaller(c, deps, { requireUser: true });
	if (caller instanceof Response) return caller;
	try {
		c.header("X-Content-Type-Options", "nosniff");
		c.header("Cache-Control", "private, no-store");
		await countFileRequest(deps.store, rateKeyOf(caller), "write", deps.clock.now());
		const precondition = writePreconditionOf(c.req.header("If-Match"), c.req.header("If-None-Match"));
		const raw = await readJsonBody(c, WRITE_BODY_MAX_BYTES);
		const claimed = (raw as { content?: unknown } | null)?.content;
		if (typeof claimed === "string" && utf8ByteLength(claimed) > LIVE_FILE_CONTENT_MAX_BYTES) {
			throw new MemberFileRefusal("content_too_large", `A save carries at most ${LIVE_FILE_CONTENT_MAX_BYTES} bytes of text.`);
		}
		const body = liveFileWriteBodySchema.safeParse(raw);
		if (!body.success) throw new MemberFileRefusal("invalid_body", body.error.issues.map((issue) => issue.message).join("; "));
		const path = requestedPathOf(c.req.query("path"));
		const bytes = Buffer.from(body.data.content, "utf8");
		const sha256After = sha256Of(bytes);
		const change: MemberFileChange = {
			audit: {
				operation: precondition.type === "if_none_match" ? "create" : "write",
				path,
				...(precondition.type === "if_match" ? { sha256Before: precondition.sha256 } : {}),
				sha256After,
				bytes: bytes.length,
			},
			liveRequest: { kind: "write", path, content: body.data.content, precondition },
			overlayRequest: { op: "put", path, content: body.data.content, precondition },
			paths: [path],
		};
		const result = await performMemberChange(memberFileDependencies(deps), caller.member, change);
		return respondToWrite(c, deps, result, sha256After, bytes.length, path);
	} catch (error) {
		return respondWithError(c, error);
	}
}

function respondToWrite(c: Context, deps: ComputerFileRouteDependencies, result: MemberChangeResult, sha256After: string, size: number, path: string): Response {
	if (result.source === "live") {
		if (result.result.kind !== "write") throw new MemberFileRefusal("owner_error", "The computer answered a different request.");
		const answer = result.result;
		c.header("ETag", `"${sha256After}"`);
		return c.json(
			liveFileWriteResponseSchema.parse({
				source: "live",
				as_of: nowIso(deps),
				path,
				created: answer.created,
				size,
				sha256: sha256After,
				previous_sha256: answer.sha256_before,
				modified_at: answer.modified_at,
				kept_as: answer.kept_as ?? null,
				backed_up: false,
			}),
			200,
		);
	}
	const outcome = result.outcome;
	const sha256 = outcome.sha256 ?? sha256After;
	c.header("ETag", `"${sha256}"`);
	return c.json(
		liveFileWriteResponseSchema.parse({
			source: "overlay",
			as_of: nowIso(deps),
			path,
			created: outcome.created,
			size: outcome.size ?? size,
			sha256,
			previous_sha256: outcome.previousSha256,
			modified_at: outcome.modifiedAt,
			kept_as: null,
			backed_up: true,
		}),
		200,
	);
}

/**
 * POST /orgs/{tenant_id}/computer/files/reveal: the content of a masked file, from the owner or from the saved copy with the
 * overlay merged. The record of the reveal is written first; when it cannot be written nothing is revealed.
 */
export async function revealComputerFileHandler(c: Context, deps: ComputerFileRouteDependencies): Promise<Response> {
	const caller = await resolveCaller(c, deps, { requireUser: true });
	if (caller instanceof Response) return caller;
	try {
		c.header("X-Content-Type-Options", "nosniff");
		c.header("Cache-Control", "private, no-store");
		if (deps.files === null) return c.json({ error: "snapshot_store_unavailable", message: "This deployment has no snapshot store." }, 503);
		await countFileRequest(deps.store, rateKeyOf(caller), "reveal", deps.clock.now());
		const parsed = liveFileRevealBodySchema.safeParse(await readJsonBody(c, 4096));
		if (!parsed.success) throw new MemberFileRefusal("invalid_body", parsed.error.issues.map((issue) => issue.message).join("; "));
		const path = requestedPathOf(parsed.data.path);
		const offset = parsed.data.offset ?? 0;
		const length = parsed.data.length ?? MAX_CONTENT_RANGE_BYTES;
		const member = caller.member;
		const mdeps = memberFileDependencies(deps);
		const ctx = await routingContextOf(mdeps, member.tenantId);
		const computer = snapshotComputerOf(ctx);
		let record: FileAuditRecord | null = null;
		const beginRecord = async (source: FileAuditSource): Promise<{ operationId: string; atMilliseconds: number }> => {
			const begun = memberAuditRecordOf(
				{ tenantId: member.tenantId, computerId: computer.computerId, userId: member.userId, operationId: newLiveFileOperationId(deps.ids), at: deps.clock.now(), source },
				{ operation: "reveal", path },
				"pending",
			);
			await beginMemberAudit(deps.store, begun);
			record = begun;
			return { operationId: begun.operationId, atMilliseconds: begun.at.getTime() };
		};
		let fallback: { reason: LiveFileFallbackReason; retryAfterMs?: number } | null = null;
		if (ctx.source.source === "live") {
			const read = await readThroughOwner(mdeps, ctx, member, { kind: "read", path, offset, length, mask: false }, () => beginRecord("live"));
			if (read.kind === "answered") {
				if (read.outcome.status === "error") throw refusalOfOwnerError(read.outcome);
				const result = read.outcome.result;
				if (result.kind !== "read") throw new MemberFileRefusal("owner_error", "The computer answered a different request.");
				c.header("ETag", `"${result.sha256}"`);
				return c.json(liveContentBody(deps, result, path, true), 200);
			}
			fallback = { reason: read.reason, ...(read.retryAfterMs === undefined ? {} : { retryAfterMs: read.retryAfterMs }) };
		}
		const view = await overlayReadViewOf(deps, ctx);
		const origin = await deps.files.originOf(computer.tenantId, computer.computerId, path, view);
		if (record === null) await beginRecord(origin);
		const begun = record as FileAuditRecord | null;
		try {
			const content = await deps.files.content(computer.tenantId, computer.computerId, path, { offset, length }, { overlay: view, reveal: true });
			if (begun !== null) await finishMemberAudit(deps.store, begun, { outcome: "ok", finishedAt: deps.clock.now() });
			c.header("ETag", `"${content.sha256}"`);
			return c.json(snapshotContentBody(ctx, deps, content, fallback, undefined), 200);
		} catch (error) {
			if (begun !== null) {
				await finishMemberAudit(deps.store, begun, { outcome: "failed", finishedAt: deps.clock.now(), errorCode: error instanceof SnapshotFileError ? error.code : "failed" });
			}
			throw error;
		}
	} catch (error) {
		return respondWithError(c, error);
	}
}

/**
 * POST /orgs/{tenant_id}/computer/files/watch: the Files panel is open or closed. It makes a running owner poll quickly for a
 * short while and starts nothing; a forgotten panel does not keep the computer awake.
 */
export async function watchComputerFilesHandler(c: Context, deps: ComputerFileRouteDependencies): Promise<Response> {
	const caller = await resolveCaller(c, deps, { requireUser: true });
	if (caller instanceof Response) return caller;
	try {
		c.header("X-Content-Type-Options", "nosniff");
		c.header("Cache-Control", "private, no-store");
		await countFileRequest(deps.store, rateKeyOf(caller), "watch", deps.clock.now());
		const parsed = liveFileWatchBodySchema.safeParse(await readJsonBody(c, 1024));
		if (!parsed.success) throw new MemberFileRefusal("invalid_body", parsed.error.issues.map((issue) => issue.message).join("; "));
		const state = await watchFilePanel(liveFileDependencies(deps), caller.member.tenantId, parsed.data.open);
		return c.json(liveFileWatchResponseSchema.parse(state), 200);
	} catch (error) {
		return respondWithError(c, error);
	}
}
