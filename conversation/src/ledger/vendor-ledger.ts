import { type AttributeValue, type DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { vendorLedgerKey } from "../budget/budget-store.ts";
import { Decimal } from "../budget/decimal.ts";
import type { VendorPriceBook } from "./price-book.ts";

/** One durable vendor spend row: a turn's, a voice understanding call's, or a call only the gateway observed. */
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

/** What the ledger writes and reads need. */
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
 * The vendor ledger row of a turn, or of a voice understanding call under `voice:<uuid>`. The rows are written only from
 * cost records: `projectTurnCost` for a turn and `recordVoiceUnderstandingCost` for a voice call, never added to in place.
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
