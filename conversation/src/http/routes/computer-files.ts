import type { Context } from "hono";
import { MAX_CONTENT_RANGE_BYTES, SnapshotFileError, type SnapshotFileService } from "../../snapshot/files.ts";
import type { Computer } from "../../store/codecs/computer.ts";
import { computerForOrganization } from "../../domain/computers.ts";
import { ComputerNotFoundError } from "../errors.ts";
import { isRefusal, pathParameter, resolveUserPrincipal, type UserPrincipalDependencies } from "../user-principal.ts";

/** Everything the read-only file routes depend on. */
export interface ComputerFileRouteDependencies extends UserPrincipalDependencies {
	/** Reads the published snapshot; null when the deployment has no snapshot store, which the routes answer with 503. */
	files: SnapshotFileService | null;
}

function respondWithError(c: Context, error: SnapshotFileError): Response {
	c.header("X-Content-Type-Options", "nosniff");
	return c.json({ error: error.code, message: error.message }, error.status as 400);
}

function integerQuery(c: Context, name: string, fallback: number): number {
	const raw = c.req.query(name);
	if (raw === undefined || raw === "") return fallback;
	if (!/^\d{1,15}$/.test(raw)) throw new SnapshotFileError("invalid_range", `${name} must be a non-negative integer.`);
	return Number(raw);
}

async function organizationComputerWithSnapshot(c: Context, deps: ComputerFileRouteDependencies): Promise<Computer> {
	let computer: Computer;
	try {
		computer = await computerForOrganization(pathParameter(c, "tenant_id"), deps);
	} catch (error) {
		if (error instanceof ComputerNotFoundError) throw new SnapshotFileError("no_snapshot", "This computer has not published a snapshot.");
		throw error;
	}
	if (computer.snapshotUri === undefined) throw new SnapshotFileError("no_snapshot", "This computer has not published a snapshot.");
	return computer;
}

async function serve(
	c: Context,
	deps: ComputerFileRouteDependencies,
	produce: (files: SnapshotFileService, computer: Computer) => Promise<{ body: unknown; headers?: Record<string, string> }>,
): Promise<Response> {
	const principal = await resolveUserPrincipal(c, deps);
	if (isRefusal(principal)) {
		principal.headers.set("X-Content-Type-Options", "nosniff");
		return principal;
	}
	try {
		if (deps.files === null) {
			c.header("X-Content-Type-Options", "nosniff");
			return c.json({ error: "snapshot_store_unavailable", message: "This deployment has no snapshot store." }, 503);
		}
		const computer = await organizationComputerWithSnapshot(c, deps);
		const { body, headers } = await produce(deps.files, computer);
		c.header("X-Content-Type-Options", "nosniff");
		c.header("Cache-Control", "private, no-store");
		for (const [name, value] of Object.entries(headers ?? {})) c.header(name, value);
		return c.json(body as Record<string, unknown>, 200);
	} catch (error) {
		if (error instanceof SnapshotFileError) return respondWithError(c, error);
		throw error;
	}
}

/** GET /orgs/{tenant_id}/computer/files?path=: list one directory of the published snapshot. */
export async function listComputerFilesHandler(c: Context, deps: ComputerFileRouteDependencies): Promise<Response> {
	return serve(c, deps, async (files, computer) => ({
		body: await files.list(computer.tenantId, computer.computerId, c.req.query("path")),
	}));
}

/** GET /orgs/{tenant_id}/computer/files/stat?path=: one entry of the published snapshot. */
export async function statComputerFileHandler(c: Context, deps: ComputerFileRouteDependencies): Promise<Response> {
	return serve(c, deps, async (files, computer) => ({
		body: await files.stat(computer.tenantId, computer.computerId, c.req.query("path")),
	}));
}

/** GET /orgs/{tenant_id}/computer/files/content?path=&offset=&length=: a byte range of one file, hash-verified. */
export async function readComputerFileContentHandler(c: Context, deps: ComputerFileRouteDependencies): Promise<Response> {
	return serve(c, deps, async (files, computer) => {
		const offset = integerQuery(c, "offset", 0);
		const length = integerQuery(c, "length", MAX_CONTENT_RANGE_BYTES);
		const content = await files.content(computer.tenantId, computer.computerId, c.req.query("path"), { offset, length });
		return { body: content, headers: { ETag: `"${content.sha256}"` } };
	});
}
