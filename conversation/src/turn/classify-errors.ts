import { redactSecrets } from "./tool-event-fields.ts";

/** The member-readable reason for a provider that refused the request for want of credits. */
export const OUT_OF_QUOTA_REASON = "The model provider refused the request: the account is out of credits or over its quota.";

/** The member-readable reason for a call the model gateway refused because the organization reached its monthly model spend ceiling. */
export const MODEL_SPEND_CEILING_REASON =
	"The organization has reached its monthly model spend ceiling, so no more model calls are made until next month.";

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
const ERROR_MESSAGE = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const OUT_OF_QUOTA_MARKER = /insufficient_quota|credit_balance_exhausted|no credits remaining/i;
const SECRET_TOKEN = /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~+/-]{8,}/g;

/** The longest provider message a log line carries. */
export const PROVIDER_MESSAGE_LOG_LIMIT = 300;

function unescapeJsonString(body: string): string {
	try {
		return JSON.parse(`"${body}"`) as string;
	} catch {
		return body;
	}
}

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
	if (OUT_OF_QUOTA_MARKER.test(text)) return OUT_OF_QUOTA_REASON;
	if (code === "model_spend_ceiling_reached") return MODEL_SPEND_CEILING_REASON;
	if (status === 401 || code === "invalid_api_key") return REJECTED_KEY_REASON;
	if (code === "model_access_denied" || (status === 403 && code !== null)) return ACCESS_DENIED_REASON;
	if (code === "unsupported_value" || code === "invalid_request_error" || ((status === 400 || status === 404) && code !== null)) {
		return INVALID_REQUEST_REASON;
	}
	return GENERIC_FAILURE_REASON;
}

/** What a log line says about a failed model call. */
export type ProviderFailureSummary = { readonly status: number | null; readonly code: string | null; readonly message: string };

/**
 * Summarise the provider text of a failed model call for one log line: the HTTP status and the provider's error code when
 * the text carries them, and the provider's message with anything shaped like a key or bearer token removed, cut to
 * {@link PROVIDER_MESSAGE_LOG_LIMIT} characters. A streamed error event carries only a message, so its status and code are null.
 *
 * @param detail The `detail` of the settled submission.
 * @returns The status, code and message.
 */
export function summarizeProviderFailure(detail: unknown): ProviderFailureSummary {
	const text = typeof detail === "string" ? detail : JSON.stringify(detail ?? "");
	const { status, code } = parseProviderFailure(text);
	const body = ERROR_MESSAGE.exec(text)?.[1];
	const readable = body === undefined ? text : unescapeJsonString(body);
	const message = redactSecrets(readable).replace(SECRET_TOKEN, "[redacted]");
	return { status, code, message: message.length > PROVIDER_MESSAGE_LOG_LIMIT ? message.slice(0, PROVIDER_MESSAGE_LOG_LIMIT) : message };
}
