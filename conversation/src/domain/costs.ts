import { type AttributeValue, type DynamoDBClient, GetItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import {
	COST_LOOKBACK_MONTHS,
	type CostCall,
	type CostCompareItem,
	type CostFilters,
	type CostGroup,
	type CostGroupBy,
	type CostMetrics,
	type CostModelBreakdown,
	type CostRow,
	type CostRowKind,
	type CostTotals,
} from "@chatticus/host-protocol/costs";
import { Decimal } from "../budget/decimal.ts";
import { COST_SOURCE_GATEWAY, } from "../ledger/gateway-observation.ts";
import { type ModelCallCost, readCallCostRecords } from "../ledger/call-cost.ts";
import { costIndexPartitionOf } from "../ledger/turn-cost.ts";
import type { ChannelListingDependencies } from "../pi/channel-listing.ts";
import { IndexedStorage } from "../storage/indexed-storage.ts";
import { storageIdFor } from "../storage/storage-support.ts";

type Item = Record<string, AttributeValue>;

/** Where the cost index lives: the messaging table. */
export type CostReadDependencies = {
	readonly client: DynamoDBClient;
	readonly tableName: string;
};

/** A request the cost routes refuse because of what the caller asked for. */
export class CostQueryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CostQueryError";
	}
}

/** The tokens and dollars of the calls of one model inside one row. `costUsd` is null when any of those calls has no price. */
export type ModelEntry = {
	readonly model: string;
	readonly calls: number;
	readonly inputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly outputTokens: number;
	readonly costUsd: Decimal | null;
	readonly unpricedCalls: number;
};

/** One item of the cost index, parsed. */
export type IndexRow = {
	readonly id: string;
	readonly rowKind: CostRowKind;
	readonly turnId: string | null;
	readonly botId: string | null;
	readonly channelId: string | null;
	readonly memberId: string | null;
	readonly promptMessageSeq: number | null;
	readonly messageSeq: number | null;
	readonly ownerKind: string | null;
	readonly status: string | null;
	readonly source: "session" | "gateway";
	readonly estimated: boolean;
	readonly recordedAt: string;
	readonly updatedAt: string | null;
	readonly priceBookId: string | null;
	readonly callId: string | null;
	readonly responseIds: readonly string[];
	readonly models: readonly ModelEntry[];
};

/**
 * Dollars as plain decimal text without trailing zeros in the fraction, so the same amount is always the same text whatever
 * scale the additions that produced it had (0.00030 and 0.0003 are both 0.0003).
 */
