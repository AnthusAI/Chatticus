import type { Context } from "hono";
import {
	COST_COMPARE_MAX_SUBJECTS,
	COST_COMPARE_MIN_SUBJECTS,
	COST_EXPORT_CALL_COLUMNS,
	COST_EXPORT_CALL_GRAIN_MAX_TURNS,
	COST_EXPORT_TURN_COLUMNS,
	COST_GROUP_PAGE_DEFAULT_LIMIT,
	COST_GROUP_PAGE_MAX_LIMIT,
	COST_PAGE_DEFAULT_LIMIT,
	COST_PAGE_MAX_LIMIT,
	costQuerySchema,
	type ChannelCostResponse,
	type CostCall,
	type CostCompareResponse,
	type CostErrorCode,
	type CostFilters,
	type CostRowsResponse,
	type CostSummaryResponse,
	type MessageCostResponse,
	type TurnCostResponse,
} from "@chatticus/host-protocol/costs";
import {
	CostQueryError,
	compareItemOf,
	costRowOf,
	csvLine,
	groupRows,
	monthsOfWindow,
	newestFirst,
	pageOfGroups,
	pageOfRows,
	plainDollars,
	readCostRows,
	readTurnCalls,
	readTurnRow,
	resolveWindow,
	selectRows,
	totalsOf,
	type CostReadDependencies,
	type CostWindow,
	type IndexRow,
} from "../../domain/costs.ts";
import { PrincipalHttpError } from "../../auth/principal.ts";
import { getChannel } from "../../domain/channels.ts";
import { getTurn, type TurnDependencies } from "../../domain/turns.ts";
import type { ChannelListingDependencies } from "../../pi/channel-listing.ts";
import { ChannelNotFoundError, TurnNotFoundError } from "../errors.ts";
import type { Clock } from "../app.ts";
import { isRefusal, pathParameter, resolveUserPrincipal, type UserPrincipalDependencies } from "../user-principal.ts";

/** Everything the cost routes depend on. */
export interface CostRouteDependencies extends UserPrincipalDependencies {
	costs: CostReadDependencies;
	listing: ChannelListingDependencies;
	turns: TurnDependencies;
	clock: Clock;
}

type RouteFailure = { readonly status: 400 | 404 | 422; readonly code: CostErrorCode; readonly message: string };

const noStore = <Answer extends Response>(response: Answer): Answer => {
	response.headers.set("Cache-Control", "private, no-store");
	response.headers.set("X-Content-Type-Options", "nosniff");
	return response;
};

const failure = (c: Context, problem: RouteFailure): Response =>
	noStore(c.json({ error: problem.code, message: problem.message }, problem.status));

/**
 * Resolve the caller of a cost route. Every enabled member of the organization may read the organization's cost; the
 * principal resolver refuses a caller who is not a member of the tenant in the path, whatever organization they belong to.
 */
async function resolveReader(c: Context, deps: CostRouteDependencies): Promise<Response | null> {
	try {
		const principal = await resolveUserPrincipal(c, deps);
		return isRefusal(principal) ? noStore(principal) : null;
	} catch (error) {
		if (error instanceof PrincipalHttpError) return noStore(c.json({ detail: error.detail }, error.status as 403));
		throw error;
	}
}

async function guarded(c: Context, deps: CostRouteDependencies, handle: () => Promise<Response>): Promise<Response> {
	const refusal = await resolveReader(c, deps);
	if (refusal !== null) return refusal;
	try {
		return noStore(await handle());
	} catch (error) {
		if (error instanceof CostQueryError) return failure(c, { status: 400, code: "invalid_query", message: error.message });
		if (error instanceof ChannelNotFoundError) return failure(c, { status: 404, code: "channel_not_found", message: "This channel does not exist." });
		if (error instanceof TurnNotFoundError) return failure(c, { status: 404, code: "turn_not_found", message: "This turn does not exist." });
		throw error;
	}
}

type ParsedQuery = ReturnType<typeof parseQuery>;

