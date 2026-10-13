import {
	type AttributeValue,
	ConditionalCheckFailedException,
	type DynamoDBClient,
	GetItemCommand,
	PutItemCommand,
	TransactionCanceledException,
	TransactWriteItemsCommand,
	type TransactWriteItem,
	UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { vendorLedgerKey } from "../budget/budget-store.ts";
import { Decimal } from "../budget/decimal.ts";
import { BILLED_VIA_VENDOR } from "../budget/models.ts";
import { StaleAttemptError } from "../http/errors.ts";
import { retryTransient } from "../store/transient-retry.ts";
import { turnItemPartitionKey } from "../store/turn-events.ts";
import { type PricedCalls, type PricedCallSubject, priceCalls, type VendorPriceBook } from "./price-book.ts";

const MILLION_EXPONENT = 6;
const COST_SCALE = 8;
const TRANSACTION_ATTEMPTS = 5;

/** Token counts of one vendor model call. */
export type SpendUsage = {
	readonly vendor: string;
	readonly model: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
};

/** One durable vendor spend row of a turn. */
export type VendorLedgerEntry = {
	readonly tenantId: string;
	readonly turnId: string;
	readonly vendor: string;
	readonly model: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly billedVia: string;
	readonly inputPricePerMillionUsd: Decimal | null;
	readonly outputPricePerMillionUsd: Decimal | null;
	readonly costUsd: Decimal | null;
	readonly priceBookId: string | null;
	readonly pricedWith: readonly string[];
	readonly models: readonly string[];
	readonly unpricedCalls: number;
	readonly recordedAt: string;
};

/** What the ledger writes need. */
export type VendorLedgerDependencies = {
	readonly client: DynamoDBClient;
	readonly tableName: string;
	readonly prices: VendorPriceBook;
	readonly now: () => Date;
};

type Item = Record<string, AttributeValue>;

const optionalDecimal = (item: Item, name: string): Decimal | null => {
	const raw = item[name]?.N;
	return raw === undefined ? null : Decimal.parse(raw);
};

function entryFromItem(item: Item): VendorLedgerEntry {
	return {
		tenantId: item.tenant_id!.S!,
		turnId: item.turn_id!.S!,
		vendor: item.vendor!.S!,
		model: item.model!.S!,
		inputTokens: Number(item.input_tokens!.N),
		outputTokens: Number(item.output_tokens!.N),
		billedVia: item.billed_via!.S!,
		inputPricePerMillionUsd: optionalDecimal(item, "input_price_per_million_usd"),
		outputPricePerMillionUsd: optionalDecimal(item, "output_price_per_million_usd"),
		costUsd: optionalDecimal(item, "cost_usd"),
		priceBookId: item.price_book_id?.S ?? null,
		pricedWith: [...(item.priced_with?.SS ?? [])].sort(),
		models: [...(item.models?.SS ?? [])].sort(),
		unpricedCalls: Number(item.unpriced_calls?.N ?? "0"),
		recordedAt: item.recorded_at!.S!,
	};
}

/**
 * Dollars for token counts at frozen per-million rates, rounded half to even at eight places, or null when either rate
 * is missing or no tokens were used.
 */
export function costUsdFromTokens(
	inputTokens: number,
	outputTokens: number,
	inputPrice: Decimal | null,
	outputPrice: Decimal | null,
): Decimal | null {
	if (inputPrice === null || outputPrice === null) return null;
	if (inputTokens === 0 && outputTokens === 0) return null;
	const inputCost = inputPrice.multiplyByInteger(inputTokens).divideByPowerOfTen(MILLION_EXPONENT).quantize(COST_SCALE);
	const outputCost = outputPrice.multiplyByInteger(outputTokens).divideByPowerOfTen(MILLION_EXPONENT).quantize(COST_SCALE);
	return inputCost.add(outputCost);
}

/**
 * The vendor ledger row of a turn.
 *
 * @returns The row, or null when no spend was recorded for the turn.
 */
export async function getVendorLedgerEntry(
	deps: VendorLedgerDependencies,
	tenantId: string,
	turnId: string,
): Promise<VendorLedgerEntry | null> {
	const key = vendorLedgerKey(tenantId, turnId);
	const result = await deps.client.send(
		new GetItemCommand({
			TableName: deps.tableName,
			Key: { pk: { S: key.pk }, sk: { S: key.sk } },
			ConsistentRead: true,
		}),
	);
	return result.Item === undefined ? null : entryFromItem(result.Item);
}

function pricingAttributes(pricing: PricedCalls, priceBookId: string, hasTokens: boolean): Item {
	const attributes: Item = {
		price_book_id: { S: priceBookId },
		models: { SS: [...pricing.models] },
		unpriced_calls: { N: String(pricing.unpricedCalls) },
	};
	if (pricing.pricedWith.length > 0) attributes.priced_with = { SS: [...pricing.pricedWith] };
	if (pricing.costUsd !== null && hasTokens) attributes.cost_usd = { N: pricing.costUsd.toString() };
	return attributes;
}

function insertItem(
	deps: VendorLedgerDependencies,
	tenantId: string,
	turnId: string,
	usage: SpendUsage,
	billedVia: string,
	pricing: PricedCalls,
): Item {
	const key = vendorLedgerKey(tenantId, turnId);
	const item: Item = {
		pk: { S: key.pk },
		sk: { S: key.sk },
		tenant_id: { S: tenantId },
		turn_id: { S: turnId },
		vendor: { S: usage.vendor },
		model: { S: usage.model },
		input_tokens: { N: String(usage.inputTokens) },
		output_tokens: { N: String(usage.outputTokens) },
		billed_via: { S: billedVia },
		recorded_at: { S: deps.now().toISOString() },
	};
	if (billedVia !== BILLED_VIA_VENDOR) return item;
	Object.assign(item, pricingAttributes(pricing, deps.prices.priceBookId, usage.inputTokens > 0 || usage.outputTokens > 0));
	const price = deps.prices.lookup(usage.vendor, usage.model);
	if (price !== null) {
		item.input_price_per_million_usd = { N: price.inputPerMillionUsd.toString() };
		item.output_price_per_million_usd = { N: price.outputPerMillionUsd.toString() };
	}
	return item;
}

const pricingOfSingleCall = (deps: VendorLedgerDependencies, usage: SpendUsage): PricedCalls =>
	priceCalls(deps.prices, [{ ...usage, cacheReadTokens: 0, cacheWriteTokens: 0 }]);

/**
 * The update that makes a turn row's dollars equal the priced total of every call of the turn, so a re-run that
 * recomputes the same calls writes the same figures.
 */
function turnPricingUpdate(deps: VendorLedgerDependencies, pricing: PricedCalls): { set: string; remove: string; values: Item } {
	const attributes = pricingAttributes(pricing, deps.prices.priceBookId, true);
	const values: Item = {
		":priceBookId": attributes.price_book_id!,
		":models": attributes.models!,
		":unpricedCalls": attributes.unpriced_calls!,
	};
	let set = "price_book_id = :priceBookId, models = :models, unpriced_calls = :unpricedCalls";
	let remove = "";
	if (attributes.priced_with !== undefined) {
		set += ", priced_with = :pricedWith";
		values[":pricedWith"] = attributes.priced_with;
	} else remove += "priced_with";
	if (attributes.cost_usd !== undefined) {
		set += ", cost_usd = :costUsd";
		values[":costUsd"] = attributes.cost_usd;
	} else remove += `${remove === "" ? "" : ", "}cost_usd`;
	return { set, remove, values };
}

function accumulateUpdate(
	existing: VendorLedgerEntry,
	usage: SpendUsage,
): { UpdateExpression: string; ExpressionAttributeValues: Item } {
	const values: Item = {
		":inputDelta": { N: String(usage.inputTokens) },
		":outputDelta": { N: String(usage.outputTokens) },
	};
	let expression = "ADD input_tokens :inputDelta, output_tokens :outputDelta";
	if (existing.billedVia === BILLED_VIA_VENDOR) {
		const cost = costUsdFromTokens(
			usage.inputTokens,
			usage.outputTokens,
			existing.inputPricePerMillionUsd,
			existing.outputPricePerMillionUsd,
		);
		if (cost !== null) {
			expression += ", cost_usd :costDelta";
			values[":costDelta"] = { N: cost.toString() };
		}
		if (existing.inputPricePerMillionUsd === null) {
			expression += ", unpriced_calls :unpricedDelta";
			values[":unpricedDelta"] = { N: "1" };
		}
	}
	return { UpdateExpression: expression, ExpressionAttributeValues: values };
}

/**
 * Record one model call on the turn's vendor ledger row. The first call inserts the row and freezes the model's price at
 * that moment; a later call on the same turn adds its tokens and its dollars at the frozen rates. A call billed through
 * AWS keeps `cost_usd` null.
 *
 * @param deps Table, prices and clock.
 * @param tenantId Organization.
 * @param turnId Turn.
 * @param usage Tokens of the call.
 * @param billedVia `vendor` or `aws`.
 * @returns The row after the write.
 */
export async function recordVendorSpend(
	deps: VendorLedgerDependencies,
	tenantId: string,
	turnId: string,
	usage: SpendUsage,
	billedVia: string,
): Promise<VendorLedgerEntry> {
	for (let attempt = 0; attempt < TRANSACTION_ATTEMPTS; attempt += 1) {
		const existing = await getVendorLedgerEntry(deps, tenantId, turnId);
		try {
			if (existing === null) {
				await deps.client.send(
					new PutItemCommand({
						TableName: deps.tableName,
						Item: insertItem(deps, tenantId, turnId, usage, billedVia, pricingOfSingleCall(deps, usage)),
						ConditionExpression: "attribute_not_exists(sk)",
					}),
				);
			} else {
				const key = vendorLedgerKey(tenantId, turnId);
				await deps.client.send(
					new UpdateItemCommand({
						TableName: deps.tableName,
						Key: { pk: { S: key.pk }, sk: { S: key.sk } },
						ConditionExpression: "attribute_exists(pk)",
						...accumulateUpdate(existing, usage),
					}),
				);
			}
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) continue;
			throw error;
		}
		const stored = await getVendorLedgerEntry(deps, tenantId, turnId);
		if (stored === null) throw new Error(`Vendor ledger row for turn ${turnId} was not persisted.`);
		return stored;
	}
	throw new Error(`Vendor ledger row for turn ${turnId} could not be written after ${TRANSACTION_ATTEMPTS} attempts.`);
}

