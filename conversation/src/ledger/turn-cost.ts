import {
	type AttributeValue,
	TransactionCanceledException,
	TransactWriteItemsCommand,
	type TransactWriteItem,
} from "@aws-sdk/client-dynamodb";
import { vendorLedgerKey } from "../budget/budget-store.ts";
import { Decimal } from "../budget/decimal.ts";
import { BILLED_VIA_VENDOR } from "../budget/models.ts";
import { retryTransient } from "../store/transient-retry.ts";
import type { ModelCallCost } from "./call-cost.ts";
import type { VendorLedgerDependencies } from "./vendor-ledger.ts";

type Item = Record<string, AttributeValue>;

/** The partition of the cost index of one calendar month: `{tenant}#cost#{yyyy-mm}`. */
export const costIndexPartitionOf = (tenantId: string, month: string): string => `${tenantId}#cost#${month}`;

/** The prefix of the id a voice understanding call carries where a turn id would be. */
export const VOICE_COST_ROW_PREFIX = "voice:";

/** Whether a cost row id names a voice understanding call and not a turn. */
export const isVoiceCostRowId = (rowId: string): boolean => rowId.startsWith(VOICE_COST_ROW_PREFIX);

/** The turn index item of a turn, or the voice index item of a voice understanding call: `turn#{id}` or `voice#{uuid}`. */
export const costTurnIndexKey = (tenantId: string, month: string, rowId: string): { pk: string; sk: string } => ({
	pk: costIndexPartitionOf(tenantId, month),
	sk: isVoiceCostRowId(rowId) ? `voice#${rowId.slice(VOICE_COST_ROW_PREFIX.length)}` : `turn#${rowId}`,
});

/** Which kind of owner wrote the projection; the last writer of a turn names itself. */
export type TurnCostOwnerKind = "lambda" | "computer";

/** Where the turn stood when its cost was last written. */
export type TurnCostStatus = "running" | "yielded" | "parked" | "completed" | "failed";

/** The tokens and dollars of the calls of one model within a turn. */
export type ModelCostSubtotal = {
	readonly inputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly outputTokens: number;
	readonly costUsd: Decimal | null;
	readonly unpricedCalls: number;
	readonly calls: number;
};

/** A turn's cost as the sum of its call records: the only thing the ledger row and the turn index are written from. */
export type TurnCostSummary = {
	readonly recordCount: number;
	readonly vendor: string;
	readonly model: string;
	readonly inputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly outputTokens: number;
	readonly contextInputTokens: number;
	readonly costUsd: Decimal | null;
	readonly unpricedCalls: number;
	readonly models: readonly string[];
	readonly pricedWith: readonly string[];
	readonly priceBookId: string;
	readonly inputRatePerMillionUsd: Decimal | null;
	readonly outputRatePerMillionUsd: Decimal | null;
	readonly firstRecordedAt: string;
	readonly byModel: ReadonlyMap<string, ModelCostSubtotal>;
	/**
	 * The provider response ids of the records that carry tokens. A gateway observation of the same response is the same
	 * call and is never counted again. A record without tokens (an aborted or errored response) lists nothing, because it
	 * does not account for what the vendor billed.
	 */
	readonly responseIds: readonly string[];
	/** Context input and output tokens of the compaction records, which carry no response id; they absorb the gateway observations of summarization calls. */
	readonly compactionContextTokens: number;
	readonly compactionOutputTokens: number;
};

/**
 * Sum the cost records of one turn. A turn with an unpriced call has unknown dollars (null) rather than the sum of the
 * priced part, so a partial figure is never shown as complete. The turn's `model` and frozen rates are those of its first
 * call; `models` lists every model that served a call.
 *
 * @param records The filled cost records of the turn.
 * @returns The summary, or null when the turn has no record.
 */