export function plainDollars(amount: Decimal): string {
	const text = amount.toString();
	return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

const OPEN_STATUSES = new Set(["running", "yielded", "parked"]);

const optionalText = (item: Item, name: string): string | null => item[name]?.S ?? null;
const optionalInteger = (item: Item, name: string): number | null => (item[name]?.N === undefined ? null : Number(item[name]!.N));
const integerOrZero = (value: AttributeValue | undefined): number => (value?.N === undefined ? 0 : Number(value.N));

function sessionModelEntries(item: Item): ModelEntry[] {
	const byModel = item.by_model?.M ?? {};
	return Object.entries(byModel).map(([model, subtotal]) => {
		const fields = subtotal.M ?? {};
		return {
			model,
			calls: integerOrZero(fields.calls),
			inputTokens: integerOrZero(fields.input_tokens),
			cacheReadTokens: integerOrZero(fields.cache_read_tokens),
			cacheWriteTokens: integerOrZero(fields.cache_write_tokens),
			outputTokens: integerOrZero(fields.output_tokens),
			costUsd: fields.cost_usd?.N === undefined ? null : Decimal.parse(fields.cost_usd.N),
			unpricedCalls: integerOrZero(fields.unpriced_calls),
		};
	});
}

function gatewayModelEntries(item: Item): ModelEntry[] {
	const cached = integerOrZero(item.cached_input_tokens);
	const unpriced = integerOrZero(item.unpriced_calls);
	return [
		{
			model: item.model?.S ?? "unknown",
			calls: 1,
			inputTokens: Math.max(0, integerOrZero(item.input_tokens) - cached),
			cacheReadTokens: cached,
			cacheWriteTokens: 0,
			outputTokens: integerOrZero(item.output_tokens),
			costUsd: item.cost_usd?.N === undefined || unpriced > 0 ? null : Decimal.parse(item.cost_usd.N),
			unpricedCalls: unpriced,
		},
	];
}

/** Parse one item of a cost index partition. */
export function indexRowOf(item: Item): IndexRow {
	const id = item.sk!.S!;
	const gateway = id.startsWith("gateway#");
	const rowKind: CostRowKind = gateway ? "gateway_call" : item.kind?.S === "voice_understanding" ? "voice_understanding" : "turn";
	return {
		id,
		rowKind,
		turnId: optionalText(item, "turn_id"),
		botId: optionalText(item, "bot_id"),
		channelId: optionalText(item, "channel_id"),
		memberId: optionalText(item, "prompt_author_id"),
		promptMessageSeq: optionalInteger(item, "prompt_message_seq"),
		messageSeq: optionalInteger(item, "message_seq"),
		ownerKind: optionalText(item, "owner_kind"),
		status: optionalText(item, "status"),
		source: item.source?.S === COST_SOURCE_GATEWAY ? "gateway" : "session",
		estimated: item.estimated?.BOOL ?? false,
		recordedAt: item.recorded_at!.S!,
		updatedAt: optionalText(item, "updated_at"),
		priceBookId: optionalText(item, "price_book_id"),
		callId: optionalText(item, "call_id"),
		responseIds: [...(item.response_ids?.SS ?? [])],
		models: gateway ? gatewayModelEntries(item) : sessionModelEntries(item),
	};
}

/**
 * Read every row of the cost index in the given months: one consistent query per month partition, no scan. A gateway row
 * whose call a session row of the same months already lists among its response ids is the same call and is dropped, the
 * rule the daily rollup applies, so no call is counted twice.
 *
 * @param deps The messaging table.
 * @param tenantId The organization.
 * @param months The months as `yyyy-mm`.
 * @returns The rows of every month, unordered.
 */
export async function readCostRows(deps: CostReadDependencies, tenantId: string, months: readonly string[]): Promise<IndexRow[]> {
	const pages = await Promise.all(months.map((month) => readMonth(deps, tenantId, month)));
	return withoutAccountedGatewayRows(pages.flat());
}

/**
 * Drop each gateway row whose call a session row already lists among its response ids: it is the same call, and the
 * session's record is the cost. This is the rule the daily rollup applies, and it holds whether or not the reconciliation
 * has deleted the gateway row yet.
 */
export function withoutAccountedGatewayRows(rows: readonly IndexRow[]): IndexRow[] {
	const accounted = new Set(rows.filter((row) => row.source !== "gateway").flatMap((row) => row.responseIds));
	return rows.filter((row) => !(row.source === "gateway" && row.callId !== null && accounted.has(row.callId)));
}

async function readMonth(deps: CostReadDependencies, tenantId: string, month: string): Promise<IndexRow[]> {
	const rows: IndexRow[] = [];
	let startKey: Record<string, AttributeValue> | undefined;
	do {
		const page = await deps.client.send(
			new QueryCommand({
				TableName: deps.tableName,
				KeyConditionExpression: "pk = :pk",
				ExpressionAttributeValues: { ":pk": { S: costIndexPartitionOf(tenantId, month) } },
				ConsistentRead: true,
				ExclusiveStartKey: startKey,
			}),
		);
		for (const item of page.Items ?? []) rows.push(indexRowOf(item));
		startKey = page.LastEvaluatedKey;
	} while (startKey !== undefined);
	return rows;
}

/**
 * The index row of one turn. The turn's month is not known to the caller, so the current month and then earlier ones are
 * probed with point reads, no further back than the cost routes read.
 */
export async function readTurnRow(deps: CostReadDependencies, tenantId: string, turnId: string, now: Date): Promise<IndexRow | null> {
	for (const month of monthsEndingAt(now, COST_LOOKBACK_MONTHS)) {
		const found = await deps.client.send(
			new GetItemCommand({
				TableName: deps.tableName,
				Key: { pk: { S: costIndexPartitionOf(tenantId, month) }, sk: { S: `turn#${turnId}` } },
				ConsistentRead: true,
			}),
		);
		if (found.Item !== undefined) return indexRowOf(found.Item);
	}
	return null;
}

const monthOf = (date: Date): string => date.toISOString().slice(0, 7);

/** The `count` months ending at the month of `now`, newest first. */
export function monthsEndingAt(now: Date, count: number): string[] {
	const months: string[] = [];
	for (let back = 0; back < count; back += 1) {
		months.push(monthOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))));
	}
	return months;
}

