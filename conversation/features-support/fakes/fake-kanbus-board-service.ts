import { createHash, createHmac, randomUUID } from "node:crypto";
import type { KanbusFetch } from "@kanbus/api-client";

/**
 * The published behavior of the Kanbus board service, in process, named for what it models: docs/BOT_BOARDS.md section 4
 * and the service README of Kanbus (`services/kanbus-api/README.md`). It implements only what the scenarios need and
 * refuses like the documented service wherever the scenarios do not need more.
 *
 * Modeled: create conditional on absence of the board configuration; update, comment and delete with the expected
 * revision (a stale one is 409 `revision_conflict`, a missing one 428); a required UUID `X-Operation-Id` that replays the
 * same request and rejects a different one (409 `operation_conflict`); 403 for a principal without a grant and 404 for an
 * unknown board; the actor header required on every request of a delegating principal and refused for any other; the
 * relation codes of parent and dependency writes; the Kanbus default configuration with its workflows; a card is closed
 * if and only if it has a closing time; the catalog lag (`catalog_pending`); board archive and restore.
 */
export const FAKE_KANBUS_MODELS_PUBLISHED_BEHAVIOR = "docs/BOT_BOARDS.md section 4";

const DEFAULT_WORKFLOW: Record<string, string[]> = {
	backlog: ["open", "closed"],
	open: ["in_progress", "closed", "backlog"],
	in_progress: ["open", "blocked", "closed"],
	blocked: ["in_progress", "closed"],
	closed: ["open"],
};

const EPIC_WORKFLOW: Record<string, string[]> = {
	open: ["in_progress", "closed"],
	in_progress: ["open", "closed"],
	closed: ["open"],
};

const HIERARCHY = ["initiative", "epic", "task", "sub-task"];
const EXTRA_TYPES = ["bug", "story", "chore"];
const STATUSES = ["backlog", "open", "in_progress", "blocked", "closed"];
const PRIORITIES = [0, 1, 2, 3, 4];
const DEFAULT_PRIORITY = 2;
const RETENTION_DAYS = 30;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR_PATTERN = /^[a-z0-9-]+:[a-z0-9-]+:[A-Za-z0-9\-_.]{1,128}$/;
const SCOPE_NAME_PATTERN = /^[a-z0-9][a-z0-9\-_.]*$/;
const CREATE_FIELDS = new Set(["title", "type", "status", "description", "priority", "assignee", "parent", "labels", "custom", "dependencies"]);
const PATCH_FIELDS = CREATE_FIELDS;

/** What a service principal may do, as `KANBUS_SERVICE_PRINCIPALS` configures it. */
export type FakePrincipalGrants = {
	/** The secret key the role signs with; the model verifies every signature against it. */
	readonly secretAccessKey: string;
	readonly provision: boolean;
	readonly delegateActor: boolean;
	readonly tenants: "*" | readonly string[];
};

/** One request the fake received, as the tests inspect it. */
export type RecordedBoardRequest = {
	readonly method: string;
	readonly path: string;
	readonly accessKeyId: string | null;
	readonly actor: string | null;
	readonly operationId: string | null;
	readonly ifMatch: string | null;
	readonly bodyText: string;
	readonly status: number;
};

type StoredIssue = { issue: Record<string, any>; revision: number; indexed: boolean; writes: number };
type Receipt = { fingerprint: string; status: number; body: unknown };
type Board = {
	configured: boolean;
	issues: Map<string, StoredIssue>;
	receipts: Map<string, Receipt>;
	archivedAt: Date | null;
	purgeAfter: Date | null;
};

function assert_configured(board: Board | undefined): void {
	if (board === undefined || !board.configured) throw new Error("The board is not provisioned");
}

class ServiceError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function levelOf(type: string): number {
	const index = HIERARCHY.indexOf(type);
	return index >= 0 ? index : HIERARCHY.indexOf("task");
}

function rfc3986(value: string): string {
	return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
	return createHmac("sha256", key).update(value).digest();
}

function isoMilliseconds(date: Date): string {
	return date.toISOString();
}

