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
	| "unavailable"
	| "service_unreachable_route";

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

/** The longest excerpt of a response body that is reported or logged, in characters. */
export const RESPONSE_EXCERPT_LIMIT = 200;

/**
 * A response that did not come from Kanbus: the board service answered with an error status and a body that carries no
 * Kanbus error `code`. An API Gateway answering for an unrouted method or a denied caller looks like this.
 */
export class BoardServiceUncodedResponseError extends Error {
	readonly status: number;
	readonly bodyExcerpt: string;

	/**
	 * @param status The HTTP status of the response.
	 * @param bodyExcerpt The start of the response body, at most {@link RESPONSE_EXCERPT_LIMIT} characters.
	 */
	constructor(status: number, bodyExcerpt: string) {
		super(`The board service answered HTTP ${status} without a Kanbus error code.`);
		this.name = "BoardServiceUncodedResponseError";
		this.status = status;
		this.bodyExcerpt = bodyExcerpt;
	}
}

/** The whitespace-collapsed start of a response body, at most {@link RESPONSE_EXCERPT_LIMIT} characters, or `empty body`. */
export function excerptOfResponseBody(body: string): string {
	const collapsed = body.replace(/\s+/g, " ").trim();
	return collapsed === "" ? "empty body" : collapsed.slice(0, RESPONSE_EXCERPT_LIMIT);
}

function uncodedResponseFailure(error: BoardServiceUncodedResponseError): BoardFailure {
	const account = `The board service answered HTTP ${error.status} without a Kanbus error code (${error.bodyExcerpt})`;
	if (error.status >= 500) {
		return { kind: "unavailable", message: `${account}; the board service or its gateway failed. ${UNCONFIRMED_WRITE_MESSAGE}` };
	}
	if (error.status === 403) {
		return { kind: "service_unreachable_route", message: `${account}; the request was denied before it reached Kanbus, so the caller may not be allowed to call the board service` };
	}
	return { kind: "service_unreachable_route", message: `${account}; the request did not reach Kanbus or the route is not deployed` };
}

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
 * Map what the Kanbus client threw onto a board failure. A response that carries a Kanbus error code is reported as what
 * Kanbus said; only a Kanbus `not_found` code is the board or card not being found. A response without a Kanbus code
 * (for example an API Gateway 404 for an unrouted method) is reported with its status and body excerpt, and an
 * unreachable store or a server error is `unavailable`, which means the write was not confirmed.
 *
 * @param error Whatever the client call threw.
 * @returns The failure to report.
 */
export function failureFromError(error: unknown): BoardFailure {
	if (error instanceof BoardServiceUncodedResponseError) return uncodedResponseFailure(error);
	if (!(error instanceof KanbusApiError)) {
		const reason = error instanceof Error && error.message !== "" ? error.message : "no answer";
		return { kind: "unavailable", message: `The board service could not be reached (${reason}). ${UNCONFIRMED_WRITE_MESSAGE}` };
	}
	const { status, code, message } = error;
	if (code === "revision_conflict") return { kind: "conflict", code, message };
	if (code === "operation_conflict") return { kind: "operation_conflict", code, message };
	if (code === "board_archived") return { kind: "archived", code, message };
	if (status === 403 || code === "forbidden") return { kind: "forbidden", code: "forbidden", message: "The board store denied the request." };
	if (code === "not_found") return { kind: "not_found", code: "not_found", message: "The board or the card was not found." };
	if (VALIDATION_CODES.has(code)) return { kind: "invalid", code, message };
	return { kind: "unavailable", code, message: UNCONFIRMED_WRITE_MESSAGE };
}