export function summarizeTurnCost(records: readonly ModelCallCost[]): TurnCostSummary | null {
	const ordered = [...records].sort((left, right) => left.entryId - right.entryId);
	const first = ordered[0];
	if (first === undefined) return null;
	let total = Decimal.zero();
	let unpricedCalls = 0;
	let inputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let outputTokens = 0;
	const labels = new Set<string>();
	const models = new Set<string>();
	const responseIds = new Set<string>();
	let compactionContextTokens = 0;
	let compactionOutputTokens = 0;
	const subtotals = new Map<string, { -readonly [Key in keyof ModelCostSubtotal]: ModelCostSubtotal[Key] }>();
	for (const record of ordered) {
		inputTokens += record.inputTokens;
		cacheReadTokens += record.cacheReadTokens;
		cacheWriteTokens += record.cacheWriteTokens;
		outputTokens += record.outputTokens;
		models.add(record.model);
		const recordTokens = record.contextTokens + record.outputTokens;
		if (record.responseId !== null && recordTokens > 0) responseIds.add(record.responseId);
		if (record.kind === "compaction") {
			compactionContextTokens += record.contextTokens;
			compactionOutputTokens += record.outputTokens;
		}
		for (const label of record.pricedWith) labels.add(label);
		const subtotal = subtotals.get(record.model) ?? {
			inputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			outputTokens: 0,
			costUsd: Decimal.zero(),
			unpricedCalls: 0,
			calls: 0,
		};
		subtotal.inputTokens += record.inputTokens;
		subtotal.cacheReadTokens += record.cacheReadTokens;
		subtotal.cacheWriteTokens += record.cacheWriteTokens;
		subtotal.outputTokens += record.outputTokens;
		subtotal.calls += 1;
		if (record.costUsd === null) {
			unpricedCalls += 1;
			subtotal.unpricedCalls += 1;
			subtotal.costUsd = null;
		} else {
			const cost = Decimal.parse(record.costUsd);
			total = total.add(cost);
			if (subtotal.costUsd !== null) subtotal.costUsd = subtotal.costUsd.add(cost);
		}
		subtotals.set(record.model, subtotal);
	}
	const hasTokens = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens > 0;
	return {
		recordCount: ordered.length,
		vendor: first.provider,
		model: first.model,
		inputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		outputTokens,
		contextInputTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
		costUsd: unpricedCalls > 0 || !hasTokens ? null : total,
		unpricedCalls,
		models: [...models].sort(),
		pricedWith: [...labels].sort(),
		priceBookId: first.priceBookId,
		inputRatePerMillionUsd: first.inputRatePerMillionUsd === null ? null : Decimal.parse(first.inputRatePerMillionUsd),
		outputRatePerMillionUsd: first.outputRatePerMillionUsd === null ? null : Decimal.parse(first.outputRatePerMillionUsd),
		firstRecordedAt: ordered.map((record) => record.recordedAt).sort()[0]!,
		byModel: subtotals,
		responseIds: [...responseIds].sort(),
		compactionContextTokens,
		compactionOutputTokens,
	};
}

/** What the turn index records about a turn beside its cost. */
export type TurnCostDimensions = {
	readonly tenantId: string;
	readonly turnId: string;
	readonly kind: "turn" | "voice_understanding";
	readonly botId: string | null;
	readonly channelId: string;
	readonly promptAuthorId: string | null;
	readonly promptMessageSeq: number | null;
	readonly messageSeq: number | null;
	readonly ownerKind: TurnCostOwnerKind;
	readonly status: TurnCostStatus;
};

/** The `source` of a row written from the session's cost records; the other source is `gateway`. */
export const COST_SOURCE_SESSION = "session";

const text = (value: string): AttributeValue => ({ S: value });
const number = (value: number): AttributeValue => ({ N: String(value) });

function subtotalAttribute(subtotal: ModelCostSubtotal): AttributeValue {
	const fields: Record<string, AttributeValue> = {
		input_tokens: number(subtotal.inputTokens),
		cache_read_tokens: number(subtotal.cacheReadTokens),
		cache_write_tokens: number(subtotal.cacheWriteTokens),
		output_tokens: number(subtotal.outputTokens),
		unpriced_calls: number(subtotal.unpricedCalls),
		calls: number(subtotal.calls),
	};
	if (subtotal.costUsd !== null) fields.cost_usd = { N: subtotal.costUsd.toString() };
	return { M: fields };
}

type Assignments = { readonly values: Item; readonly set: string[]; readonly remove: string[] };

function assignment(): Assignments & { put(name: string, value: AttributeValue | null): void } {
	const values: Item = {};
	const set: string[] = [];
	const remove: string[] = [];
	return {
		values,
		set,
		remove,
		put(name, value) {
			if (value === null) {
				remove.push(`#${name}`);
				return;
			}
			values[`:${name}`] = value;
			set.push(`#${name} = :${name}`);
		},
	};
}

const updateOf = (
	assignments: Assignments,
): { UpdateExpression: string; ExpressionAttributeValues: Item; ExpressionAttributeNames: Record<string, string> } => {
	const names: Record<string, string> = {};
	for (const reference of [...assignments.set.map((clause) => clause.split(" ")[0]!), ...assignments.remove]) {
		names[reference] = reference.slice(1);
	}
	return {
		UpdateExpression: `SET ${assignments.set.join(", ")}${assignments.remove.length === 0 ? "" : ` REMOVE ${assignments.remove.join(", ")}`}`,
		ExpressionAttributeValues: assignments.values,
		ExpressionAttributeNames: { ...names, "#record_count": "record_count" },
	};
};

function ledgerRowAssignments(dimensions: TurnCostDimensions, summary: TurnCostSummary, now: string): Assignments {
	const row = assignment();
	row.put("tenant_id", text(dimensions.tenantId));
	row.put("turn_id", text(dimensions.turnId));
	row.put("vendor", text(summary.vendor));
	row.put("model", text(summary.model));
	row.put("input_tokens", number(summary.contextInputTokens));
	row.put("output_tokens", number(summary.outputTokens));
	row.put("billed_via", text(BILLED_VIA_VENDOR));
	row.put("recorded_at", text(summary.firstRecordedAt || now));
	row.put("price_book_id", text(summary.priceBookId));
	row.put("models", { SS: [...summary.models] });
	row.put("unpriced_calls", number(summary.unpricedCalls));
	row.put("priced_with", summary.pricedWith.length === 0 ? null : { SS: [...summary.pricedWith] });
	row.put("cost_usd", summary.costUsd === null ? null : { N: summary.costUsd.toString() });
	row.put("input_price_per_million_usd", summary.inputRatePerMillionUsd === null ? null : { N: summary.inputRatePerMillionUsd.toString() });
	row.put("output_price_per_million_usd", summary.outputRatePerMillionUsd === null ? null : { N: summary.outputRatePerMillionUsd.toString() });
	row.put("record_count", number(summary.recordCount));
	row.put("source", text(COST_SOURCE_SESSION));
	row.put("response_ids", summary.responseIds.length === 0 ? null : { SS: [...summary.responseIds] });
	row.put("compaction_context_tokens", number(summary.compactionContextTokens));
	row.put("compaction_output_tokens", number(summary.compactionOutputTokens));
	return row;
}

