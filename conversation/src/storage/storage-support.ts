import { createHash } from "node:crypto";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type {
	Cursor,
	DocumentAddress,
	DocumentCreate,
	DocumentPoint,
	DocumentRecord,
	Page,
} from "@earendil-works/pi-durable";

/** One DynamoDB item in the low-level attribute-value shape. */
export type Item = Record<string, AttributeValue>;

/** DynamoDB allows at most this many items in one `TransactWriteItems`. */
export const TRANSACTION_ITEM_LIMIT = 100;

/** Attempts for transient failures of the S3 put and the index transaction. */
export const TRANSACTION_ATTEMPTS = 4;

/** Error names (and Node error codes) that are safe to retry. */
export const RETRYABLE_ERRORS = new Set([
	"ThrottlingException",
	"ProvisionedThroughputExceededException",
	"RequestLimitExceeded",
	"InternalServerError",
	"ServiceUnavailable",
	"TransactionInProgressException",
	"TimeoutError",
	"ECONNRESET",
	"ETIMEDOUT",
	"EPIPE",
]);

/** Per-item cancellation codes of a `TransactWriteItems` that are transient and worth retrying. */
export const TRANSIENT_CANCELLATIONS = new Set(["TransactionConflict", "ThrottlingError", "ProvisionedThroughputExceeded"]);

/**
 * Sleep with exponential backoff and jitter.
 *
 * @param attempt One-based attempt number that just failed.
 */
export const backoff = (attempt: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, Math.min(1000, 25 * 2 ** attempt) * (0.5 + Math.random())));

/**
 * This owner can no longer commit: a newer owner raised the fence or committed to the storage.
 *
 * Deliberately not a `StorageRejected`: pi-durable treats `StorageRejected` as an ordinary rollback and keeps running,
 * while any other commit error poisons the Session, so the stale owner stops calling models and running tools.
 */
export class OwnershipLost extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "OwnershipLost";
	}
}

/**
 * A commit whose outcome could not be determined: the transaction response was lost and the follow-up read failed.
 * Fatal like `OwnershipLost` (the Session is poisoned and the next owner finds out what landed), and callers must not
 * delete anything the commit may have made visible.
 */
export class CommitOutcomeUnknown extends OwnershipLost {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "CommitOutcomeUnknown";
	}
}

/** Whether a commit with a given token landed: it did, it did not, or the check itself failed. */
export type CommitState = "committed" | "not-committed" | "unknown";

/**
 * Partition identity of one bot's channel storage.
 *
 * @param tenantId Tenant identifier.
 * @param botId Bot identifier.
 * @param channelId Channel identifier.
 * @returns `${tenantId}#${botId}#${channelId}`.
 */
export const storageIdFor = (tenantId: string, botId: string, channelId: string): string =>
	`${tenantId}#${botId}#${channelId}`;

/**
 * Owner fence for one turn: strictly increasing across prompts and across retries of one prompt.
 *
 * @param promptMessageSeq Sequence number of the prompt message that started the turn.
 * @param turnFenceToken Per-prompt turn token in the range 1 to 999.
 * @returns `promptMessageSeq * 1000 + turnFenceToken`.
 * @throws RangeError When the token is below 1 or at least 1000.
 */
export const fenceFor = (promptMessageSeq: number, turnFenceToken: number): number => {
	if (!Number.isInteger(turnFenceToken) || turnFenceToken < 1 || turnFenceToken >= 1000) {
		throw new RangeError(`turnFenceToken must be an integer from 1 to 999, got ${turnFenceToken}`);
	}
	return promptMessageSeq * 1000 + turnFenceToken;
};

export const pad = (value: number): string => String(value).padStart(16, "0");
export const digest = (value: string): string => createHash("sha256").update(value).digest("base64url");
export const parse = <T>(text: string): T => JSON.parse(text) as T;
export const encode = (value: unknown): string => JSON.stringify(value);

export const scopeKey = (scope: DocumentRecord["scope"]): string => {
	switch (scope.kind) {
		case "session":
			return encode(["session"]);
		case "conversation":
			return encode(["conversation", scope.conversationId]);
		case "task":
			return encode(["task", scope.taskId]);
	}
};

export const addressKey = (address: DocumentAddress): string =>
	encode([address.kind, scopeKey(address.scope), address.key === undefined ? ["singleton"] : ["family", address.key]]);

export const recordAddressKey = (record: DocumentRecord | DocumentCreate): string =>
	addressKey({ kind: record.kind, scope: record.scope, key: record.key });

export const isAliveAt = (record: DocumentRecord, at: DocumentPoint): boolean => {
	if (at === "current") return record.retiredAt === undefined;
	return record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt);
};

export const isCurrentOnly = (record: DocumentRecord | DocumentCreate): boolean =>
	record.scope.kind !== "conversation" || record.history === "latest";

export const cursorAfter = (cursor: Cursor | undefined): number | undefined => {
	const after = cursor?.after;
	if (after === undefined) return undefined;
	if (typeof after !== "number" || !Number.isSafeInteger(after)) throw new TypeError("Invalid storage cursor");
	return after;
};

export const page = <T extends { readonly id: number }>(values: readonly T[], limit: number): Page<T, Cursor> => {
	const items = values.slice(0, limit);
	if (values.length <= limit) return { items };
	return { items, next: { after: items.at(-1)!.id } };
};

export const text = (item: Item, name: string): string | undefined => item[name]?.S;
export const number = (item: Item, name: string): number | undefined =>
	item[name]?.N === undefined ? undefined : Number(item[name]!.N);

/** Time source for domain functions. */
export interface Clock {
	now(): Date;
}
