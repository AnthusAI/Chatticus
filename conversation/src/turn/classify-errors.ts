/** The member-readable reason for a provider that refused the request for want of credits. */
export const OUT_OF_QUOTA_REASON = "The model provider refused the request: the account is out of credits or over its quota.";

/** The member-readable reason for a rejected API key. */
export const REJECTED_KEY_REASON = "The model provider rejected the API key.";

/** The member-readable reason for a model the key may not use. */
export const ACCESS_DENIED_REASON = "The model provider denied access to the configured model.";

/** The member-readable reason for a request the provider found invalid. */
export const INVALID_REQUEST_REASON = "The model provider rejected the request as invalid.";

/** The member-readable reason for every other failure of the model call. */
export const GENERIC_FAILURE_REASON = "The model provider failed to produce an answer.";

const STATUS_IN_PARENTHESES = /\((\d{3})\)/;
const STATUS_AT_START = /^(\d{3})\b/;
const ERROR_CODE = /"code"\s*:\s*"([^"]+)"/;
const ERROR_TYPE = /"type"\s*:\s*"([^"]+)"/;

type ProviderFailure = { status: number | null; code: string | null };

function parseProviderFailure(text: string): ProviderFailure {
	const statusText = STATUS_IN_PARENTHESES.exec(text)?.[1] ?? STATUS_AT_START.exec(text)?.[1];
	const code = ERROR_CODE.exec(text)?.[1] ?? ERROR_TYPE.exec(text)?.[1] ?? null;
	return { status: statusText === undefined ? null : Number(statusText), code };
}

/**
 * Turn the provider text of a failed model call into the reason shown to the member. The text is the `detail` of a
 * settled `unanswered`/`model_error` submission: pi-ai formats an HTTP failure as the status and the provider's JSON
 * error body. Every failure is final for the turn (Pi has already retried what it may retry); the member retries with a
 * new turn. A status with no error body, or any other text, gets the generic reason.
 *
 * @param detail The `detail` of the settled submission.
 * @returns A reason a person can act on.
 */
export function classifyModelFailure(detail: unknown): string {
	const text = typeof detail === "string" ? detail : JSON.stringify(detail ?? "");
	const { status, code } = parseProviderFailure(text);
	if (code === "insufficient_quota") return OUT_OF_QUOTA_REASON;
	if (status === 401 || code === "invalid_api_key") return REJECTED_KEY_REASON;
	if (code === "model_access_denied" || (status === 403 && code !== null)) return ACCESS_DENIED_REASON;
	if (code === "unsupported_value" || code === "invalid_request_error" || ((status === 400 || status === 404) && code !== null)) {
		return INVALID_REQUEST_REASON;
	}
	return GENERIC_FAILURE_REASON;
}
