import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import type { KanbusIssueQuery } from "@kanbus/api-client";
import type { BoardAuditSink, BoardDenialReason } from "../../board/board-audit.ts";
import type { BoardFailure, BoardResult } from "../../board/board-failures.ts";
import type {
	BoardActor,
	BoardAddress,
	BotBoardService,
	CardChanges,
	DependencyType,
	NewCardFields,
	WriteContext,
} from "../../board/bot-board-service.ts";
import { PrincipalHttpError, type Principal } from "../../auth/principal.ts";
import { BotNotFoundError, botById } from "../../domain/bots.ts";
import type { Clock } from "../app.ts";
import { declareRoute } from "../route-audience.ts";
import { isRefusal, pathParameter, resolveUserPrincipal, type UserPrincipalDependencies } from "../user-principal.ts";

/** Everything the bot board routes depend on. */
export interface BotBoardRouteDependencies extends UserPrincipalDependencies {
	clock: Clock;
	/** The board service, present only where the board capability is rolled out; absent, every board route answers 404 board_service_not_enabled. */
	boards: BotBoardService | null;
	/** Receives one record for each denied request; it never receives card text. */
	audit: BoardAuditSink;
}

/** The code a board route answers with when the deployment has no board service. */
export const BOARD_SERVICE_NOT_ENABLED_CODE = "board_service_not_enabled";

const ERROR_STATUS_OF_CODE: Readonly<Record<string, number>> = {
	board_not_archived: 409,
	relation_target_missing: 409,
	issue_has_children: 409,
	issue_has_dependents: 409,
	hierarchy_violation: 409,
	type_change_unsupported: 409,
	revision_required: 428,
};

const DEPENDENCY_TYPES: readonly DependencyType[] = ["blocked-by", "relates-to"];
const SORT_ORDERS = ["priority", "updated_at"] as const;

type RouteSpecification = {
	readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	readonly path: string;
	readonly operation: string;
	/** Whether the route changes the board; a failed change is reported as not saved. */
	readonly writes: boolean;
	/** Whether the route acts on one card and so carries the revision the caller saw. */
	readonly needsRevision: boolean;
	readonly run: (call: BoardCall) => Promise<Response>;
};

type BoardCall = {
	readonly context: Context;
	readonly service: BotBoardService;
	readonly address: BoardAddress;
	readonly botName: string;
	readonly actor: BoardActor;
	readonly body: Record<string, unknown>;
	readonly write: WriteContext;
};

