import { formatLogLine } from "../observability/log-line.ts";

/** Why a board request was denied. */
export type BoardDenialReason = "forbidden" | "not_found" | "not_signed_in";

/**
 * One denied request to a bot's board. It names who asked, what they asked for and why they were refused, and holds no
 * card text: not a title, a description, a comment or a request body.
 */
export type BoardAuditRecord = {
	readonly at: Date;
	readonly tenantId: string;
	readonly botId: string | null;
	readonly userId: string | null;
	readonly operation: string;
	readonly method: string;
	readonly cardId: string | null;
	readonly outcome: "refused";
	readonly reason: BoardDenialReason;
};

/** Receives one record for every denied board request. */
export type BoardAuditSink = (record: BoardAuditRecord) => void;

/**
 * The sink a deployment uses: one structured log line per denied request, which the function log keeps.
 *
 * @param record The denied request.
 */
export function logBoardAuditRecord(record: BoardAuditRecord): void {
	console.info(
		formatLogLine("bot_board_request_refused", {
			at: record.at.toISOString(),
			tenant_id: record.tenantId,
			bot_id: record.botId,
			user_id: record.userId,
			operation: record.operation,
			method: record.method,
			card_id: record.cardId,
			outcome: record.outcome,
			reason: record.reason,
		}),
	);
}
