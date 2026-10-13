import {
	type AttributeValue,
	GetItemCommand,
	TransactWriteItemsCommand,
	type TransactWriteItem,
	UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { vendorLedgerKey } from "../budget/budget-store.ts";
import { BILLED_VIA_VENDOR } from "../budget/models.ts";
import { retryTransient } from "../store/transient-retry.ts";
import {
	COST_SOURCE_GATEWAY,
	gatewayObservationKey,
	type GatewayObservationTable,
	listGatewayObservations,
	type ObservationReconciliation,
	type StoredGatewayObservation,
} from "./gateway-observation.ts";
import { priceCall, UnpricedModelError, type VendorPriceBook } from "./price-book.ts";
import { costIndexPartitionOf } from "./turn-cost.ts";

/**
 * How long an observation may go unaccounted for by the session before it is counted as a call of its own. A turn writes
 * its session cost records when it yields, parks, concludes or fails, so a long call inside a running turn is not yet in
 * its row. Past this age a call nothing accounts for is a call the session never committed.
 */
export const OBSERVATION_GRACE_SECONDS = 2 * 60 * 60;

/**
 * Observed tokens beyond the session's, as a share of the session's, above which a turn is flagged. The flag is for people:
 * an unaccounted call is counted as cost whatever its size.
 */
export const RECONCILIATION_GAP_TOLERANCE = 0.05;

/** The row id of the ledger row and cost index item that carry a gateway-observed call that the session does not account for. */
export const GATEWAY_COST_ROW_PREFIX = "gateway:";

/** The ledger row id of a gateway-observed call. */
export const gatewayCostRowIdOf = (callId: string): string => `${GATEWAY_COST_ROW_PREFIX}${callId}`;

/** What reconciliation found for the observations of one turn. */
export type TurnReconciliation = {
	readonly turnId: string;
	/** Observations the session's records account for by response id. */
	readonly matched: number;
	/** Observations that are summarization calls the session's compaction records account for. */
	readonly compaction: number;
	/** Observations too recent to judge. */
	readonly pending: number;
	/** Observations nothing in the session accounts for: calls the vendor answered and the session never committed. */
	readonly orphans: number;
	readonly orphanInputTokens: number;
	readonly orphanOutputTokens: number;
	readonly sessionTokens: number;
	/** True when the unaccounted tokens exceed `RECONCILIATION_GAP_TOLERANCE` of the session's. */
	readonly flagged: boolean;
};

/** What reconciling one organization did. */
export type ReconcileOutcome = {
	readonly tenantId: string;
	readonly turns: readonly TurnReconciliation[];
};

/** The table, prices and clock reconciliation needs. */
export type ReconcileDependencies = GatewayObservationTable & {
	readonly prices: VendorPriceBook;
	readonly now: () => Date;
};

/** Reconciles an organization's gateway observations against the session's cost records. */
export interface ObservationReconciler {
	reconcileTenant(tenantId: string): Promise<ReconcileOutcome>;
}

type Item = Record<string, AttributeValue>;

type SessionAccount = {
	readonly responseIds: ReadonlySet<string>;
	readonly compactionContextTokens: number;
	readonly compactionOutputTokens: number;
	readonly sessionTokens: number;
};

async function sessionAccountOf(deps: ReconcileDependencies, tenantId: string, turnId: string): Promise<SessionAccount> {
	const key = vendorLedgerKey(tenantId, turnId);
	const result = await deps.client.send(
		new GetItemCommand({ TableName: deps.tableName, Key: { pk: { S: key.pk }, sk: { S: key.sk } }, ConsistentRead: true }),
	);
	const item = result.Item;
	return {
		responseIds: new Set(item?.response_ids?.SS ?? []),
		compactionContextTokens: Number(item?.compaction_context_tokens?.N ?? "0"),
		compactionOutputTokens: Number(item?.compaction_output_tokens?.N ?? "0"),
		sessionTokens: Number(item?.input_tokens?.N ?? "0") + Number(item?.output_tokens?.N ?? "0"),
	};
}

type Verdict = { readonly observation: StoredGatewayObservation; readonly verdict: ObservationReconciliation | "pending" };

/**
 * Decide, for the observations of one turn, which the session already accounts for. An observation is matched when a
 * session record with tokens carries the same response id. Of the rest, those that fit inside the tokens of the turn's
 * compaction records are the summarization calls those records stand for (a summarization has no response id in the
 * session). What is left is an orphan once it is old enough to be sure the session is not about to account for it.
 */
export function judgeObservations(
	observations: readonly StoredGatewayObservation[],
	account: SessionAccount,
	now: Date,
): Verdict[] {
	const verdicts = new Map<string, Verdict["verdict"]>();
	const unmatched: StoredGatewayObservation[] = [];
	for (const observation of observations) {
		if (observation.responseId !== null && account.responseIds.has(observation.responseId)) verdicts.set(observation.callId, "matched");
		else unmatched.push(observation);
	}
	let contextBudget = account.compactionContextTokens;
	let outputBudget = account.compactionOutputTokens;
	for (const observation of [...unmatched].sort((left, right) => left.observedAt.localeCompare(right.observedAt))) {
		if (!observation.estimated && observation.inputTokens <= contextBudget && observation.outputTokens <= outputBudget) {
			contextBudget -= observation.inputTokens;
			outputBudget -= observation.outputTokens;
			verdicts.set(observation.callId, "compaction");
			continue;
		}
		const ageSeconds = (now.getTime() - Date.parse(observation.observedAt)) / 1000;
		verdicts.set(observation.callId, ageSeconds >= OBSERVATION_GRACE_SECONDS ? "orphan" : "pending");
	}
	return observations.map((observation) => ({ observation, verdict: verdicts.get(observation.callId)! }));
}

const text = (value: string): AttributeValue => ({ S: value });
const number = (value: number): AttributeValue => ({ N: String(value) });

type GatewayCostFields = { readonly ledger: Item; readonly index: Item };

function gatewayCostItems(deps: ReconcileDependencies, observation: StoredGatewayObservation): GatewayCostFields {
	const rowId = gatewayCostRowIdOf(observation.callId);
	const ledgerKey = vendorLedgerKey(observation.tenantId, rowId);
	const month = observation.observedAt.slice(0, 7);
	const indexKey = { pk: costIndexPartitionOf(observation.tenantId, month), sk: `gateway#${observation.callId}` };
	const uncachedInput = Math.max(0, observation.inputTokens - observation.cachedInputTokens);
	const common: Item = {
		tenant_id: text(observation.tenantId),
		turn_id: text(observation.turnId),
		vendor: text(observation.vendor),
		model: text(observation.model),
		input_tokens: number(observation.inputTokens),
		output_tokens: number(observation.outputTokens),
		recorded_at: text(observation.observedAt),
		price_book_id: text(deps.prices.priceBookId),
		models: { SS: [observation.model] },
		source: text(COST_SOURCE_GATEWAY),
		call_id: text(observation.callId),
		cached_input_tokens: number(observation.cachedInputTokens),
		estimated: { BOOL: observation.estimated },
		record_count: number(1),
	};
	if (observation.responseId !== null) common.response_id = text(observation.responseId);
	try {
		const priced = priceCall(deps.prices, {
			vendor: observation.vendor,
			model: observation.model,
			inputTokens: uncachedInput,
			cacheReadTokens: observation.cachedInputTokens,
			cacheWriteTokens: 0,
			outputTokens: observation.outputTokens,
		});
		common.cost_usd = { N: priced.costUsd.toString() };
		common.unpriced_calls = number(0);
		common.priced_with = { SS: [...new Set([...priced.pricedWith, ...(observation.estimated ? ["gateway_estimate"] : [])])].sort() };
	} catch (error) {
		if (!(error instanceof UnpricedModelError)) throw error;
		common.unpriced_calls = number(1);
		if (observation.estimated) common.priced_with = { SS: ["gateway_estimate"] };
	}
	return {
		ledger: { ...common, pk: text(ledgerKey.pk), sk: text(ledgerKey.sk), billed_via: text(BILLED_VIA_VENDOR) },
		index: {
			...common,
			pk: text(indexKey.pk),
			sk: text(indexKey.sk),
			kind: text("gateway_call"),
			status: text("completed"),
			owner_kind: text("computer"),
			updated_at: text(deps.now().toISOString()),
		},
	};
}

function gatewayCostKeys(observation: StoredGatewayObservation): Array<{ pk: string; sk: string }> {
	const rowId = gatewayCostRowIdOf(observation.callId);
	return [
		vendorLedgerKey(observation.tenantId, rowId),
		{ pk: costIndexPartitionOf(observation.tenantId, observation.observedAt.slice(0, 7)), sk: `gateway#${observation.callId}` },
	];
}

async function putGatewayCost(deps: ReconcileDependencies, observation: StoredGatewayObservation): Promise<void> {
	const { ledger, index } = gatewayCostItems(deps, observation);
	const items: TransactWriteItem[] = [
		{ Put: { TableName: deps.tableName, Item: ledger } },
		{ Put: { TableName: deps.tableName, Item: index } },
	];
	await retryTransient(() => deps.client.send(new TransactWriteItemsCommand({ TransactItems: items })));
}

async function deleteGatewayCost(deps: ReconcileDependencies, observation: StoredGatewayObservation): Promise<void> {
	const items: TransactWriteItem[] = gatewayCostKeys(observation).map((key) => ({
		Delete: { TableName: deps.tableName, Key: { pk: text(key.pk), sk: text(key.sk) } },
	}));
	await retryTransient(() => deps.client.send(new TransactWriteItemsCommand({ TransactItems: items })));
}

async function markReconciliation(deps: ReconcileDependencies, observation: StoredGatewayObservation, state: ObservationReconciliation): Promise<void> {
	const key = gatewayObservationKey(observation.tenantId, observation.turnId, observation.callId);
	await retryTransient(() =>
		deps.client.send(
			new UpdateItemCommand({
				TableName: deps.tableName,
				Key: { pk: text(key.pk), sk: text(key.sk) },
				UpdateExpression: "SET reconciliation = :state",
				ConditionExpression: "attribute_exists(sk)",
				ExpressionAttributeValues: { ":state": text(state) },
			}),
		),
	);
}

/**
 * Reconcile one organization's gateway observations against what its sessions recorded, so that every call the vendor
 * answered is counted exactly once. For each turn: an observation whose response id is on the turn's ledger row is the
 * same call the session recorded, so it is not a cost; one that fits the turn's compaction records is a summarization
 * call those records stand for; one that nothing accounts for and is old enough is a call the session never committed, and
 * becomes a ledger row and a cost index item of its own, flagged as sourced from the gateway (and as an estimate when the
 * stream was interrupted). The verdicts are recomputed from the current rows on every run, so the job is idempotent, and
 * an orphan whose session record appears later is withdrawn: its gateway rows are deleted and the call is counted by the
 * session only.
 *
 * @param deps Table, prices and clock.
 * @param tenantId The organization.
 * @returns What was found for each turn that has observations.
 */
export async function reconcileTenantObservations(deps: ReconcileDependencies, tenantId: string): Promise<ReconcileOutcome> {
	const observations = await listGatewayObservations(deps, tenantId);
	const byTurn = new Map<string, StoredGatewayObservation[]>();
	for (const observation of observations) byTurn.set(observation.turnId, [...(byTurn.get(observation.turnId) ?? []), observation]);
	const now = deps.now();
	const turns: TurnReconciliation[] = [];
	for (const [turnId, turnObservations] of byTurn) {
		const account = await sessionAccountOf(deps, tenantId, turnId);
		const verdicts = judgeObservations(turnObservations, account, now);
		let orphanInputTokens = 0;
		let orphanOutputTokens = 0;
		for (const { observation, verdict } of verdicts) {
			if (verdict === "pending") continue;
			if (verdict === "orphan") {
				orphanInputTokens += observation.inputTokens;
				orphanOutputTokens += observation.outputTokens;
				await putGatewayCost(deps, observation);
			} else if (observation.reconciliation === "orphan") {
				await deleteGatewayCost(deps, observation);
			}
			if (observation.reconciliation !== verdict) await markReconciliation(deps, observation, verdict);
		}
		const count = (wanted: Verdict["verdict"]): number => verdicts.filter(({ verdict }) => verdict === wanted).length;
		const orphanTokens = orphanInputTokens + orphanOutputTokens;
		turns.push({
			turnId,
			matched: count("matched"),
			compaction: count("compaction"),
			pending: count("pending"),
			orphans: count("orphan"),
			orphanInputTokens,
			orphanOutputTokens,
			sessionTokens: account.sessionTokens,
			flagged: orphanTokens > 0 && (account.sessionTokens === 0 || orphanTokens / account.sessionTokens > RECONCILIATION_GAP_TOLERANCE),
		});
	}
	return { tenantId, turns };
}

/** The reconciler over the messaging table. */
export class DynamoObservationReconciler implements ObservationReconciler {
	private readonly deps: ReconcileDependencies;

	constructor(deps: ReconcileDependencies) {
		this.deps = deps;
	}

	reconcileTenant(tenantId: string): Promise<ReconcileOutcome> {
		return reconcileTenantObservations(this.deps, tenantId);
	}
}
