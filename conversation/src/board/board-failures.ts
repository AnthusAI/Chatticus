import { KanbusApiError, type KanbusIssueWithRevision } from "@kanbus/api-client";

/** Why a board operation did not succeed, in the terms the bot, the owner and the tests act on. */
export type BoardFailureKind =
	| "forbidden"
	| "not_found"
	| "conflict"
	| "operation_conflict"
	| "invalid"
	| "refused"
	| "archived"
	| "unavailable";

/** One failed board operation. */
export type BoardFailure = {
	readonly kind: BoardFailureKind;
	readonly message: string;
	/** The Kanbus error code when the board store answered with one. */
	readonly code?: string;
	/** On a conflict, the card as the store now has it, when it could be read. */
	readonly currentCard?: KanbusIssueWithRevision;
};

/** The outcome of one board operation: either its value, or the reason it failed. Never both, never a guess. */
export type BoardResult<Value> =
	| { readonly ok: true; readonly value: Value; readonly listingMayBeBehind: boolean }
	| { readonly ok: false; readonly failure: BoardFailure };

/** The message that tells a caller a write was not confirmed and may or may not be stored. */
export const UNCONFIRMED_WRITE_MESSAGE =
	"The board store did not confirm the change, so it is reported as not saved. It may or may not have been stored: read the card or the board before repeating it, or repeat the call exactly, with the same operation_key and the revision_used the result names.";

const VALIDATION_CODES: ReadonlySet<string> = new Set([
	"invalid_request",
	"invalid_issue",
	"invalid_configuration",
	"configuration_invalid",
	"configuration_missing",
	"unsupported_relation_mutation",
	"relation_target_missing",
	"hierarchy_violation",
	"issue_has_children",
	"issue_has_dependents",
	"type_change_unsupported",
	"revision_required",
	"board_not_archived",
	"query_budget_exceeded",
]);

/**
 * Map what the Kanbus client threw onto a board failure. A response that the store sent is reported as what it said;
 * anything else (an unreachable store, a server error, a body that is not a Kanbus error) is `unavailable`, which means
 * the write was not confirmed.
 *
 * @param error Whatever the client call threw.
 * @returns The failure to report.
 */
export function failureFromError(error: unknown): BoardFailure {
	if (!(error instanceof KanbusApiError)) {
		return { kind: "unavailable", message: UNCONFIRMED_WRITE_MESSAGE };
	}
	const { status, code, message } = error;
	if (code === "revision_conflict") return { kind: "conflict", code, message };
	if (code === "operation_conflict") return { kind: "operation_conflict", code, message };
	if (code === "board_archived") return { kind: "archived", code, message };
	if (status === 403 || code === "forbidden") return { kind: "forbidden", code: "forbidden", message: "The board store denied the request." };
	if (status === 404 || code === "not_found") return { kind: "not_found", code: "not_found", message: "The board or the card was not found." };
	if (VALIDATION_CODES.has(code)) return { kind: "invalid", code, message };
	return { kind: "unavailable", code, message: UNCONFIRMED_WRITE_MESSAGE };
}