/** A date range of whole UTC days, both ends included. */
export type CostWindow = { readonly from: string; readonly to: string };

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validDay(day: string, name: string): string {
	const parsed = new Date(`${day}T00:00:00Z`);
	if (!DAY_PATTERN.test(day) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
		throw new CostQueryError(`${name} must be a calendar day written yyyy-mm-dd.`);
	}
	return day;
}

/**
 * Resolve the date range of a request. With neither end, `default_window` decides: the month so far for a rollup, the
 * whole lookback for a channel or a message, which are all-time totals. A range may not start before the lookback.
 */
export function resolveWindow(
	query: { from?: string | undefined; to?: string | undefined },
	now: Date,
	defaultWindow: "month_to_date" | "lookback",
): CostWindow {
	const today = now.toISOString().slice(0, 10);
	const lookbackStart = `${monthsEndingAt(now, COST_LOOKBACK_MONTHS).at(-1)!}-01`;
	const monthStartOf = (day: string): string => `${day.slice(0, 7)}-01`;
	const to = query.to === undefined ? today : validDay(query.to, "to");
	const from =
		query.from === undefined
			? defaultWindow === "lookback"
				? lookbackStart
				: monthStartOf(to)
			: validDay(query.from, "from");
	if (from > to) throw new CostQueryError("from must not be after to.");
	if (from < lookbackStart) throw new CostQueryError(`from must not be before ${lookbackStart}, the ${COST_LOOKBACK_MONTHS} months the cost routes read.`);
	return { from, to };
}

/** The months a window touches as `yyyy-mm`, oldest first. */
export function monthsOfWindow(window: CostWindow): string[] {
	const months: string[] = [];
	let year = Number(window.from.slice(0, 4));
	let month = Number(window.from.slice(5, 7));
	const last = window.to.slice(0, 7);
	for (;;) {
		const label = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
		months.push(label);
		if (label >= last) return months;
		month += 1;
		if (month > 12) {
			month = 1;
			year += 1;
		}
	}
}

/** The rows of the window that match the filters. */
export function selectRows(rows: readonly IndexRow[], window: CostWindow, filters: CostFilters): IndexRow[] {
	return rows.filter((row) => {
		const day = row.recordedAt.slice(0, 10);
		if (day < window.from || day > window.to) return false;
		if (filters.bot_id !== null && row.botId !== filters.bot_id) return false;
		if (filters.channel_id !== null && row.channelId !== filters.channel_id) return false;
		if (filters.member_id !== null && row.memberId !== filters.member_id) return false;
		return true;
	});
}

type ModelAccumulator = {
	calls: number;
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	outputTokens: number;
	pricedCostUsd: Decimal;
	unpricedCalls: number;
};

/** Adds up rows, or the slice of rows that one model served, into the totals every level of the API uses. */
export class CostAccumulator {
	private rows = 0;
	private turns = 0;
	private gatewayRows = 0;
	private estimatedRows = 0;
	private openTurns = 0;
	private readonly priceBookIds = new Set<string>();
	private readonly byModel = new Map<string, ModelAccumulator>();

	/** Count a row and every model of it. */
	addRow(row: IndexRow): void {
		this.countRow(row);
		for (const entry of row.models) this.addEntry(entry);
	}

