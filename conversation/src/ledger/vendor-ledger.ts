import {
	type AttributeValue,
	ConditionalCheckFailedException,
	type DynamoDBClient,
	GetItemCommand,
	PutItemCommand,
	UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { vendorLedgerKey } from "../budget/budget-store.ts";
import { Decimal } from "../budget/decimal.ts";
import { BILLED_VIA_VENDOR } from "../budget/models.ts";
import { type PricedCalls, priceCalls, type VendorPriceBook } from "./price-book.ts";

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
 * AWS keeps `cost_usd` null. This is the ledger path of calls made outside a turn (the voice understanding call); the
 * ledger row of a turn is written only by `projectTurnCost` from the turn's session cost records, never by this function.
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