/** Tokens a turn has used in total, and how many of them its record already shows as written to the ledger. */
export type TurnSpendProgress = {
	readonly inputTotal: number;
	readonly outputTotal: number;
	readonly inputRecorded: number;
	readonly outputRecorded: number;
};

/**
 * Record the part of a turn's usage that the ledger does not hold yet, and advance the turn record's
 * `ledger_input_recorded` and `ledger_output_recorded` in the same transaction under the attempt's fence. A recovered
 * attempt that recomputes the same totals therefore finds nothing left to write, and a stale attempt writes nothing.
 *
 * Dollars are not summed from deltas: every call of the turn is priced by its own model at its own context size, and the
 * row's `cost_usd` is set to that total, so a recovered attempt recomputing the same calls writes the same figure. The
 * row's `model` is the model of the turn's first call; `models` lists every model that served a call. A call whose model
 * the price book lacks is counted in `unpriced_calls` and leaves `cost_usd` absent, which means unknown, never zero.
 *
 * @param deps Table, prices and clock.
 * @param request The turn, its attempt, every call of the turn so far and the token totals.
 * @returns Whether anything was written.
 * @throws StaleAttemptError When the attempt no longer owns the turn or the turn is no longer active.
 */
export async function recordTurnSpendOnce(
	deps: VendorLedgerDependencies,
	request: {
		readonly tenantId: string;
		readonly turnId: string;
		readonly attemptId: string;
		readonly calls: readonly PricedCallSubject[];
		readonly progress: TurnSpendProgress;
	},
): Promise<boolean> {
	const inputDelta = request.progress.inputTotal - request.progress.inputRecorded;
	const outputDelta = request.progress.outputTotal - request.progress.outputRecorded;
	if (inputDelta <= 0 && outputDelta <= 0) return false;
	const first = request.calls[0];
	if (first === undefined) return false;
	const usage: SpendUsage = { vendor: first.vendor, model: first.model, inputTokens: inputDelta, outputTokens: outputDelta };
	const pricing = priceCalls(deps.prices, request.calls);
	const pricingUpdate = turnPricingUpdate(deps, pricing);
	const turnKey = { pk: { S: turnItemPartitionKey(request.tenantId, request.turnId) }, sk: { S: "meta" } };
	const key = vendorLedgerKey(request.tenantId, request.turnId);
	for (let attempt = 0; attempt < TRANSACTION_ATTEMPTS; attempt += 1) {
		const existing = await getVendorLedgerEntry(deps, request.tenantId, request.turnId);
		const ledgerWrite: TransactWriteItem =
			existing === null
				? {
						Put: {
							TableName: deps.tableName,
							Item: insertItem(deps, request.tenantId, request.turnId, usage, BILLED_VIA_VENDOR, pricing),
							ConditionExpression: "attribute_not_exists(sk)",
						},
					}
				: {
						Update: {
							TableName: deps.tableName,
							Key: { pk: { S: key.pk }, sk: { S: key.sk } },
							ConditionExpression: "attribute_exists(pk)",
							UpdateExpression: `SET ${pricingUpdate.set}${pricingUpdate.remove === "" ? "" : ` REMOVE ${pricingUpdate.remove}`} ADD input_tokens :inputDelta, output_tokens :outputDelta`,
							ExpressionAttributeValues: {
								...pricingUpdate.values,
								":inputDelta": { N: String(usage.inputTokens) },
								":outputDelta": { N: String(usage.outputTokens) },
							},
						},
					};
		try {
			await retryTransient(() => deps.client.send(
				new TransactWriteItemsCommand({
					TransactItems: [
						ledgerWrite,
						{
							Update: {
								TableName: deps.tableName,
								Key: turnKey,
								UpdateExpression: "SET ledger_input_recorded = :inputTotal, ledger_output_recorded = :outputTotal",
								ConditionExpression:
									"attempt_id = :attemptId AND #status = :active AND (attribute_not_exists(ledger_input_recorded) OR ledger_input_recorded = :inputRecorded) AND (attribute_not_exists(ledger_output_recorded) OR ledger_output_recorded = :outputRecorded)",
								ExpressionAttributeNames: { "#status": "status" },
								ExpressionAttributeValues: {
									":inputTotal": { N: String(request.progress.inputTotal) },
									":outputTotal": { N: String(request.progress.outputTotal) },
									":inputRecorded": { N: String(request.progress.inputRecorded) },
									":outputRecorded": { N: String(request.progress.outputRecorded) },
									":attemptId": { S: request.attemptId },
									":active": { S: "active" },
								},
							},
						},
					],
				}),
			));
			return true;
		} catch (error) {
			if (error instanceof TransactionCanceledException) {
				const turnCondition = error.CancellationReasons?.[1]?.Code === "ConditionalCheckFailed";
				if (turnCondition) {
					throw new StaleAttemptError(`Turn ${request.turnId} no longer belongs to attempt ${request.attemptId}.`);
				}
				continue;
			}
			throw error;
		}
	}
	throw new Error(`Spend of turn ${request.turnId} could not be recorded after ${TRANSACTION_ATTEMPTS} attempts.`);
}
