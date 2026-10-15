import { type AttributeValue, ConditionalCheckFailedException, type DynamoDBClient, PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { retryTransient } from "../store/transient-retry.ts";

/** How long the gateway keeps an observation: long enough for the monthly view to close and be reconciled. */
export const GATEWAY_OBSERVATION_TTL_SECONDS = 35 * 24 * 60 * 60;

/** The `source` of a cost row that was written from a gateway observation and not from the session. */
export const COST_SOURCE_GATEWAY = "gateway";

/**
 * One model call the gateway forwarded and the vendor answered, as the gateway saw it. It is evidence kept beside the
 * session, never a cost: the session's cost records are the cost, and an observation becomes a cost only when no session
 * record accounts for the same call. `callId` is the vendor's response id when the gateway saw one and otherwise the
 * gateway's own request id, so the same call always has the same key. `inputTokens` is the vendor's figure and includes
 * the cached part, as the vendor reports it.
 */
export type GatewayObservation = {
	readonly tenantId: string;
	readonly turnId: string;
	readonly ownerId: string;
	readonly callId: string;
	readonly responseId: string | null;
	readonly requestId: string;
	readonly vendor: string;
	readonly model: string;
	readonly inputTokens: number;
	readonly cachedInputTokens: number;
	readonly outputTokens: number;
	readonly reasoningTokens: number;
	/** True when the figures are the gateway's own estimate: the stream was interrupted or the answer carried no final usage. */
	readonly estimated: boolean;
	readonly reason: string;
	readonly observedAt: string;
};

/** Where the gateway puts what it saw. */
export interface GatewayObservationSink {
	/** Keep one observation; writing the same call again never replaces a final figure with an estimate. */
	record(observation: GatewayObservation): Promise<void>;
}

/** The partition of a tenant's gateway observations and the key of one call within it. */
export const gatewayObservationKey = (tenantId: string, turnId: string, callId: string): { pk: string; sk: string } => ({
	pk: `${tenantId}#cost#observed`,
	sk: `turn#${turnId}#call#${callId}`,
});

type Item = Record<string, AttributeValue>;

/** The table and clock a DynamoDB observation sink needs. */
export type GatewayObservationTable = {
	readonly client: DynamoDBClient;
	readonly tableName: string;
};

/** What reconciliation concluded about one observation. */
export type ObservationReconciliation = "unreconciled" | "matched" | "compaction" | "orphan";

/** An observation as stored, with the state reconciliation last gave it. */
export type StoredGatewayObservation = GatewayObservation & { readonly reconciliation: ObservationReconciliation };

function itemOf(observation: GatewayObservation): Item {
	const key = gatewayObservationKey(observation.tenantId, observation.turnId, observation.callId);
	const expiresAt = Math.floor(Date.parse(observation.observedAt) / 1000) + GATEWAY_OBSERVATION_TTL_SECONDS;
	const item: Item = {
		pk: { S: key.pk },
		sk: { S: key.sk },
		tenant_id: { S: observation.tenantId },
		turn_id: { S: observation.turnId },
		owner_id: { S: observation.ownerId },
		call_id: { S: observation.callId },
		request_id: { S: observation.requestId },
		vendor: { S: observation.vendor },
		model: { S: observation.model },
		input_tokens: { N: String(observation.inputTokens) },
		cached_input_tokens: { N: String(observation.cachedInputTokens) },
		output_tokens: { N: String(observation.outputTokens) },
		reasoning_tokens: { N: String(observation.reasoningTokens) },
		estimated: { BOOL: observation.estimated },
		reason: { S: observation.reason },
		observed_at: { S: observation.observedAt },
		source: { S: COST_SOURCE_GATEWAY },
		reconciliation: { S: "unreconciled" },
		expires_at: { N: String(expiresAt) },
	};
	if (observation.responseId !== null) item.response_id = { S: observation.responseId };
	return item;
}

/** The observation sink over the messaging table; the Front Door writes it, the daily rollup reconciles it. */
export class DynamoGatewayObservationSink implements GatewayObservationSink {
	private readonly table: GatewayObservationTable;

	constructor(table: GatewayObservationTable) {
		this.table = table;
	}

	async record(observation: GatewayObservation): Promise<void> {
		try {
			await retryTransient(() =>
				this.table.client.send(
					new PutItemCommand({
						TableName: this.table.tableName,
						Item: itemOf(observation),
						ConditionExpression: "attribute_not_exists(sk) OR estimated = :estimated",
						ExpressionAttributeValues: { ":estimated": { BOOL: true } },
					}),
				),
			);
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) return;
			throw error;
		}
	}
}

const numberOf = (item: Item, name: string): number => Number(item[name]?.N ?? "0");

/** Read one stored observation item back into its shape. */
export function observationFromItem(item: Item): StoredGatewayObservation {
	return {
		tenantId: item.tenant_id!.S!,
		turnId: item.turn_id!.S!,
		ownerId: item.owner_id!.S!,
		callId: item.call_id!.S!,
		responseId: item.response_id?.S ?? null,
		requestId: item.request_id!.S!,
		vendor: item.vendor!.S!,
		model: item.model!.S!,
		inputTokens: numberOf(item, "input_tokens"),
		cachedInputTokens: numberOf(item, "cached_input_tokens"),
		outputTokens: numberOf(item, "output_tokens"),
		reasoningTokens: numberOf(item, "reasoning_tokens"),
		estimated: item.estimated?.BOOL ?? false,
		reason: item.reason!.S!,
		observedAt: item.observed_at!.S!,
		reconciliation: (item.reconciliation?.S ?? "unreconciled") as ObservationReconciliation,
	};
}

/**
 * Every gateway observation of one organization still within its retention.
 *
 * @param table The messaging table.
 * @param tenantId The organization.
 */
export async function listGatewayObservations(table: GatewayObservationTable, tenantId: string): Promise<StoredGatewayObservation[]> {
	const observations: StoredGatewayObservation[] = [];
	let startKey: Item | undefined;
	do {
		const response = await table.client.send(
			new QueryCommand({
				TableName: table.tableName,
				KeyConditionExpression: "pk = :pk",
				ExpressionAttributeValues: { ":pk": { S: `${tenantId}#cost#observed` } },
				ExclusiveStartKey: startKey,
				ConsistentRead: true,
			}),
		);
		for (const item of response.Items ?? []) observations.push(observationFromItem(item));
		startKey = response.LastEvaluatedKey;
	} while (startKey !== undefined);
	return observations;
}