	/** Count a row once and only the calls of one model in it. */
	addModelSlice(row: IndexRow, entry: ModelEntry): void {
		this.countRow(row);
		this.addEntry(entry);
	}

	private countRow(row: IndexRow): void {
		this.rows += 1;
		if (row.rowKind === "turn") this.turns += 1;
		if (row.source === "gateway") this.gatewayRows += 1;
		if (row.estimated) this.estimatedRows += 1;
		if (row.rowKind === "turn" && row.status !== null && OPEN_STATUSES.has(row.status)) this.openTurns += 1;
		if (row.priceBookId !== null) this.priceBookIds.add(row.priceBookId);
	}

	private addEntry(entry: ModelEntry): void {
		const total = this.byModel.get(entry.model) ?? {
			calls: 0,
			inputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			outputTokens: 0,
			pricedCostUsd: Decimal.zero(),
			unpricedCalls: 0,
		};
		total.calls += entry.calls;
		total.inputTokens += entry.inputTokens;
		total.cacheReadTokens += entry.cacheReadTokens;
		total.cacheWriteTokens += entry.cacheWriteTokens;
		total.outputTokens += entry.outputTokens;
		total.unpricedCalls += entry.unpricedCalls;
		if (entry.costUsd !== null) total.pricedCostUsd = total.pricedCostUsd.add(entry.costUsd);
		this.byModel.set(entry.model, total);
	}

	/** The totals of everything added so far. */
	totals(): CostTotals {
		const models: CostModelBreakdown[] = [...this.byModel.entries()]
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([model, total]) => ({
				model,
				calls: total.calls,
				input_tokens: total.inputTokens,
				cache_read_tokens: total.cacheReadTokens,
				cache_write_tokens: total.cacheWriteTokens,
				output_tokens: total.outputTokens,
				priced_cost_usd: plainDollars(total.pricedCostUsd),
				unpriced_calls: total.unpricedCalls,
			}));
		let priced = Decimal.zero();
		const sum = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, unpriced: 0 };
		for (const total of this.byModel.values()) {
			priced = priced.add(total.pricedCostUsd);
			sum.calls += total.calls;
			sum.input += total.inputTokens;
			sum.cacheRead += total.cacheReadTokens;
			sum.cacheWrite += total.cacheWriteTokens;
			sum.output += total.outputTokens;
			sum.unpriced += total.unpricedCalls;
		}
		return {
			rows: this.rows,
			turns: this.turns,
			calls: sum.calls,
			input_tokens: sum.input,
			cache_read_tokens: sum.cacheRead,
			cache_write_tokens: sum.cacheWrite,
			output_tokens: sum.output,
			priced_cost_usd: plainDollars(priced),
			cost_usd: sum.unpriced > 0 ? null : plainDollars(priced),
			unpriced_calls: sum.unpriced,
			complete: sum.unpriced === 0,
			gateway_rows: this.gatewayRows,
			estimated_rows: this.estimatedRows,
			open_turns: this.openTurns,
			price_book_ids: [...this.priceBookIds].sort(),
			by_model: models,
		};
	}
}

/** The totals of a set of rows. */
export function totalsOf(rows: readonly IndexRow[]): CostTotals {
	const accumulator = new CostAccumulator();
	for (const row of rows) accumulator.addRow(row);
	return accumulator.totals();
}

/** One row as the API renders it, with its own totals. */
export function costRowOf(row: IndexRow): CostRow {
	return {
		id: row.id,
		row_kind: row.rowKind,
		turn_id: row.turnId,
		bot_id: row.botId,
		channel_id: row.channelId,
		member_id: row.memberId,
		prompt_message_seq: row.promptMessageSeq,
		message_seq: row.messageSeq,
		owner_kind: row.ownerKind,
		status: row.status,
		source: row.source,
		estimated: row.estimated,
		recorded_at: row.recordedAt,
		updated_at: row.updatedAt,
		totals: totalsOf([row]),
	};
}

