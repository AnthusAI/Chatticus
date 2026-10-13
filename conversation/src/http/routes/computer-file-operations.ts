import type { Context } from "hono";
import {
	liveFileDeleteResponseSchema,
	liveFileMkdirBodySchema,
	liveFileMkdirResponseSchema,
	liveFileMoveBodySchema,
	liveFileMoveResponseSchema,
} from "@chatticus/host-protocol/live-files";
import { LIVE_WORKSPACE_ROOT } from "@chatticus/host-protocol/live-file-rules";
import { countFileRequest } from "../../domain/file-rate-limit.ts";
import { MemberFileRefusal } from "../../domain/member-file-refusal.ts";
import { performMemberChange, routingContextOf, type MemberChangeResult, type MemberFileChange } from "../../domain/member-files.ts";
import {
	memberFileDependencies,
	nowIso,
	rateKeyOf,
	readJsonBody,
	requestedPathOf,
	type Caller,
	resolveCaller,
	respondWithError,
	type ComputerFileRouteDependencies,
} from "./computer-files.ts";
import { recursiveFlagOf, removePreconditionOf } from "./file-preconditions.ts";

/** The largest body of a rename or a new folder: two paths. */
const OPERATION_BODY_MAX_BYTES = 8192;

function refuseWorkspaceRoot(...paths: readonly string[]): void {
	if (paths.includes(LIVE_WORKSPACE_ROOT)) throw new MemberFileRefusal("path_refused", "The workspace folder itself cannot be deleted or renamed.");
}

/** The path a body names in `field`, normalised and checked before the body's shape is, so a bad path is `invalid_path`. */
function bodyPathOf(raw: unknown, field: string): string | undefined {
	const named = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)[field] : undefined;
	return typeof named === "string" ? requestedPathOf(named) : undefined;
}

async function runChange(deps: ComputerFileRouteDependencies, caller: Caller, change: MemberFileChange): Promise<MemberChangeResult> {
	const mdeps = memberFileDependencies(deps);
	const ctx = await routingContextOf(mdeps, caller.member.tenantId);
	return performMemberChange(mdeps, caller.member, change, ctx);
}

/**
 * DELETE /orgs/{tenant_id}/computer/files?path=&recursive=: delete a file, a link or an empty folder, with `If-Match` of the hash
 * the person last saw (the folder's is its tree hash). A folder with things in it needs `recursive=true` and the organization
 * owner role. To the owner when it can serve, into the overlay otherwise.
 */
export async function deleteComputerFileHandler(c: Context, deps: ComputerFileRouteDependencies): Promise<Response> {
	const caller = await resolveCaller(c, deps, { requireUser: true });
	if (caller instanceof Response) return caller;
	try {
		c.header("X-Content-Type-Options", "nosniff");
		c.header("Cache-Control", "private, no-store");
		await countFileRequest(deps.store, rateKeyOf(caller), "write", deps.clock.now());
		const seen = removePreconditionOf(c.req.header("If-Match"));
		const recursive = recursiveFlagOf(c.req.query("recursive"));
		const path = requestedPathOf(c.req.query("path"));
		refuseWorkspaceRoot(path);
		const change: MemberFileChange = {
			audit: recursive ? { operation: "delete", path, recursive, treeSha256Before: seen } : { operation: "delete", path, recursive, sha256Before: seen },
			liveRequest: { kind: "delete", path, recursive, precondition: { type: "if_match", sha256: seen } },
			overlayRequest: { op: "delete", path, recursive, ownerRole: caller.member.role === "owner", ifMatchSha256: seen },
			paths: [path],
			ownerRoleRequired: recursive,
		};
		const result = await runChange(deps, caller, change);
		if (result.source === "live") {
			if (result.result.kind !== "delete") throw new MemberFileRefusal("owner_error", "The computer answered a different request.");
			const answer = result.result;
			return c.json(
				liveFileDeleteResponseSchema.parse({
					source: "live",
					as_of: nowIso(deps),
					path,
					directory: answer.directory,
					removed: answer.removed,
					kept_as: answer.kept_as ?? null,
					backed_up: false,
				}),
				200,
			);
		}
		return c.json(
			liveFileDeleteResponseSchema.parse({
				source: "overlay",
				as_of: nowIso(deps),
				path,
				directory: result.outcome.directory,
				removed: result.outcome.removed,
				kept_as: null,
				backed_up: true,
			}),
			200,
		);
	} catch (error) {
		return respondWithError(c, error);
	}
}

