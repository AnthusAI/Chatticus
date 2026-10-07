import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";

/** Most attempts, the first included, one wrapped operation gets. */
export const TRANSIENT_RETRY_MAX_ATTEMPTS = 5;

/** Backoff ceiling of the first retry; each later retry doubles it. */
export const TRANSIENT_RETRY_BASE_DELAY_MILLISECONDS = 25;

/** Growth factor of the backoff ceiling between retries. */
export const TRANSIENT_RETRY_FACTOR = 2;

/** Most time, in total, the retries of one operation may spend sleeping. */
export const TRANSIENT_RETRY_BUDGET_MILLISECONDS = 2000;

/** Error names DynamoDB uses for a failure that a repeat of the same request is expected to clear. */
export const TRANSIENT_ERROR_NAMES: ReadonlySet<string> = new Set([
	"TransactionConflictException",
	"ThrottlingException",
	"ProvisionedThroughputExceededException",
	"RequestLimitExceeded",
	"InternalServerError",
	"ServiceUnavailable",
]);

/** Cancellation reason code of a transaction that lost to another transaction on the same item. */
export const TRANSACTION_CONFLICT_REASON = "TransactionConflict";

/** Cancellation reason code of a condition that really failed; a repeat fails the same way. */
export const CONDITION_FAILED_REASON = "ConditionalCheckFailed";

/** Knobs of {@link retryTransient}; every field defaults to the exported constant. */
export interface TransientRetryOptions {
	readonly maxAttempts?: number;
	readonly baseDelayMilliseconds?: number;
	readonly factor?: number;
	readonly budgetMilliseconds?: number;
	/** Resolves after the given milliseconds. Tests inject a recorder. */
	readonly sleep?: (milliseconds: number) => Promise<void>;
	/** Uniform in [0, 1). Tests inject a fixed sequence. */
	readonly random?: () => number;
}

/**
 * Whether a failure is a transient DynamoDB condition that a repeat of the same request is expected to clear.
 *
 * A canceled transaction is transient only when some item lost to a conflicting transaction and no item failed its
 * condition: a failed condition is real contention that the caller already handles and must never be retried.
 *
 * @param error Anything thrown by a DynamoDB call.
 * @returns true for conflicts, throttling and service-side faults.
 */
export function isTransientDynamoError(error: unknown): boolean {
	const name = (error as { name?: unknown } | null)?.name;
	if (error instanceof TransactionCanceledException || name === "TransactionCanceledException") {
		const reasons = (error as TransactionCanceledException).CancellationReasons ?? [];
		return (
			reasons.some((reason) => reason.Code === TRANSACTION_CONFLICT_REASON) &&
			!reasons.some((reason) => reason.Code === CONDITION_FAILED_REASON)
		);
	}
	return typeof name === "string" && TRANSIENT_ERROR_NAMES.has(name);
}

const defaultSleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Run an operation, repeating it with jittered exponential backoff while it fails with a transient DynamoDB error.
 *
 * The operation must be safe to repeat: a conflict or throttle means the request did not take effect, and the callers
 * wrap only writes that are conditioned or idempotent. Full jitter: each wait is uniform in [0, ceiling), the ceiling
 * doubling per retry. The last error is rethrown once attempts or the sleeping budget run out; a non-transient error is
 * rethrown at once.
 *
 * @param operation The call to make.
 * @param options Attempt, delay and budget limits plus injectable sleep and random.
 * @returns What the operation returned.
 */
export async function retryTransient<T>(operation: () => Promise<T>, options: TransientRetryOptions = {}): Promise<T> {
	const maxAttempts = options.maxAttempts ?? TRANSIENT_RETRY_MAX_ATTEMPTS;
	const base = options.baseDelayMilliseconds ?? TRANSIENT_RETRY_BASE_DELAY_MILLISECONDS;
	const factor = options.factor ?? TRANSIENT_RETRY_FACTOR;
	const budget = options.budgetMilliseconds ?? TRANSIENT_RETRY_BUDGET_MILLISECONDS;
	const sleep = options.sleep ?? defaultSleep;
	const random = options.random ?? Math.random;
	let slept = 0;
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await operation();
		} catch (error) {
			if (!isTransientDynamoError(error) || attempt >= maxAttempts) {
				throw error;
			}
			const delay = random() * base * factor ** (attempt - 1);
			if (slept + delay > budget) {
				throw error;
			}
			slept += delay;
			await sleep(delay);
		}
	}
}