/** The Kanbus board service as an in-process fetch: hand `fetch` to the real client. */
export class FakeKanbusBoardService {
	readonly requests: RecordedBoardRequest[] = [];
	readonly boards = new Map<string, Board>();
	private readonly principals = new Map<string, FakePrincipalGrants>();
	private readonly now: () => Date;
	private unreachable = false;
	private cannotConfirmWrites = false;
	private loseNextWriteAnswer = false;
	private lagging = false;
	private failNextUpdateToStatus: string | null = null;

	constructor(now: () => Date) {
		this.now = now;
	}

	readonly fetch: KanbusFetch = async (input, init = {}) => {
		if (this.unreachable) throw new TypeError("fetch failed");
		const url = new URL(input);
		const method = (init.method ?? "GET").toUpperCase();
		const headers = new Headers(init.headers);
		const bodyText = typeof init.body === "string" ? init.body : "";
		const accessKeyId = /Credential=([^/]+)\//.exec(headers.get("authorization") ?? "")?.[1] ?? null;
		const record: { -readonly [K in keyof RecordedBoardRequest]: RecordedBoardRequest[K] } = {
			method,
			path: `${url.pathname}${url.search}`,
			accessKeyId,
			actor: headers.get("x-kanbus-actor"),
			operationId: headers.get("x-operation-id"),
			ifMatch: headers.get("if-match"),
			bodyText,
			status: 0,
		};
		this.requests.push(record);
		let response: Response;
		try {
			response = await this.handle(method, url, headers, bodyText, accessKeyId);
		} catch (error) {
			if (!(error instanceof ServiceError)) throw error;
			response = json(error.status, { error: error.code, message: error.message });
		}
		record.status = response.status;
		if (this.loseNextWriteAnswer && method !== "GET" && response.ok) {
			this.loseNextWriteAnswer = false;
			throw new TypeError("fetch failed");
		}
		return response;
	};

	/** Allow a role's access key to call the service. */
	registerPrincipal(accessKeyId: string, grants: FakePrincipalGrants): void {
		this.principals.set(accessKeyId, grants);
	}

	/** Every request fails as an unreachable host would. */
	setUnreachable(value: boolean): void {
		this.unreachable = value;
	}

	/** Every write is answered 503 and stores nothing, so no write can be confirmed. */
	setCannotConfirmWrites(value: boolean): void {
		this.cannotConfirmWrites = value;
	}

	/** The next successful write is stored but its answer is lost. */
	loseAnswerOfNextWrite(): void {
		this.loseNextWriteAnswer = true;
	}

	/** The next update that sets this status is answered 503 and stores nothing. */
	failNextUpdateTo(status: string): void {
		this.failNextUpdateToStatus = status;
	}

	/** While lagging, writes answer `catalog_pending` and new cards stay out of the listing. */
	setCatalogLagging(value: boolean): void {
		this.lagging = value;
		if (!value) for (const board of this.boards.values()) for (const stored of board.issues.values()) stored.indexed = true;
	}

	/** Advance time-based state of archived boards: remove those past their purge date, as the Kanbus sweeper does. */
	sweep(): void {
		for (const [key, board] of this.boards) {
			if (board.archivedAt !== null && board.purgeAfter !== null && board.purgeAfter <= this.now()) this.boards.delete(key);
		}
	}

	/** The configuration the board was provisioned with, for assertions. */
	configurationOf(tenant: string, project: string): Record<string, any> {
		assert_configured(this.boards.get(`${tenant}/${project}`));
		return this.configuration("service");
	}

	/** The stored card, for assertions. */
	peek(tenant: string, project: string, id: string): { issue: Record<string, any>; revision: string; writes: number } | null {
		const stored = this.boards.get(`${tenant}/${project}`)?.issues.get(id);
		return stored === undefined ? null : { issue: structuredClone(stored.issue), revision: this.revisionLabel(stored.revision), writes: stored.writes };
	}

	/** The stored cards of one board, for assertions. */
	cardsOf(tenant: string, project: string): Record<string, any>[] {
		return [...(this.boards.get(`${tenant}/${project}`)?.issues.values() ?? [])].map((stored) => structuredClone(stored.issue));
	}