type Rejection = { readonly status: number; readonly code: string; readonly detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(body: Record<string, unknown>, name: string): string | undefined | Rejection {
	const value = body[name];
	if (value === undefined) return undefined;
	if (typeof value !== "string") return { status: 422, code: "invalid_request", detail: `${name} must be a string` };
	return value;
}

function isRejection(value: unknown): value is Rejection {
	return isRecord(value) && typeof value["status"] === "number" && typeof value["code"] === "string" && typeof value["detail"] === "string";
}

function rejectionResponse(c: Context, rejection: Rejection): Response {
	return c.json({ detail: rejection.detail, code: rejection.code }, rejection.status as 422);
}

function fieldsOf(body: Record<string, unknown>, names: readonly string[]): Record<string, string | undefined> | Rejection {
	const fields: Record<string, string | undefined> = {};
	for (const name of names) {
		const value = optionalString(body, name);
		if (isRejection(value)) return value;
		fields[name] = value;
	}
	return fields;
}

function changesOf(body: Record<string, unknown>): CardChanges | Rejection {
	const texts = fieldsOf(body, ["title", "description", "status"]);
	if (isRejection(texts)) return texts;
	const priority = body["priority"];
	if (priority !== undefined && !Number.isInteger(priority)) return { status: 422, code: "invalid_request", detail: "priority must be an integer" };
	const labels = body["labels"];
	if (labels !== undefined && !(Array.isArray(labels) && labels.every((label) => typeof label === "string"))) {
		return { status: 422, code: "invalid_request", detail: "labels must be a list of strings" };
	}
	return {
		...(texts["title"] === undefined ? {} : { title: texts["title"] }),
		...(texts["description"] === undefined ? {} : { description: texts["description"] }),
		...(texts["status"] === undefined ? {} : { status: texts["status"] }),
		...(priority === undefined ? {} : { priority: priority as number }),
		...(labels === undefined ? {} : { labels: labels as string[] }),
	};
}

function newCardOf(body: Record<string, unknown>): NewCardFields | Rejection {
	const changes = changesOf(body);
	if (isRejection(changes)) return changes;
	const extra = fieldsOf(body, ["type", "parent"]);
	if (isRejection(extra)) return extra;
	if (changes.title === undefined || changes.title.trim() === "") return { status: 422, code: "title_required", detail: "A card needs a title." };
	return {
		...changes,
		title: changes.title,
		...(extra["type"] === undefined ? {} : { type: extra["type"] }),
		...(extra["parent"] === undefined ? {} : { parent: extra["parent"] }),
	};
}

function queryOf(c: Context): KanbusIssueQuery | Rejection {
	const query: { -readonly [Key in keyof KanbusIssueQuery]: KanbusIssueQuery[Key] } = {};
	for (const name of ["type", "status", "assignee", "label", "parent", "search", "cursor"] as const) {
		const value = c.req.query(name);
		if (value !== undefined) query[name] = value;
	}
	const limit = c.req.query("limit");
	if (limit !== undefined) {
		if (!/^[0-9]+$/.test(limit)) return { status: 422, code: "invalid_request", detail: "limit must be a whole number" };
		query.limit = Number(limit);
	}
	const sort = c.req.query("sort");
	if (sort !== undefined) {
		if (!(SORT_ORDERS as readonly string[]).includes(sort)) return { status: 422, code: "invalid_request", detail: "sort must be priority or updated_at" };
		query.sort = sort as (typeof SORT_ORDERS)[number];
	}
	return query;
}

function statusOfFailure(failure: BoardFailure): number {
	switch (failure.kind) {
		case "forbidden":
			return 403;
		case "not_found":
			return 404;
		case "conflict":
		case "operation_conflict":
		case "archived":
			return 409;
		case "refused":
			return 422;
		case "invalid":
			return ERROR_STATUS_OF_CODE[failure.code ?? ""] ?? 422;
		case "unavailable":
		case "service_unreachable_route":
			return 502;
	}
}

function failureResponse(c: Context, failure: BoardFailure, writes: boolean): Response {
	const status = statusOfFailure(failure);
	const unconfirmed = failure.kind === "unavailable" || failure.kind === "service_unreachable_route";
	return c.json(
		{
			detail: failure.message,
			code: failure.code ?? (unconfirmed ? "board_service_unavailable" : failure.kind),
			kind: failure.kind,
			...(unconfirmed && writes ? { saved: false } : {}),
			...(failure.currentCard === undefined ? {} : { current_revision: failure.currentCard.revision, current_card: failure.currentCard }),
		},
		status as 422,
	);
}

function resultResponse<Value>(c: Context, result: BoardResult<Value>, writes: boolean, shape: (value: Value) => Record<string, unknown>): Response {
	if (!result.ok) return failureResponse(c, result.failure, writes);
	return c.json({ ...shape(result.value), catalog_pending: result.listingMayBeBehind }, 200);
}

function cardShape(value: { issue: unknown; revision: string }): Record<string, unknown> {
	return { issue: value.issue, revision: value.revision };
}

function sentRevisionOf(c: Context): string | undefined {
	const revision = (c.req.header("If-Match") ?? "").trim();
	return revision === "" ? undefined : revision;
}

function cardIdOf(call: BoardCall): string {
	return pathParameter(call.context, "card_id");
}

async function bodyOf(c: Context): Promise<Record<string, unknown> | Rejection> {
	if (!["POST", "PUT", "PATCH"].includes(c.req.method)) return {};
	const text = await c.req.text();
	if (text.trim() === "") return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { status: 422, code: "invalid_request", detail: "The request body must be JSON." };
	}
	return isRecord(parsed) ? parsed : { status: 422, code: "invalid_request", detail: "The request body must be a JSON object." };
}

function textFieldOf(call: BoardCall, name: string): string | Rejection {
	const value = call.body[name];
	if (value === undefined) return "";
	if (typeof value !== "string") return { status: 422, code: "invalid_request", detail: `${name} must be a string` };
	return value;
}

function routeOf(operation: string, writes: boolean, spec: Omit<RouteSpecification, "operation" | "writes" | "needsRevision"> & { needsRevision?: boolean }): RouteSpecification {
	return { operation, writes, needsRevision: spec.needsRevision ?? writes, method: spec.method, path: spec.path, run: spec.run };
}

const BOARD_PATH = "/orgs/:tenant_id/bots/:bot_id/board";
const CARD_PATH = `${BOARD_PATH}/cards/:card_id`;