/** The key a row has under a grouping; null when the row does not carry the dimension. */
function groupKeyOf(row: IndexRow, groupBy: Exclude<CostGroupBy, "model">): string | null {
	switch (groupBy) {
		case "bot":
			return row.botId;
		case "channel":
			return row.channelId;
		case "member":
			return row.memberId;
		case "day":
			return row.recordedAt.slice(0, 10);
		case "month":
			return row.recordedAt.slice(0, 7);
	}
}

/**
 * Group rows by a dimension. Every row lands in exactly one group (those without the dimension in the null group), so the
 * groups add up to the totals of the rows. Grouping by model splits a row by the models that served its calls, so a row
 * with two models is in two groups, and the dollars and calls still add up exactly; only the row counts overlap.
 *
 * @returns The groups ordered by key, the null group last.
 */
export function groupRows(rows: readonly IndexRow[], groupBy: CostGroupBy): CostGroup[] {
	const groups = new Map<string | null, CostAccumulator>();
	const accumulatorOf = (key: string | null): CostAccumulator => {
		let found = groups.get(key);
		if (found === undefined) {
			found = new CostAccumulator();
			groups.set(key, found);
		}
		return found;
	};
	for (const row of rows) {
		if (groupBy === "model") {
			for (const entry of row.models) accumulatorOf(entry.model).addModelSlice(row, entry);
		} else {
			accumulatorOf(groupKeyOf(row, groupBy)).addRow(row);
		}
	}
	return [...groups.entries()]
		.sort(([left], [right]) => compareKeys(left, right))
		.map(([key, accumulator]) => ({ key, totals: accumulator.totals() }));
}

const compareKeys = (left: string | null, right: string | null): number => {
	if (left === right) return 0;
	if (left === null) return 1;
	if (right === null) return -1;
	return left < right ? -1 : 1;
};

/** Order rows newest first; ties break on the row id so the order is total. */
export function newestFirst(rows: readonly IndexRow[]): IndexRow[] {
	return [...rows].sort((left, right) => (left.recordedAt === right.recordedAt ? compareKeys(right.id, left.id) : left.recordedAt < right.recordedAt ? 1 : -1));
}

const encodeCursor = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

function decodeCursor(cursor: string): unknown {
	try {
		return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
	} catch {
		throw new CostQueryError("cursor is not one this route issued.");
	}
}

/** One page of rows (newest first) after the cursor, and the cursor of the next page or null at the end. */
export function pageOfRows(ordered: readonly IndexRow[], limit: number, cursor: string | undefined): { page: IndexRow[]; next: string | null } {
	let start = 0;
	if (cursor !== undefined) {
		const decoded = decodeCursor(cursor);
		if (!Array.isArray(decoded) || typeof decoded[0] !== "string" || typeof decoded[1] !== "string") {
			throw new CostQueryError("cursor is not one this route issued.");
		}
		const [recordedAt, id] = decoded as [string, string];
		start = ordered.findIndex((row) => row.recordedAt < recordedAt || (row.recordedAt === recordedAt && compareKeys(row.id, id) < 0));
		if (start === -1) start = ordered.length;
	}
	const page = ordered.slice(start, start + limit);
	const last = page.at(-1);
	const next = start + limit < ordered.length && last !== undefined ? encodeCursor([last.recordedAt, last.id]) : null;
	return { page, next };
}

/** One page of groups (ordered by key) after the cursor, and the cursor of the next page or null at the end. */
export function pageOfGroups(ordered: readonly CostGroup[], limit: number, cursor: string | undefined): { page: CostGroup[]; next: string | null } {
	let start = 0;
	if (cursor !== undefined) {
		const decoded = decodeCursor(cursor);
		if (!Array.isArray(decoded) || !(decoded[0] === null || typeof decoded[0] === "string")) {
			throw new CostQueryError("cursor is not one this route issued.");
		}
		const after = decoded[0] as string | null;
		start = ordered.findIndex((group) => compareKeys(group.key, after) > 0);
		if (start === -1) start = ordered.length;
	}
	const page = ordered.slice(start, start + limit);
	const last = page.at(-1);
	const next = start + limit < ordered.length && last !== undefined ? encodeCursor([last.key]) : null;
	return { page, next };
}