	/** Write a field onto a stored card as another Kanbus tool would, without a revision check. */
	writeFieldBehindTheApi(tenant: string, project: string, id: string, field: string, value: unknown): void {
		const stored = this.boards.get(`${tenant}/${project}`)?.issues.get(id);
		if (stored === undefined) throw new Error(`No card ${id}`);
		stored.issue[field] = value;
	}

	private revisionLabel(revision: number): string {
		return `revision-${revision}`;
	}

	private principalOf(accessKeyId: string | null): FakePrincipalGrants {
		const principal = accessKeyId === null ? undefined : this.principals.get(accessKeyId);
		if (principal === undefined) throw new ServiceError(403, "forbidden", "Forbidden");
		return principal;
	}

	private verifySignature(method: string, url: URL, headers: Headers, bodyText: string, principal: FakePrincipalGrants): void {
		const refuse = (): never => {
			throw new ServiceError(403, "forbidden", "The request signature does not match");
		};
		const authorization = headers.get("authorization") ?? "";
		const parsed = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(authorization);
		if (parsed === null) return refuse();
		const [, , day, region, service, signedHeaderList, signature] = parsed as unknown as string[];
		const amzDate = headers.get("x-amz-date") ?? "";
		const payloadHash = headers.get("x-amz-content-sha256") ?? "";
		if (service !== "execute-api" || !amzDate.startsWith(day!) || payloadHash !== sha256Hex(bodyText)) return refuse();
		const signedNames = signedHeaderList!.split(";");
		for (const required of ["host", "x-amz-date", "x-amz-content-sha256"]) if (!signedNames.includes(required)) return refuse();
		let unsigned = false;
		headers.forEach((_value, name) => {
			if (name !== "authorization" && !signedNames.includes(name) && name !== "accept" && name !== "content-type" && name !== "content-length") unsigned = true;
		});
		if (unsigned) return refuse();
		const canonicalPath = url.pathname.split("/").map((segment) => rfc3986(segment)).join("/");
		const canonicalQuery = [...url.searchParams.entries()]
			.map(([name, value]) => [rfc3986(name), rfc3986(value)] as const)
			.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : left[1] < right[1] ? -1 : 1))
			.map(([name, value]) => `${name}=${value}`)
			.join("&");
		const canonicalHeaders = signedNames.map((name) => `${name}:${(headers.get(name) ?? "").trim().replace(/\s+/g, " ")}\n`).join("");
		const canonicalRequest = [method, canonicalPath, canonicalQuery, canonicalHeaders, signedHeaderList, payloadHash].join("\n");
		const scope = `${day}/${region}/${service}/aws4_request`;
		const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
		const signingKey = hmac(hmac(hmac(hmac(`AWS4${principal.secretAccessKey}`, day!), region!), service!), "aws4_request");
		const expected = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
		if (expected !== signature) refuse();
	}

	private async handle(method: string, url: URL, headers: Headers, bodyText: string, accessKeyId: string | null): Promise<Response> {
		const principal = this.principalOf(accessKeyId);
		this.verifySignature(method, url, headers, bodyText, principal);
		const match = /^\/([^/]+)\/([^/]+)\/api\/(.+)$/.exec(url.pathname);
		if (match === null) throw new ServiceError(404, "not_found", "Not found");
		const tenant = decodeURIComponent(match[1]!);
		const project = decodeURIComponent(match[2]!);
		const rest = match[3]!;
		if (tenant.startsWith("_") || !SCOPE_NAME_PATTERN.test(tenant) || !SCOPE_NAME_PATTERN.test(project)) {
			throw new ServiceError(400, "invalid_request", "Invalid scope name");
		}
		if (principal.tenants !== "*" && !principal.tenants.includes(tenant)) throw new ServiceError(403, "forbidden", "Forbidden");
		const actor = headers.get("x-kanbus-actor");
		if (principal.delegateActor) {
			if (actor === null || !ACTOR_PATTERN.test(actor)) throw new ServiceError(400, "invalid_request", "A delegating principal must send a valid X-Kanbus-Actor");
		} else if (actor !== null) {
			throw new ServiceError(403, "forbidden", "Forbidden");
		}
		const isWrite = method !== "GET";
		const operationId = headers.get("x-operation-id");
		if (isWrite && (operationId === null || !UUID_PATTERN.test(operationId))) {
			throw new ServiceError(400, "invalid_request", "X-Operation-Id must be a UUID");
		}
		const key = `${tenant}/${project}`;
		const board = this.boards.get(key);
		const body = bodyText === "" ? undefined : this.parseBody(bodyText);
		const creator = actor ?? "service";

		if (rest === "config" && method === "PUT") return this.provision(principal, key, board, operationId!, bodyText, actor);
		if (rest === "board/archive" && method === "POST") return this.archive(principal, key, board, operationId!, actor);
		if (rest === "board/restore" && method === "POST") return this.restore(principal, key, board, operationId!, actor);
		if (board === undefined || !board.configured) throw new ServiceError(404, "not_found", "Not found");
		if (board.archivedAt !== null) {
			if (!principal.provision) throw new ServiceError(404, "not_found", "Not found");
			if (isWrite) throw new ServiceError(409, "board_archived", "The board is archived");
		}
		if (method === "PATCH" && this.failNextUpdateToStatus !== null && body?.status === this.failNextUpdateToStatus) {
			this.failNextUpdateToStatus = null;
			throw new ServiceError(503, "storage_unavailable", "The store could not confirm the write");
		}
		if (isWrite && this.cannotConfirmWrites) throw new ServiceError(503, "storage_unavailable", "The store could not confirm the write");

		if (rest === "config" && method === "GET") return json(200, this.configuration(creator));
		if (rest === "issues" && method === "GET") return this.list(board, url);
		const issueMatch = /^issues\/([^/]+)(\/comments)?$/.exec(rest);
		if (rest === "issues" && method === "POST") {
			return this.replayable(board, operationId!, `${method} ${url.pathname}|${actor}|${bodyText}`, () => this.create(board, creator, body));
		}
		if (issueMatch !== null) {
			const id = decodeURIComponent(issueMatch[1]!);
			if (issueMatch[2] === undefined && method === "GET") {
				const stored = board.issues.get(id);
				if (stored === undefined) throw new ServiceError(404, "not_found", "Not found");
				return json(200, { issue: structuredClone(stored.issue), revision: this.revisionLabel(stored.revision) });
			}
			const ifMatch = headers.get("if-match");
			const fingerprint = `${method} ${url.pathname}|${actor}|${ifMatch}|${bodyText}`;
			if (issueMatch[2] === "/comments" && method === "POST") {
				return this.replayable(board, operationId!, fingerprint, () => this.comment(board, id, ifMatch, creator, body));
			}
			if (issueMatch[2] === undefined && method === "PATCH") {
				return this.replayable(board, operationId!, fingerprint, () => this.patch(board, id, ifMatch, body));
			}
			if (issueMatch[2] === undefined && method === "DELETE") {
				return this.replayable(board, operationId!, fingerprint, () => this.remove(board, id, ifMatch));
			}
		}
		throw new ServiceError(404, "not_found", "Not found");
	}

	private parseBody(text: string): Record<string, any> {
		try {
			const parsed = JSON.parse(text);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
			return parsed;
		} catch {
			throw new ServiceError(400, "invalid_request", "The body must be a JSON object");
		}
	}

	private configuration(actorId: string): Record<string, unknown> {
		return {
			actor_id: actorId,
			project_key: "kanbus",
			project_directory: "project",
			hierarchy: HIERARCHY,
			types: EXTRA_TYPES,
			workflows: { default: DEFAULT_WORKFLOW, epic: EPIC_WORKFLOW },
			initial_status: "open",
			priorities: Object.fromEntries(PRIORITIES.map((priority) => [String(priority), { name: String(priority) }])),
			default_priority: DEFAULT_PRIORITY,
			statuses: STATUSES.map((key) => ({ key })),
		};
	}

	private replayable(board: Board, operationId: string, fingerprint: string, run: () => { status: number; body: any }): Response {
		const receipt = board.receipts.get(operationId);
		if (receipt !== undefined) {
			if (receipt.fingerprint !== fingerprint) throw new ServiceError(409, "operation_conflict", "The operation id was used for a different request");
			return json(receipt.status, receipt.body);
		}
		const outcome = run();
		board.receipts.set(operationId, { fingerprint, status: outcome.status, body: outcome.body });
		return json(outcome.status, outcome.body);
	}

	private requireProvisioning(principal: FakePrincipalGrants): void {
		if (!principal.provision) throw new ServiceError(403, "forbidden", "Forbidden");
	}

	private provision(principal: FakePrincipalGrants, key: string, board: Board | undefined, operationId: string, bodyText: string, actor: string | null): Response {
		this.requireProvisioning(principal);
		if (actor === null || !actor.startsWith("chatticus:user:")) throw new ServiceError(400, "invalid_request", "Provisioning in this deployment is made on behalf of a user");
		if (bodyText !== "") throw new ServiceError(422, "invalid_configuration", "This fake provisions only the default configuration");
		const fingerprint = `PUT ${key}|${actor}`;
		if (board !== undefined) {
			const receipt = board.receipts.get(operationId);
			if (receipt !== undefined) {
				if (receipt.fingerprint !== fingerprint) throw new ServiceError(409, "operation_conflict", "The operation id was used for a different request");
				return json(200, receipt.body);
			}
			throw new ServiceError(409, "board_exists", "The board already has a configuration");
		}
		const created: Board = { configured: true, issues: new Map(), receipts: new Map(), archivedAt: null, purgeAfter: null };
		const body = this.configuration(actor ?? "service");
		created.receipts.set(operationId, { fingerprint, status: 201, body });
		this.boards.set(key, created);
		return json(201, body);
	}

	private archive(principal: FakePrincipalGrants, key: string, board: Board | undefined, operationId: string, actor: string | null): Response {
		this.requireProvisioning(principal);
		if (board === undefined) throw new ServiceError(404, "not_found", "Not found");
		const fingerprint = `archive ${key}|${actor}`;
		const receipt = board.receipts.get(operationId);
		if (receipt !== undefined) {
			if (receipt.fingerprint !== fingerprint) throw new ServiceError(409, "operation_conflict", "The operation id was used for a different request");
			return json(receipt.status, receipt.body);
		}
		if (board.archivedAt !== null) throw new ServiceError(409, "board_archived", "The board is archived");
		board.archivedAt = this.now();
		board.purgeAfter = new Date(board.archivedAt.getTime() + RETENTION_DAYS * 86_400_000);
		const body = { archived_at: isoMilliseconds(board.archivedAt), purge_after: isoMilliseconds(board.purgeAfter) };
		board.receipts.set(operationId, { fingerprint, status: 200, body });
		return json(200, body);
	}

	private restore(principal: FakePrincipalGrants, key: string, board: Board | undefined, operationId: string, actor: string | null): Response {
		this.requireProvisioning(principal);
		if (board === undefined) throw new ServiceError(404, "not_found", "Not found");
		const fingerprint = `restore ${key}|${actor}`;
		const receipt = board.receipts.get(operationId);
		if (receipt !== undefined) {
			if (receipt.fingerprint !== fingerprint) throw new ServiceError(409, "operation_conflict", "The operation id was used for a different request");
			return json(receipt.status, receipt.body);
		}
		if (board.archivedAt === null) throw new ServiceError(409, "board_not_archived", "The board is not archived");
		board.archivedAt = null;
		board.purgeAfter = null;
		const body = { restored: true };
		board.receipts.set(operationId, { fingerprint, status: 200, body });
		return json(200, body);
	}

	private list(board: Board, url: URL): Response {
		const status = url.searchParams.get("status");
		const parent = url.searchParams.get("parent");
		const limitText = url.searchParams.get("limit");
		const limit = limitText === null ? 100 : Number(limitText);
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ServiceError(400, "invalid_request", "limit must be 1 to 100");
		const entries = [...board.issues.values()]
			.filter((stored) => stored.indexed)
			.filter((stored) => status === null || stored.issue.status === status)
			.filter((stored) => parent === null || stored.issue.parent === parent)
			.sort((left, right) => (left.issue.created_at < right.issue.created_at ? -1 : left.issue.created_at > right.issue.created_at ? 1 : 0))
			.slice(0, limit)
			.map((stored) => ({ issue: structuredClone(stored.issue), revision: this.revisionLabel(stored.revision) }));
		return json(200, { issues: entries, next_cursor: null, cost: {} });
	}

	private checkFields(body: Record<string, any>, allowed: Set<string>): void {
		for (const field of Object.keys(body)) {
			if (!allowed.has(field)) throw new ServiceError(400, "invalid_request", `The field ${field} is not writable`);
		}
	}

	private checkValues(board: Board, type: string, body: Record<string, any>): void {
		if ("title" in body && (typeof body.title !== "string" || body.title.trim() === "")) {
			throw new ServiceError(400, "invalid_issue", "title is required");
		}
		if ("priority" in body && !PRIORITIES.includes(body.priority)) throw new ServiceError(400, "invalid_issue", `priority ${String(body.priority)} is not in the configuration`);
		if ("labels" in body && (!Array.isArray(body.labels) || body.labels.some((label: unknown) => typeof label !== "string"))) {
			throw new ServiceError(400, "invalid_issue", "labels must be strings");
		}
		if ("description" in body && typeof body.description !== "string") throw new ServiceError(400, "invalid_issue", "description must be text");
		if ("custom" in body && (typeof body.custom !== "object" || body.custom === null || Array.isArray(body.custom))) {
			throw new ServiceError(400, "invalid_issue", "custom must be an object");
		}
		if ("status" in body && !STATUSES.includes(body.status)) throw new ServiceError(400, "invalid_issue", `status ${String(body.status)} is not a configured status`);
		if ("dependencies" in body) this.checkDependencies(board, body.dependencies);
		if ("parent" in body && body.parent !== null) this.checkParent(board, type, body.parent);
	}

	private checkDependencies(board: Board, dependencies: unknown): void {
		if (!Array.isArray(dependencies)) throw new ServiceError(400, "invalid_request", "dependencies must be a list");
		for (const entry of dependencies) {
			if (typeof entry !== "object" || entry === null || typeof entry.target !== "string" || !["blocked-by", "relates-to"].includes(entry.type)) {
				throw new ServiceError(400, "invalid_request", "a dependency needs a target and a type of blocked-by or relates-to");
			}
			if (!board.issues.has(entry.target)) throw new ServiceError(409, "relation_target_missing", `the dependency target ${entry.target} does not exist`);
		}
	}

	private checkParent(board: Board, childType: string, parentId: unknown): void {
		const parent = typeof parentId === "string" ? board.issues.get(parentId) : undefined;
		if (parent === undefined) throw new ServiceError(409, "relation_target_missing", `the parent ${String(parentId)} does not exist`);
		if (levelOf(parent.issue.type) !== levelOf(childType) - 1) {
			throw new ServiceError(409, "hierarchy_violation", `a ${childType} cannot be under a ${parent.issue.type}: the parent hierarchy level is wrong`);
		}
	}

	private checkTransition(type: string, from: string, to: string): void {
		if (from === to) return;
		const workflow = type === "epic" ? EPIC_WORKFLOW : DEFAULT_WORKFLOW;
		if (!(workflow[from] ?? []).includes(to)) throw new ServiceError(400, "invalid_issue", `status ${to} is not allowed after ${from} for a ${type}`);
	}

	private create(board: Board, creator: string, body: Record<string, any> | undefined): { status: number; body: any } {
		const fields = body ?? {};
		this.checkFields(fields, CREATE_FIELDS);
		if (!("title" in fields)) throw new ServiceError(400, "invalid_issue", "title is required");
		const type = fields.type;
		if (typeof type !== "string" || ![...HIERARCHY, ...EXTRA_TYPES].includes(type)) {
			throw new ServiceError(400, "invalid_issue", `type ${String(type)} is not in the hierarchy or the configured types`);
		}
		this.checkValues(board, type, fields);
		const status = fields.status ?? "open";
		if (status === "closed") throw new ServiceError(400, "invalid_issue", "a new card cannot be created closed");
		const timestamp = isoMilliseconds(this.now());
		const issue = {
			id: `kanbus-${randomUUID()}`,
			title: fields.title,
			description: fields.description ?? "",
			type,
			status,
			priority: fields.priority ?? DEFAULT_PRIORITY,
			assignee: fields.assignee ?? null,
			creator,
			parent: fields.parent ?? null,
			labels: fields.labels ?? [],
			dependencies: fields.dependencies ?? [],
			comments: [] as unknown[],
			created_at: timestamp,
			updated_at: timestamp,
			closed_at: null,
			custom: fields.custom ?? {},
		};
		const stored: StoredIssue = { issue, revision: 1, indexed: !this.lagging, writes: 1 };
		board.issues.set(issue.id, stored);
		return { status: 201, body: { issue: structuredClone(issue), revision: this.revisionLabel(1), catalog_pending: this.lagging } };
	}

	private requireRevision(stored: StoredIssue, ifMatch: string | null): void {
		if (ifMatch === null) throw new ServiceError(428, "revision_required", "If-Match is required");
		if (ifMatch !== this.revisionLabel(stored.revision)) {
			throw new ServiceError(409, "revision_conflict", `The card is at ${this.revisionLabel(stored.revision)}, not ${ifMatch}`);
		}
	}

	private touch(stored: StoredIssue): void {
		const previous = Date.parse(stored.issue.updated_at);
		stored.issue.updated_at = isoMilliseconds(new Date(Math.max(this.now().getTime(), previous + 1)));
		stored.revision += 1;
		stored.writes += 1;
		if (this.lagging) stored.indexed = false;
	}

	private patch(board: Board, id: string, ifMatch: string | null, body: Record<string, any> | undefined): { status: number; body: any } {
		const stored = board.issues.get(id);
		if (stored === undefined) throw new ServiceError(404, "not_found", "Not found");
		this.requireRevision(stored, ifMatch);
		const fields = body ?? {};
		this.checkFields(fields, PATCH_FIELDS);
		if ("type" in fields && fields.type !== stored.issue.type) throw new ServiceError(409, "type_change_unsupported", "The type of a card cannot be changed");
		this.checkValues(board, stored.issue.type, fields);
		if ("status" in fields) this.checkTransition(stored.issue.type, stored.issue.status, fields.status);
		const previousStatus = stored.issue.status;
		for (const [field, value] of Object.entries(fields)) {
			if (field === "custom") stored.issue.custom = { ...stored.issue.custom, ...(value as Record<string, unknown>) };
			else stored.issue[field] = value;
		}
		if (stored.issue.status === "closed" && previousStatus !== "closed") stored.issue.closed_at = isoMilliseconds(this.now());
		if (stored.issue.status !== "closed") stored.issue.closed_at = null;
		this.touch(stored);
		return { status: 200, body: { issue: structuredClone(stored.issue), revision: this.revisionLabel(stored.revision), catalog_pending: this.lagging } };
	}

	private comment(board: Board, id: string, ifMatch: string | null, author: string, body: Record<string, any> | undefined): { status: number; body: any } {
		const stored = board.issues.get(id);
		if (stored === undefined) throw new ServiceError(404, "not_found", "Not found");
		this.requireRevision(stored, ifMatch);
		if (typeof body?.text !== "string" || body.text.trim() === "") throw new ServiceError(400, "invalid_request", "text is required");
		stored.issue.comments.push({ id: randomUUID(), author, text: body.text, created_at: isoMilliseconds(this.now()), comment_type: "default" });
		this.touch(stored);
		return { status: 200, body: { issue: structuredClone(stored.issue), revision: this.revisionLabel(stored.revision), catalog_pending: this.lagging } };
	}

	private remove(board: Board, id: string, ifMatch: string | null): { status: number; body: any } {
		const stored = board.issues.get(id);
		if (stored === undefined) throw new ServiceError(404, "not_found", "Not found");
		this.requireRevision(stored, ifMatch);
		for (const other of board.issues.values()) {
			if (other.issue.parent === id) throw new ServiceError(409, "issue_has_children", `${id} has children`);
			if ((other.issue.dependencies as Array<{ target: string }>).some((entry) => entry.target === id)) {
				throw new ServiceError(409, "issue_has_dependents", `${id} has dependents`);
			}
		}
		board.issues.delete(id);
		return { status: 200, body: { deleted: true, issue_id: id, catalog_pending: this.lagging } };
	}
}