const ROUTES: readonly RouteSpecification[] = [
	routeOf("overview", false, {
		method: "GET",
		path: BOARD_PATH,
		run: async (call) => {
			const query = queryOf(call.context);
			if (isRejection(query)) return rejectionResponse(call.context, query);
			const result = await call.service.readBoard(call.address, call.actor, query);
			return resultResponse(call.context, result, false, (board) => ({
				tenant_id: call.address.organizationId,
				bot_id: call.address.botId,
				bot_name: call.botName,
				configuration: board.configuration,
				cards: board.cards,
				next_cursor: board.nextCursor,
			}));
		},
	}),
	routeOf("list_cards", false, {
		method: "GET",
		path: `${BOARD_PATH}/cards`,
		run: async (call) => {
			const query = queryOf(call.context);
			if (isRejection(query)) return rejectionResponse(call.context, query);
			const result = await call.service.listCards(call.address, call.actor, query);
			return resultResponse(call.context, result, false, (listing) => ({ cards: listing.cards, next_cursor: listing.nextCursor }));
		},
	}),
	routeOf("get_card", false, {
		method: "GET",
		path: CARD_PATH,
		run: async (call) => resultResponse(call.context, await call.service.getCard(call.address, call.actor, cardIdOf(call)), false, cardShape),
	}),
	routeOf("create_card", true, {
		method: "POST",
		path: `${BOARD_PATH}/cards`,
		needsRevision: false,
		run: async (call) => {
			const fields = newCardOf(call.body);
			if (isRejection(fields)) return rejectionResponse(call.context, fields);
			return resultResponse(call.context, await call.service.createCard(call.address, call.actor, fields, call.write), true, cardShape);
		},
	}),
	routeOf("update_card", true, {
		method: "PATCH",
		path: CARD_PATH,
		run: async (call) => {
			const changes = changesOf(call.body);
			if (isRejection(changes)) return rejectionResponse(call.context, changes);
			return resultResponse(call.context, await call.service.updateCard(call.address, call.actor, cardIdOf(call), changes, call.write), true, cardShape);
		},
	}),
	routeOf("comment_on_card", true, {
		method: "POST",
		path: `${CARD_PATH}/comments`,
		run: async (call) => {
			const text = textFieldOf(call, "text");
			if (isRejection(text)) return rejectionResponse(call.context, text);
			return resultResponse(call.context, await call.service.commentOnCard(call.address, call.actor, cardIdOf(call), text, call.write), true, cardShape);
		},
	}),
	routeOf("complete_card", true, {
		method: "POST",
		path: `${CARD_PATH}/complete`,
		run: async (call) => {
			const evidence = textFieldOf(call, "evidence");
			if (isRejection(evidence)) return rejectionResponse(call.context, evidence);
			return resultResponse(call.context, await call.service.completeCard(call.address, call.actor, cardIdOf(call), evidence, call.write), true, cardShape);
		},
	}),
	routeOf("abandon_card", true, {
		method: "POST",
		path: `${CARD_PATH}/abandon`,
		run: async (call) => {
			const reason = textFieldOf(call, "reason");
			if (isRejection(reason)) return rejectionResponse(call.context, reason);
			return resultResponse(call.context, await call.service.closeCard(call.address, call.actor, cardIdOf(call), reason, call.write), true, cardShape);
		},
	}),
	routeOf("reopen_card", true, {
		method: "POST",
		path: `${CARD_PATH}/reopen`,
		run: async (call) => resultResponse(call.context, await call.service.reopenCard(call.address, call.actor, cardIdOf(call), call.write), true, cardShape),
	}),
	routeOf("set_parent", true, {
		method: "PUT",
		path: `${CARD_PATH}/parent`,
		run: async (call) => {
			const parent = call.body["parent"];
			if (parent !== null && typeof parent !== "string") return rejectionResponse(call.context, { status: 422, code: "invalid_request", detail: "parent must be a card identifier or null" });
			return resultResponse(call.context, await call.service.setParent(call.address, call.actor, cardIdOf(call), parent, call.write), true, cardShape);
		},
	}),
	routeOf("add_dependency", true, {
		method: "POST",
		path: `${CARD_PATH}/dependencies`,
		run: async (call) => {
			const target = call.body["target"];
			const type = call.body["type"] ?? "blocked-by";
			if (typeof target !== "string" || target === "") return rejectionResponse(call.context, { status: 422, code: "invalid_request", detail: "target must be a card identifier" });
			if (!(DEPENDENCY_TYPES as readonly unknown[]).includes(type)) return rejectionResponse(call.context, { status: 422, code: "invalid_request", detail: "type must be blocked-by or relates-to" });
			return resultResponse(call.context, await call.service.addDependency(call.address, call.actor, cardIdOf(call), target, type as DependencyType, call.write), true, cardShape);
		},
	}),
	routeOf("remove_dependency", true, {
		method: "DELETE",
		path: `${CARD_PATH}/dependencies/:target_id`,
		run: async (call) =>
			resultResponse(call.context, await call.service.removeDependency(call.address, call.actor, cardIdOf(call), pathParameter(call.context, "target_id"), call.write), true, cardShape),
	}),
	routeOf("delete_card", true, {
		method: "DELETE",
		path: CARD_PATH,
		run: async (call) =>
			resultResponse(call.context, await call.service.deleteCard(call.address, call.actor, cardIdOf(call), { ...call.write, revision: call.write.revision! }), true, (deletion) => ({ ...deletion })),
	}),
	routeOf("archive_board", true, {
		method: "POST",
		path: `${BOARD_PATH}/archive`,
		needsRevision: false,
		run: async (call) => resultResponse(call.context, await call.service.archiveBotBoard(call.address, call.actor, call.write.operationKey), true, (archived) => ({ ...archived })),
	}),
	routeOf("restore_board", true, {
		method: "POST",
		path: `${BOARD_PATH}/restore`,
		needsRevision: false,
		run: async (call) => resultResponse(call.context, await call.service.restoreBotBoard(call.address, call.actor, call.write.operationKey), true, (restored) => ({ ...restored })),
	}),
];