function parseQuery(c: Context) {
	const parsed = costQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams.entries()));
	if (!parsed.success) {
		throw new CostQueryError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "query"}: ${issue.message}`).join("; "));
	}
	return parsed.data;
}

function limitOf(query: ParsedQuery, fallback: number, maximum: number): number {
	const limit = query.limit ?? fallback;
	if (limit > maximum) throw new CostQueryError(`limit must be at most ${maximum}.`);
	return limit;
}

function filtersOf(query: ParsedQuery, pinned: Partial<CostFilters> = {}): CostFilters {
	return {
		bot_id: pinned.bot_id ?? query.bot_id ?? null,
		channel_id: pinned.channel_id ?? query.channel_id ?? null,
		member_id: pinned.member_id ?? query.member_id ?? null,
	};
}

async function rowsOf(deps: CostRouteDependencies, tenantId: string, window: CostWindow, filters: CostFilters): Promise<IndexRow[]> {
	return selectRows(await readCostRows(deps.costs, tenantId, monthsOfWindow(window)), window, filters);
}

/**
 * GET /orgs/{tenant_id}/costs?from=&to=&bot_id=&channel_id=&member_id=&group_by=&limit=&cursor=: the totals of the
 * organization over a date range (the month so far by default) and, with `group_by`, groups that add up to them.
 */
export async function getCostSummaryHandler(c: Context, deps: CostRouteDependencies): Promise<Response> {
	return guarded(c, deps, async () => {
		const tenantId = pathParameter(c, "tenant_id");
		const query = parseQuery(c);
		const window = resolveWindow(query, deps.clock.now(), "month_to_date");
		const filters = filtersOf(query);
		const limit = limitOf(query, COST_GROUP_PAGE_DEFAULT_LIMIT, COST_GROUP_PAGE_MAX_LIMIT);
		const rows = await rowsOf(deps, tenantId, window, filters);
		const grouped = query.group_by === undefined ? { page: [], next: null } : pageOfGroups(groupRows(rows, query.group_by), limit, query.cursor);
		const body: CostSummaryResponse = {
			tenant_id: tenantId,
			...window,
			group_by: query.group_by ?? null,
			filters,
			totals: totalsOf(rows),
			groups: grouped.page,
			next_cursor: grouped.next,
		};
		return c.json(body, 200);
	});
}

/** GET /orgs/{tenant_id}/costs/turns: the rows of the range, newest first, with the same filters and one page at a time. */
export async function listCostRowsHandler(c: Context, deps: CostRouteDependencies): Promise<Response> {
	return guarded(c, deps, async () => {
		const tenantId = pathParameter(c, "tenant_id");
		const query = parseQuery(c);
		const window = resolveWindow(query, deps.clock.now(), "month_to_date");
		const filters = filtersOf(query);
		const limit = limitOf(query, COST_PAGE_DEFAULT_LIMIT, COST_PAGE_MAX_LIMIT);
		const rows = await rowsOf(deps, tenantId, window, filters);
		const { page, next } = pageOfRows(newestFirst(rows), limit, query.cursor);
		const body: CostRowsResponse = {
			tenant_id: tenantId,
			...window,
			filters,
			totals: totalsOf(rows),
			rows: page.map(costRowOf),
			next_cursor: next,
		};
		return c.json(body, 200);
	});
}

/**
 * GET /orgs/{tenant_id}/channels/{channel_id}/cost: the session total of a channel (all of the lookback by default), its
 * split by bot, and its turns newest first, one page at a time.
 */
export async function getChannelCostHandler(c: Context, deps: CostRouteDependencies): Promise<Response> {
	return guarded(c, deps, async () => {
		const tenantId = pathParameter(c, "tenant_id");
		const channelId = pathParameter(c, "channel_id");
		await getChannel(tenantId, channelId, deps);
		const query = parseQuery(c);
		const window = resolveWindow(query, deps.clock.now(), "lookback");
		const limit = limitOf(query, COST_PAGE_DEFAULT_LIMIT, COST_PAGE_MAX_LIMIT);
		const rows = await rowsOf(deps, tenantId, window, filtersOf(query, { channel_id: channelId }));
		const { page, next } = pageOfRows(newestFirst(rows), limit, query.cursor);
		const body: ChannelCostResponse = {
			tenant_id: tenantId,
			channel_id: channelId,
			...window,
			totals: totalsOf(rows),
			by_bot: groupRows(rows, "bot"),
			rows: page.map(costRowOf),
			next_cursor: next,
		};
		return c.json(body, 200);
	});
}

/**
 * GET /orgs/{tenant_id}/channels/{channel_id}/messages/{seq}/cost: what a message triggered (a member message) and what it
 * took to produce it (a bot reply).
 */
export async function getMessageCostHandler(c: Context, deps: CostRouteDependencies): Promise<Response> {
	return guarded(c, deps, async () => {
		const tenantId = pathParameter(c, "tenant_id");
		const channelId = pathParameter(c, "channel_id");
		const rawSequence = pathParameter(c, "seq");
		if (!/^[1-9]\d{0,14}$/.test(rawSequence)) throw new CostQueryError("seq must be a positive integer.");
		const sequence = Number(rawSequence);
		await getChannel(tenantId, channelId, deps);
		const window = resolveWindow({}, deps.clock.now(), "lookback");
		const rows = await rowsOf(deps, tenantId, window, { bot_id: null, channel_id: channelId, member_id: null });
		const side = (matching: IndexRow[]) => ({ totals: totalsOf(matching), rows: newestFirst(matching).map(costRowOf) });
		const body: MessageCostResponse = {
			tenant_id: tenantId,
			channel_id: channelId,
			message_seq: sequence,
			triggered: side(rows.filter((row) => row.promptMessageSeq === sequence)),
			produced: side(rows.filter((row) => row.messageSeq === sequence)),
		};
		return c.json(body, 200);
	});
}

/**
 * GET /orgs/{tenant_id}/turns/{turn_id}/cost: the turn's row of the cost index and, as the drill-down, every call the
 * session recorded for it with its model, tokens, tier, price book and dollars.
 */
export async function getTurnCostHandler(c: Context, deps: CostRouteDependencies): Promise<Response> {
	return guarded(c, deps, async () => {
		const tenantId = pathParameter(c, "tenant_id");
		const turn = await getTurn(deps.turns, tenantId, pathParameter(c, "turn_id"));
		const row = await readTurnRow(deps.costs, tenantId, turn.turnId, deps.clock.now());
		const calls = await readTurnCalls(deps.listing, tenantId, turn.botId, turn.channelId, turn.turnId);
		const body: TurnCostResponse = {
			tenant_id: tenantId,
			turn_id: turn.turnId,
			channel_id: turn.channelId,
			bot_id: turn.botId,
			row: row === null ? null : costRowOf(row),
			totals: totalsOf(row === null ? [] : [row]),
			calls: calls ?? [],
			calls_available: calls !== null,
		};
		return c.json(body, 200);
	});
}

/**
 * GET /orgs/{tenant_id}/costs/compare?channel_id=a&channel_id=b (or turn_id=a&turn_id=b): the totals and normalized
 * metrics of two to six channels or turns, side by side, in the order asked.
 */
export async function compareCostsHandler(c: Context, deps: CostRouteDependencies): Promise<Response> {
	return guarded(c, deps, async () => {
		const tenantId = pathParameter(c, "tenant_id");
		const channelIds = [...new Set(c.req.queries("channel_id") ?? [])];
		const turnIds = [...new Set(c.req.queries("turn_id") ?? [])];
		if ((channelIds.length > 0) === (turnIds.length > 0)) {
			throw new CostQueryError("Name channels with channel_id or turns with turn_id, not both and not neither.");
		}
		const subjects = channelIds.length > 0 ? channelIds : turnIds;
		if (subjects.length < COST_COMPARE_MIN_SUBJECTS || subjects.length > COST_COMPARE_MAX_SUBJECTS) {
			throw new CostQueryError(`Compare ${COST_COMPARE_MIN_SUBJECTS} to ${COST_COMPARE_MAX_SUBJECTS} distinct subjects.`);
		}
		if (channelIds.length > 0) {
			const window = resolveWindow({}, deps.clock.now(), "lookback");
			for (const channelId of channelIds) await getChannel(tenantId, channelId, deps);
			const rows = await readCostRows(deps.costs, tenantId, monthsOfWindow(window));
			const items = channelIds.map((channelId) =>
				compareItemOf(channelId, selectRows(rows, window, { bot_id: null, channel_id: channelId, member_id: null })),
			);
			const body: CostCompareResponse = { tenant_id: tenantId, subject: "channel", items };
			return c.json(body, 200);
		}
		const items = [];
		for (const turnId of turnIds) {
			await getTurn(deps.turns, tenantId, turnId);
			const row = await readTurnRow(deps.costs, tenantId, turnId, deps.clock.now());
			items.push(compareItemOf(turnId, row === null ? [] : [row]));
		}
		const body: CostCompareResponse = { tenant_id: tenantId, subject: "turn", items };
		return c.json(body, 200);
	});
}

type ExportValue = string | number | boolean | null;

function turnExportRecord(row: IndexRow): Record<(typeof COST_EXPORT_TURN_COLUMNS)[number], ExportValue> {
	const costRow = costRowOf(row);
	return {
		id: costRow.id,
		row_kind: costRow.row_kind,
		turn_id: costRow.turn_id,
		bot_id: costRow.bot_id,
		channel_id: costRow.channel_id,
		member_id: costRow.member_id,
		prompt_message_seq: costRow.prompt_message_seq,
		message_seq: costRow.message_seq,
		owner_kind: costRow.owner_kind,
		status: costRow.status,
		source: costRow.source,
		estimated: costRow.estimated,
		recorded_at: costRow.recorded_at,
		calls: costRow.totals.calls,
		input_tokens: costRow.totals.input_tokens,
		cache_read_tokens: costRow.totals.cache_read_tokens,
		cache_write_tokens: costRow.totals.cache_write_tokens,
		output_tokens: costRow.totals.output_tokens,
		priced_cost_usd: costRow.totals.priced_cost_usd,
		cost_usd: costRow.totals.cost_usd,
		unpriced_calls: costRow.totals.unpriced_calls,
		price_book_ids: costRow.totals.price_book_ids.join(";"),
	};
}

function callExportRecord(row: IndexRow, call: CostCall): Record<(typeof COST_EXPORT_CALL_COLUMNS)[number], ExportValue> {
	return {
		turn_id: row.turnId,
		bot_id: row.botId,
		channel_id: row.channelId,
		member_id: row.memberId,
		conversation_id: call.conversation_id,
		entry_id: call.entry_id,
		kind: call.kind,
		round: call.round,
		provider: call.provider,
		model: call.model,
		response_id: call.response_id,
		input_tokens: call.input_tokens,
		cache_read_tokens: call.cache_read_tokens,
		cache_write_tokens: call.cache_write_tokens,
		output_tokens: call.output_tokens,
		reasoning_tokens: call.reasoning_tokens,
		context_tokens: call.context_tokens,
		price_book_id: call.price_book_id,
		tier: call.tier,
		priced_with: call.priced_with.join(";"),
		input_rate_per_million_usd: call.input_rate_per_million_usd,
		output_rate_per_million_usd: call.output_rate_per_million_usd,
		cost_usd: call.cost_usd,
		unpriced: call.unpriced,
		source: "session",
		estimated: false,
		recorded_at: call.recorded_at,
	};
}

function indexCallExportRecord(row: IndexRow): Record<(typeof COST_EXPORT_CALL_COLUMNS)[number], ExportValue> {
	const entry = row.models[0];
	return {
		turn_id: row.turnId,
		bot_id: row.botId,
		channel_id: row.channelId,
		member_id: row.memberId,
		conversation_id: null,
		entry_id: null,
		kind: row.rowKind,
		round: null,
		provider: null,
		model: entry?.model ?? null,
		response_id: row.callId,
		input_tokens: entry?.inputTokens ?? 0,
		cache_read_tokens: entry?.cacheReadTokens ?? 0,
		cache_write_tokens: entry?.cacheWriteTokens ?? 0,
		output_tokens: entry?.outputTokens ?? 0,
		reasoning_tokens: null,
		context_tokens: (entry?.inputTokens ?? 0) + (entry?.cacheReadTokens ?? 0) + (entry?.cacheWriteTokens ?? 0),
		price_book_id: row.priceBookId,
		tier: null,
		priced_with: null,
		input_rate_per_million_usd: null,
		output_rate_per_million_usd: null,
		cost_usd: entry?.costUsd == null ? null : plainDollars(entry.costUsd),
		unpriced: (entry?.unpricedCalls ?? 0) > 0,
		source: row.source,
		estimated: row.estimated,
		recorded_at: row.recordedAt,
	};
}

/**
 * GET /orgs/{tenant_id}/costs/export?format=csv|ndjson&grain=turn|call&from=&to=&bot_id=&channel_id=&member_id=: the rows
 * of a range as a download. The turn grain is the cost index; the call grain is one line per model call, read from the
 * sessions (a range of more than the allowed number of turns is refused). Every line carries its price book id.
 */
export async function exportCostsHandler(c: Context, deps: CostRouteDependencies): Promise<Response> {
	return guarded(c, deps, async () => {
		const tenantId = pathParameter(c, "tenant_id");
		const query = parseQuery(c);
		const url = new URL(c.req.url).searchParams;
		const format = url.get("format") ?? "csv";
		const grain = url.get("grain") ?? "turn";
		if (format !== "csv" && format !== "ndjson") throw new CostQueryError("format must be csv or ndjson.");
		if (grain !== "turn" && grain !== "call") throw new CostQueryError("grain must be turn or call.");
		const window = resolveWindow(query, deps.clock.now(), "month_to_date");
		const rows = newestFirst(await rowsOf(deps, tenantId, window, filtersOf(query)));
		const columns = grain === "turn" ? COST_EXPORT_TURN_COLUMNS : COST_EXPORT_CALL_COLUMNS;
		const records: Array<Record<string, ExportValue>> = [];
		if (grain === "turn") {
			for (const row of rows) records.push(turnExportRecord(row));
		} else {
			const turnRows = rows.filter((row) => row.rowKind === "turn");
			if (turnRows.length > COST_EXPORT_CALL_GRAIN_MAX_TURNS) {
				return c.json(
					{
						error: "export_too_large",
						message: `A call-grain export reads at most ${COST_EXPORT_CALL_GRAIN_MAX_TURNS} turns; narrow the date range or filters.`,
					},
					422,
				);
			}
			for (const row of rows) {
				if (row.rowKind !== "turn") {
					records.push(indexCallExportRecord(row));
					continue;
				}
				const calls =
					row.botId === null || row.channelId === null || row.turnId === null
						? null
						: await readTurnCalls(deps.listing, tenantId, row.botId, row.channelId, row.turnId);
				for (const call of calls ?? []) records.push(callExportRecord(row, call));
			}
		}
		const priceBookIds = [...new Set(rows.map((row) => row.priceBookId).filter((id): id is string => id !== null))].sort();
		const body =
			format === "csv"
				? csvLine(columns) + records.map((record) => csvLine(columns.map((column) => record[column] ?? null))).join("")
				: records.map((record) => `${JSON.stringify(record)}\n`).join("");
		return new Response(body, {
			status: 200,
			headers: {
				"Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
				"Content-Disposition": `attachment; filename="costs-${window.from}-${window.to}-${grain}.${format}"`,
				"X-Cost-Price-Book-Ids": priceBookIds.join(","),
			},
		});
	});
}
