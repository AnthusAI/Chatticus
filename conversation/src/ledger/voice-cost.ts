import { randomUUID } from "node:crypto";
import { buildModelCallCost, type ModelCallCost, type ModelCallUsage } from "./call-cost.ts";
import { projectTurnCost, summarizeTurnCost, VOICE_COST_ROW_PREFIX } from "./turn-cost.ts";
import type { VendorLedgerDependencies } from "./vendor-ledger.ts";

/** The conversation id a voice understanding record carries, because a voice call has no Pi session. */
export const VOICE_COST_CONVERSATION_ID = "voice";

/** What the cost of one voice understanding call is attributed to. */
export type VoiceUnderstandingCostRequest = {
	readonly tenantId: string;
	readonly channelId: string;
	readonly memberId: string;
	readonly usage: ModelCallUsage;
};

/**
 * Record the cost of the call that repaired one spoken line. It is the same cost record the session holds for a bot's
 * model call, priced by the same function from the same price book, with its own kind. A voice call has no session, so
 * the record is projected to the ledger row the rollup sums and to the cost index item of its month, which names the
 * member who spoke and the channel and, because no bot spent it, no bot.
 *
 * @param deps Table, prices and clock.
 * @param request The call's usage and who it is attributed to.
 * @returns The record that was projected.
 * @throws Error If the rows cannot be written; the caller reports it, the cost is not swallowed.
 */
export async function recordVoiceUnderstandingCost(
	deps: VendorLedgerDependencies,
	request: VoiceUnderstandingCostRequest,
): Promise<ModelCallCost> {
	const rowId = `${VOICE_COST_ROW_PREFIX}${randomUUID()}`;
	const record = buildModelCallCost(
		{
			kind: "voice_understanding",
			conversationId: VOICE_COST_CONVERSATION_ID,
			entryId: 0,
			turnId: rowId,
			round: 1,
			usage: request.usage,
			responseId: null,
			providerCostEstimateUsd: 0,
			recordedAt: deps.now().toISOString(),
		},
		deps.prices,
	);
	const summary = summarizeTurnCost([record]);
	if (summary === null) throw new Error("A voice understanding record produced no cost summary.");
	await projectTurnCost(
		deps,
		{
			tenantId: request.tenantId,
			turnId: rowId,
			kind: "voice_understanding",
			botId: null,
			channelId: request.channelId,
			promptAuthorId: request.memberId,
			promptMessageSeq: null,
			messageSeq: null,
			ownerKind: "lambda",
			status: "completed",
		},
		summary,
	);
	return record;
}