/**
 * POST /orgs/{tenant_id}/computer/files/move: rename a file, a link or a folder, with `If-Match` of the hash of `from` the person
 * last saw. A rename never replaces an existing path.
 */
export async function moveComputerFileHandler(c: Context, deps: ComputerFileRouteDependencies): Promise<Response> {
	const caller = await resolveCaller(c, deps, { requireUser: true });
	if (caller instanceof Response) return caller;
	try {
		c.header("X-Content-Type-Options", "nosniff");
		c.header("Cache-Control", "private, no-store");
		await countFileRequest(deps.store, rateKeyOf(caller), "write", deps.clock.now());
		const seen = removePreconditionOf(c.req.header("If-Match"));
		const raw = await readJsonBody(c, OPERATION_BODY_MAX_BYTES);
		const from = bodyPathOf(raw, "from");
		const to = bodyPathOf(raw, "to");
		const body = liveFileMoveBodySchema.safeParse(raw);
		if (!body.success || from === undefined || to === undefined) {
			throw new MemberFileRefusal("invalid_body", body.success ? "from and to are required." : body.error.issues.map((issue) => issue.message).join("; "));
		}
		refuseWorkspaceRoot(from, to);
		const change: MemberFileChange = {
			audit: { operation: "move", path: from, toPath: to, sha256Before: seen },
			liveRequest: { kind: "move", path: from, to, precondition: { type: "if_match", sha256: seen } },
			overlayRequest: { op: "move", from, to, ifMatchSha256: seen },
			paths: [from, to],
		};
		const result = await runChange(deps, caller, change);
		if (result.source === "live") {
			if (result.result.kind !== "move") throw new MemberFileRefusal("owner_error", "The computer answered a different request.");
			const answer = result.result;
			return c.json(
				liveFileMoveResponseSchema.parse({
					source: "live",
					as_of: nowIso(deps),
					from: answer.from,
					to: answer.to,
					directory: answer.directory,
					sha256: answer.sha256,
					tree_sha256: answer.tree_sha256,
					backed_up: false,
				}),
				200,
			);
		}
		const outcome = result.outcome;
		return c.json(
			liveFileMoveResponseSchema.parse({
				source: "overlay",
				as_of: nowIso(deps),
				from,
				to,
				directory: outcome.directory,
				sha256: outcome.directory ? null : outcome.sha256,
				tree_sha256: outcome.directory ? outcome.previousSha256 : null,
				backed_up: true,
			}),
			200,
		);
	} catch (error) {
		return respondWithError(c, error);
	}
}

/** POST /orgs/{tenant_id}/computer/files/directories: create a folder. Creating one that is already there is 200 `created: false`; a file or a link in the way is 409. */
export async function makeComputerFolderHandler(c: Context, deps: ComputerFileRouteDependencies): Promise<Response> {
	const caller = await resolveCaller(c, deps, { requireUser: true });
	if (caller instanceof Response) return caller;
	try {
		c.header("X-Content-Type-Options", "nosniff");
		c.header("Cache-Control", "private, no-store");
		await countFileRequest(deps.store, rateKeyOf(caller), "write", deps.clock.now());
		const raw = await readJsonBody(c, OPERATION_BODY_MAX_BYTES);
		const path = bodyPathOf(raw, "path");
		const body = liveFileMkdirBodySchema.safeParse(raw);
		if (!body.success || path === undefined) {
			throw new MemberFileRefusal("invalid_body", body.success ? "path is required." : body.error.issues.map((issue) => issue.message).join("; "));
		}
		const change: MemberFileChange = {
			audit: { operation: "mkdir", path },
			liveRequest: { kind: "mkdir", path },
			overlayRequest: { op: "mkdir", path },
			paths: [path],
		};
		const result = await runChange(deps, caller, change);
		if (result.source === "live") {
			if (result.result.kind !== "mkdir") throw new MemberFileRefusal("owner_error", "The computer answered a different request.");
			return c.json(liveFileMkdirResponseSchema.parse({ source: "live", as_of: nowIso(deps), path, created: result.result.created, backed_up: false }), 200);
		}
		return c.json(liveFileMkdirResponseSchema.parse({ source: "overlay", as_of: nowIso(deps), path, created: result.outcome.created, backed_up: true }), 200);
	} catch (error) {
		return respondWithError(c, error);
	}
}