function denial(c: Context, reason: BoardDenialReason, operation: string, who: { tenantId: string; botId: string | null; userId: string | null }, deps: BotBoardRouteDependencies): void {
	deps.audit({
		at: deps.clock.now(),
		tenantId: who.tenantId,
		botId: who.botId,
		userId: who.userId,
		operation,
		method: c.req.method,
		cardId: c.req.param("card_id") ?? null,
		outcome: "refused",
		reason,
	});
}

function notFound(c: Context): Response {
	return c.json({ detail: "The board was not found.", code: "not_found", kind: "not_found" }, 404);
}

async function handle(c: Context, deps: BotBoardRouteDependencies, route: RouteSpecification): Promise<Response> {
	const tenantId = pathParameter(c, "tenant_id");
	const botId = pathParameter(c, "bot_id");
	let principal: Principal | Response;
	try {
		principal = await resolveUserPrincipal(c, deps);
	} catch (error) {
		if (error instanceof PrincipalHttpError && error.nonMemberUserId !== null) {
			denial(c, "not_found", route.operation, { tenantId, botId, userId: error.nonMemberUserId }, deps);
			return notFound(c);
		}
		if (error instanceof PrincipalHttpError && (c.req.header("Authorization") ?? "") === "") {
			denial(c, "not_signed_in", route.operation, { tenantId, botId, userId: null }, deps);
		}
		throw error;
	}
	if (isRefusal(principal)) return principal;
	if (principal.userId === null) return c.json({ detail: "user credential required" }, 403);
	const userId = principal.userId;
	if (deps.boards === null) {
		return c.json({ detail: "This deployment has no board service.", code: BOARD_SERVICE_NOT_ENABLED_CODE }, 404);
	}
	let botName: string;
	try {
		botName = (await botById(tenantId, botId, deps)).name;
	} catch (error) {
		if (error instanceof BotNotFoundError) {
			denial(c, "not_found", route.operation, { tenantId, botId, userId }, deps);
			return notFound(c);
		}
		throw error;
	}
	const body = await bodyOf(c);
	if (isRejection(body)) return rejectionResponse(c, body);
	const revision = sentRevisionOf(c);
	if (route.needsRevision && revision === undefined) {
		return c.json({ detail: "A change names the revision the caller saw in the If-Match header.", code: "revision_required", kind: "invalid" }, 428);
	}
	const idempotencyKey = (c.req.header("Idempotency-Key") ?? "").trim();
	const response = await route.run({
		context: c,
		service: deps.boards,
		address: { organizationId: tenantId, botId },
		botName,
		actor: { kind: "user", userId },
		body,
		write: { operationKey: idempotencyKey === "" ? randomUUID() : idempotencyKey, ...(revision === undefined ? {} : { revision }) },
	});
	if (response.status === 403 || response.status === 404) {
		const reason: BoardDenialReason = response.status === 403 ? "forbidden" : "not_found";
		denial(c, reason, route.operation, { tenantId, botId, userId }, deps);
	}
	return response;
}

/**
 * Register the routes of a bot's board under `/orgs/{tenant_id}/bots/{bot_id}/board`. Every member of the organization
 * reads; only owners change or delete; the organization and the bot come from the path and never from the body.
 *
 * @param app The application to register on.
 * @param deps The user principal dependencies, the board service (null where the capability is not rolled out) and the audit sink.
 */
export function registerBotBoardRoutes(app: Hono, deps: BotBoardRouteDependencies): void {
	for (const route of ROUTES) {
		declareRoute(app, { method: route.method, path: route.path, audience: "user" }, (c) => handle(c, deps, route));
	}
}