/** Divide dollars by a count, rounded half up to six more digits than the dollars have. */
function dividedDollars(dollars: Decimal, count: number): string {
	const extra = 6;
	const numerator = dollars.units * 10n ** BigInt(extra) * 2n + BigInt(count);
	const quotient = numerator / (BigInt(count) * 2n);
	return plainDollars(Decimal.parse(quotient.toString()).divideByPowerOfTen(dollars.scale + extra));
}

/** The normalized figures of a comparison; a figure whose denominator is zero, or whose total is not known, is null. */
export function metricsOf(totals: CostTotals): CostMetrics {
	const priced = Decimal.parse(totals.priced_cost_usd);
	const context = totals.input_tokens + totals.cache_read_tokens + totals.cache_write_tokens;
	return {
		turns: totals.turns,
		cost_per_turn_usd: totals.complete && totals.turns > 0 ? dividedDollars(priced, totals.turns) : null,
		cost_per_call_usd: totals.complete && totals.calls > 0 ? dividedDollars(priced, totals.calls) : null,
		calls_per_turn: totals.turns > 0 ? totals.calls / totals.turns : null,
		cached_input_ratio: context > 0 ? totals.cache_read_tokens / context : null,
	};
}

/** One subject of a comparison from its rows. */
export function compareItemOf(id: string, rows: readonly IndexRow[]): CostCompareItem {
	const totals = totalsOf(rows);
	return { id, totals, metrics: metricsOf(totals) };
}

/** One session cost record as the API renders a call. */
export function costCallOf(record: ModelCallCost): CostCall {
	return {
		conversation_id: record.conversationId,
		entry_id: record.entryId,
		kind: record.kind,
		round: record.round,
		provider: record.provider,
		model: record.model,
		response_id: record.responseId,
		input_tokens: record.inputTokens,
		cache_read_tokens: record.cacheReadTokens,
		cache_write_tokens: record.cacheWriteTokens,
		output_tokens: record.outputTokens,
		reasoning_tokens: record.reasoningTokens,
		context_tokens: record.contextTokens,
		price_book_id: record.priceBookId,
		tier: record.tier,
		priced_with: [...record.pricedWith],
		input_rate_per_million_usd: record.inputRatePerMillionUsd === null ? null : plainDollars(Decimal.parse(record.inputRatePerMillionUsd)),
		output_rate_per_million_usd: record.outputRatePerMillionUsd === null ? null : plainDollars(Decimal.parse(record.outputRatePerMillionUsd)),
		cost_usd: record.costUsd === null ? null : plainDollars(Decimal.parse(record.costUsd)),
		unpriced: record.unpriced,
		recorded_at: record.recordedAt,
	};
}

/**
 * The call records of one turn, read from the bot's session for the channel without owning or creating it.
 *
 * @returns The calls oldest first, or null when the session does not exist.
 */
export async function readTurnCalls(
	listing: ChannelListingDependencies,
	tenantId: string,
	botId: string,
	channelId: string,
	turnId: string,
): Promise<CostCall[] | null> {
	const storage = await IndexedStorage.openExisting({
		client: listing.client,
		s3: listing.s3,
		tableName: listing.conversationsTableName,
		bucket: listing.bucket,
		storageId: storageIdFor(tenantId, botId, channelId),
		commitCache: listing.commitCache,
	});
	if (storage === undefined) return null;
	try {
		const records = await readCallCostRecords(createSession(storage), storage, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
		return records.filter((record) => record.turnId === turnId).map(costCallOf);
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
	}
}

const csvField = (value: string | number | boolean | null): string => {
	if (value === null) return "";
	const text = String(value);
	return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** One line of CSV from values already in column order. */
export const csvLine = (values: ReadonlyArray<string | number | boolean | null>): string => `${values.map(csvField).join(",")}\r\n`;