function turnIndexAssignments(dimensions: TurnCostDimensions, summary: TurnCostSummary, now: string): Assignments {
	const row = assignment();
	row.put("tenant_id", text(dimensions.tenantId));
	row.put("turn_id", text(dimensions.turnId));
	row.put("kind", text(dimensions.kind));
	row.put("bot_id", dimensions.botId === null ? null : text(dimensions.botId));
	row.put("channel_id", text(dimensions.channelId));
	row.put("prompt_author_id", dimensions.promptAuthorId === null ? null : text(dimensions.promptAuthorId));
	row.put("prompt_message_seq", dimensions.promptMessageSeq === null ? null : number(dimensions.promptMessageSeq));
	row.put("message_seq", dimensions.messageSeq === null ? null : number(dimensions.messageSeq));
	row.put("owner_kind", text(dimensions.ownerKind));
	row.put("status", text(dimensions.status));
	row.put("input_tokens", number(summary.inputTokens));
	row.put("cache_read_tokens", number(summary.cacheReadTokens));
	row.put("cache_write_tokens", number(summary.cacheWriteTokens));
	row.put("output_tokens", number(summary.outputTokens));
	row.put("by_model", {
		M: Object.fromEntries([...summary.byModel].map(([model, subtotal]) => [model, subtotalAttribute(subtotal)])),
	});
	row.put("price_book_id", text(summary.priceBookId));
	row.put("cost_usd", summary.costUsd === null ? null : { N: summary.costUsd.toString() });
	row.put("unpriced_calls", number(summary.unpricedCalls));
	row.put("record_count", number(summary.recordCount));
	row.put("source", text(COST_SOURCE_SESSION));
	row.put("response_ids", summary.responseIds.length === 0 ? null : { SS: [...summary.responseIds] });
	row.put("recorded_at", text(summary.firstRecordedAt || now));
	row.put("updated_at", text(now));
	return row;
}

const GUARD = "attribute_not_exists(#record_count) OR #record_count <= :recordCount";

/**
 * Write a turn's cost, summed from its call records, to the two rows the rest of the system reads: the vendor ledger row
 * the operator rollup and budget alerts sum, and the turn index item that carries the turn's dimensions. Both are written
 * in one transaction from the same summary, as absolute totals rather than additions, so writing the same records again
 * writes the same figures. A write that would replace a row with fewer records than it already holds (a slower, older
 * owner) is refused by the row's `record_count`, so the rows only ever grow toward the session's truth.
 *
 * @param deps Table, prices and clock.
 * @param dimensions The turn and what to attribute it to.
 * @param summary The sum of the turn's call records.
 * @returns Whether the rows were written; false when they already held at least as many records.
 */
export async function projectTurnCost(
	deps: VendorLedgerDependencies,
	dimensions: TurnCostDimensions,
	summary: TurnCostSummary,
): Promise<boolean> {
	const now = deps.now().toISOString();
	const ledgerKey = vendorLedgerKey(dimensions.tenantId, dimensions.turnId);
	const indexKey = costTurnIndexKey(dimensions.tenantId, (summary.firstRecordedAt || now).slice(0, 7), dimensions.turnId);
	const ledger = ledgerRowAssignments(dimensions, summary, now);
	const index = turnIndexAssignments(dimensions, summary, now);
	const guard = { ":recordCount": number(summary.recordCount) };
	const items: TransactWriteItem[] = [
		{
			Update: {
				TableName: deps.tableName,
				Key: { pk: text(ledgerKey.pk), sk: text(ledgerKey.sk) },
				ConditionExpression: GUARD,
				...updateOf({ ...ledger, values: { ...ledger.values, ...guard } }),
			},
		},
		{
			Update: {
				TableName: deps.tableName,
				Key: { pk: text(indexKey.pk), sk: text(indexKey.sk) },
				ConditionExpression: GUARD,
				...updateOf({ ...index, values: { ...index.values, ...guard } }),
			},
		},
	];
	try {
		await retryTransient(() => deps.client.send(new TransactWriteItemsCommand({ TransactItems: items })));
		return true;
	} catch (error) {
		if (error instanceof TransactionCanceledException && error.CancellationReasons?.some((reason) => reason.Code === "ConditionalCheckFailed")) {
			return false;
		}
		throw error;
	}
}
