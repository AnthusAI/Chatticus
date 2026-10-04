import { createHash, randomUUID } from "node:crypto";
import {
	BatchGetItemCommand,
	BatchWriteItemCommand,
	type DynamoDBClient,
	GetItemCommand,
	PutItemCommand,
	QueryCommand,
	type TransactWriteItem,
	TransactWriteItemsCommand,
	UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { applyImmutableBatches, type Op } from "@earendil-works/chord/delta";
import {
	type ConversationId,
	type ConversationQuery,
	type ConversationRecord,
	type Cursor,
	type DocumentAddress,
	type DocumentContent,
	type DocumentCreate,
	type DocumentId,
	type DocumentPoint,
	type DocumentQuery,
	type DocumentRecord,
	type EntryId,
	type EntryQuery,
	type EntryRecord,
	type Id,
	type JsonObject,
	type Page,
	type Seq,
	type Storage,
	StorageRejected,
	type StorageWrite,
	type StoredDocument,
	type SubmissionId,
	type SubmissionQuery,
	type SubmissionRecord,
	type TaskId,
	type TaskQuery,
	type TaskRecord,
} from "@earendil-works/pi-durable";
import { Meter } from "./meter.ts";
import type { Item } from "./table.ts";

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type TableName = "conversation" | "entry" | "task" | "submission" | "document";
type DocumentRevision = DocumentContent & { readonly seq: Seq };
type DocumentAction = { create?: DocumentCreate; content?: DocumentContent; retire: boolean };
type StoredDocumentItem = { record: DocumentRecord; latestVersion: number | undefined; latestSeq: number | undefined };

export const TRANSACTION_ITEM_LIMIT = 100;
export const TRANSACTION_BYTE_LIMIT = 4 * 1024 * 1024;
export const ITEM_BYTE_LIMIT = 400 * 1024;
export const QUERY_PAGE_SIZE = 100;
export const TRANSACTION_ATTEMPTS = 4;
const CLEANUP_ATTEMPTS = 5;
const MATERIALIZE_ATTEMPTS = 3;
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
export const TRANSIENT_CANCELLATIONS = new Set(["TransactionConflict", "ThrottlingError", "ProvisionedThroughputExceeded"]);

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

/** Measurements of one successful or rejected commit, for the spike's reports. */
export type CommitMeasurement = {
	readonly seq: number | undefined;
	readonly writes: number;
	readonly writeKinds: Readonly<Record<string, number>>;
	readonly transactionItems: number;
	readonly transactionBytes: number;
	readonly largestItemBytes: number;
	readonly preReads: number;
	readonly milliseconds: number;
	readonly rejected?: string;
	readonly transactionAttempts?: number;
	readonly cleanupError?: string;
};

/** Options for one DynamoDB-backed pi-durable storage, which is one partition of the shared table. */
export type DynamoDbStorageOptions = {
	readonly client: DynamoDBClient;
	readonly tableName: string;
	/** Partition identity, for example `tenant#bot#channel`. */
	readonly storageId: string;
	/** When set, every commit carries a condition that the partition's owner fence still equals this value. */
	readonly fence?: number;
	readonly onCommit?: (measurement: CommitMeasurement) => void;
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

const itemBytes = (item: Item): number => {
	let total = 0;
	for (const [name, value] of Object.entries(item)) {
		total += Buffer.byteLength(name);
		if (value.S !== undefined) total += Buffer.byteLength(value.S);
		else if (value.N !== undefined) total += value.N.length;
		else total += 8;
	}
	return total;
};

export const text = (item: Item, name: string): string | undefined => item[name]?.S;
export const number = (item: Item, name: string): number | undefined =>
	item[name]?.N === undefined ? undefined : Number(item[name]!.N);

/**
 * pi-durable `Storage` on one DynamoDB partition.
 *
 * Every record lives at `R#<id>` so the Session-global ID namespace is enforced by key. Ordered and filtered
 * scans use three local secondary indexes, which are strongly consistent. Document revisions live at
 * `V#<document>#<seq>`. `META` holds the commit sequence and the ID high-water mark; every commit updates it
 * under a condition on the sequence this owner last saw, so two owners can never interleave commits.
 */
export class DynamoDbStorage implements Storage {
	readonly measurements: CommitMeasurement[] = [];
	readonly meter = new Meter();
	private readonly client: DynamoDBClient;
	private readonly tableName: string;
	private readonly pk: string;
	private readonly fence: number | undefined;
	private readonly onCommit: ((measurement: CommitMeasurement) => void) | undefined;
	private seq = 0;
	private nextId = 2;
	private closed = false;
	private preReads = 0;

	/** Read round trips this storage has made, including the reads a commit needed before its transaction. */
	get reads(): number {
		return this.preReads;
	}

	private constructor(options: DynamoDbStorageOptions) {
		this.client = options.client;
		this.tableName = options.tableName;
		this.pk = `PI#${options.storageId}`;
		this.fence = options.fence;
		this.onCommit = options.onCommit;
	}

	/**
	 * Open (and on first use create) one storage partition and load its commit sequence and ID high-water mark.
	 *
	 * @param options Storage options.
	 * @returns The open storage.
	 */
	static async open(options: DynamoDbStorageOptions): Promise<DynamoDbStorage> {
		const storage = new DynamoDbStorage(options);
		await storage.load();
		return storage;
	}

	/**
	 * Raise the partition's owner fence. Fails when a newer or equal fence already holds it.
	 *
	 * @param options Client, table, partition, and the new fence.
	 */
	static async claimOwnership(options: {
		readonly client: DynamoDBClient;
		readonly tableName: string;
		readonly storageId: string;
		readonly fence: number;
	}): Promise<void> {
		await options.client.send(
			new UpdateItemCommand({
				TableName: options.tableName,
				Key: { pk: { S: `PI#${options.storageId}` }, sk: { S: "OWNER" } },
				UpdateExpression: "SET fence = :fence",
				ConditionExpression: "attribute_not_exists(fence) OR fence < :fence",
				ExpressionAttributeValues: { ":fence": { N: String(options.fence) } },
			}),
		);
	}

	private async load(): Promise<void> {
		const meta = await this.getItem("META");
		if (meta === undefined) {
			try {
				await this.client.send(
					new PutItemCommand({
						TableName: this.tableName,
						Item: { pk: { S: this.pk }, sk: { S: "META" }, seq: { N: "0" }, nextId: { N: "2" } },
						ConditionExpression: "attribute_not_exists(pk)",
					}),
				);
			} catch (error) {
				if ((error as Error).name !== "ConditionalCheckFailedException") throw error;
				await this.load();
			}
			return;
		}
		this.seq = number(meta, "seq")!;
		this.nextId = number(meta, "nextId")!;
	}

	async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
		this.assertOpen();
		const started = performance.now();
		const preReadsBefore = this.preReads;
		const seq = this.seq + 1;
		const writeKinds: Record<string, number> = {};
		for (const write of writes) writeKinds[write.type] = (writeKinds[write.type] ?? 0) + 1;
		const measure = (partial: Partial<CommitMeasurement>): CommitMeasurement => ({
			seq: undefined,
			writes: writes.length,
			writeKinds,
			transactionItems: 0,
			transactionBytes: 0,
			largestItemBytes: 0,
			preReads: this.preReads - preReadsBefore,
			milliseconds: performance.now() - started,
			...partial,
		});
		let transactionAttempts = 0;
		let committed: {
			transactionItems: number;
			transactionBytes: number;
			largestItemBytes: number;
			cleanups: RevisionCleanup[];
		};
		try {
			const detached = parse<StorageWrite[]>(encode(writes));
			const resolved = await this.resolveDocumentCopies(detached);
			this.checkBatchIds(resolved);
			const actions = this.prepareDocumentActions(resolved);
			const existingDocuments = await this.checkDocumentActions(actions);
			const plan = this.planTransaction(resolved, actions, existingDocuments, seq);
			const transactionBytes = plan.items.reduce((sum, entry) => sum + entry.bytes, 0);
			const largestItemBytes = plan.items.reduce((max, entry) => Math.max(max, entry.bytes), 0);
			if (plan.items.length > TRANSACTION_ITEM_LIMIT) {
				throw new StorageRejected(
					`Commit needs ${plan.items.length} transaction items; DynamoDB allows ${TRANSACTION_ITEM_LIMIT}`,
				);
			}
			if (transactionBytes > TRANSACTION_BYTE_LIMIT) {
				throw new StorageRejected(`Commit needs ${transactionBytes} bytes; DynamoDB allows ${TRANSACTION_BYTE_LIMIT}`);
			}
			if (largestItemBytes > ITEM_BYTE_LIMIT) {
				throw new StorageRejected(`Commit writes a ${largestItemBytes} byte item; DynamoDB allows ${ITEM_BYTE_LIMIT}`);
			}
			transactionAttempts = await this.transact(plan.items, plan.token);
			this.seq = seq;
			this.nextId = Math.max(this.nextId, plan.highestId + 1);
			committed = { transactionItems: plan.items.length, transactionBytes, largestItemBytes, cleanups: plan.cleanups };
		} catch (error) {
			this.record(measure({ rejected: `${(error as Error).name}: ${(error as Error).message}`, transactionAttempts }));
			throw error;
		}
		const cleanupError = await this.cleanRevisionsBestEffort(committed.cleanups);
		this.record(
			measure({
				seq,
				transactionItems: committed.transactionItems,
				transactionBytes: committed.transactionBytes,
				largestItemBytes: committed.largestItemBytes,
				transactionAttempts,
				...(cleanupError === undefined ? {} : { cleanupError }),
			}),
		);
		return seq as Seq;
	}

	private record(measurement: CommitMeasurement): void {
		this.measurements.push(measurement);
		this.onCommit?.(measurement);
	}

	/**
	 * Send one commit's transaction, retrying transient failures with the same idempotency token.
	 *
	 * The client is built with `maxAttempts: 1`, so every retry happens here, where it is visible: the same
	 * `ClientRequestToken` makes DynamoDB apply a resent transaction at most once (within ten minutes), and
	 * `META.token` records which commit last moved the sequence, so a retry whose first attempt landed but whose
	 * response was lost is recognized as committed instead of being reported as a conflict.
	 *
	 * @returns The number of attempts used.
	 */
	private async transact(entries: readonly PlannedItem[], token: string): Promise<number> {
		for (let attempt = 1; ; attempt++) {
			try {
				this.meter.transaction(entries.map((entry) => entry.meterItem));
				await this.client.send(
					new TransactWriteItemsCommand({
						TransactItems: entries.map((entry) => entry.request),
						ClientRequestToken: token,
					}),
				);
				return attempt;
			} catch (error) {
				const name = (error as Error).name;
				const code = (error as { code?: string }).code;
				if (name !== "TransactionCanceledException") {
					const retryable = RETRYABLE_ERRORS.has(name) || (code !== undefined && RETRYABLE_ERRORS.has(code));
					if (retryable && attempt < TRANSACTION_ATTEMPTS) {
						await backoff(attempt);
						continue;
					}
					const state = await this.committedWithToken(token);
					if (state === "committed") return attempt;
					if (state === "unknown") {
						throw new CommitOutcomeUnknown("Commit outcome unknown: the response was lost and the check failed", {
							cause: error,
						});
					}
					throw error;
				}
				const reasons = (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
				const conditionFailures = entries.filter((_, index) => reasons[index]?.Code === "ConditionalCheckFailed");
				if (conditionFailures.some((entry) => entry.role === "owner")) {
					throw new OwnershipLost("Owner fence moved: this owner is stale", { cause: error });
				}
				if (conditionFailures.some((entry) => entry.role === "meta")) {
					const state = await this.committedWithToken(token);
					if (state === "committed") return attempt;
					if (state === "unknown") {
						throw new CommitOutcomeUnknown("Commit outcome unknown: the sequence check failed and the token read failed", {
							cause: error,
						});
					}
					throw new OwnershipLost("Commit sequence moved: another owner committed to this storage", {
						cause: error,
					});
				}
				const recordFailure = conditionFailures.find((entry) => entry.role === "record" && entry.id !== undefined);
				if (recordFailure !== undefined) {
					const existing = await this.getItem(`R#${pad(recordFailure.id!)}`);
					const table = existing === undefined ? "another record" : text(existing, "t");
					throw new StorageRejected(`ID ${recordFailure.id} already belongs to ${table}`, { cause: error });
				}
				const transient = reasons.some((reason) => reason.Code !== undefined && TRANSIENT_CANCELLATIONS.has(reason.Code));
				if (transient && attempt < TRANSACTION_ATTEMPTS) {
					await backoff(attempt);
					continue;
				}
				if (transient) {
					throw new OwnershipLost(
						`Transaction kept conflicting after ${attempt} attempts (${reasons.map((reason) => reason.Code ?? "None").join(",")})`,
						{ cause: error },
					);
				}
				throw new StorageRejected(`Transaction was cancelled: ${(error as Error).message}`, { cause: error });
			}
		}
	}

	private async committedWithToken(token: string): Promise<CommitState> {
		try {
			const meta = await this.getItem("META");
			return meta !== undefined && text(meta, "token") === token ? "committed" : "not-committed";
		} catch {
			return "unknown";
		}
	}

	private planTransaction(
		writes: readonly StorageWrite[],
		actions: ReadonlyMap<DocumentId, DocumentAction>,
		existingDocuments: ReadonlyMap<DocumentId, StoredDocumentItem>,
		seq: number,
	): { items: PlannedItem[]; highestId: number; cleanups: RevisionCleanup[]; token: string } {
		const token = randomUUID();
		const items: PlannedItem[] = [];
		const cleanups: RevisionCleanup[] = [];
		let highestId = 0;
		const lastRecordWrite = new Map<number, Exclude<StorageWrite, { type: `document.${string}` }>>();
		for (const write of writes) {
			if (write.type === "conversation" || write.type === "entry" || write.type === "task" || write.type === "submission") {
				lastRecordWrite.set(write.value.id, write);
			}
		}
		for (const write of lastRecordWrite.values()) {
			highestId = Math.max(highestId, write.value.id);
			const item = this.recordItem(write, seq);
			const once = write.type === "conversation" || write.type === "entry";
			items.push(
				this.planned("record", write.value.id, {
					Put: {
						TableName: this.tableName,
						Item: item,
						ConditionExpression: once ? "attribute_not_exists(pk)" : "attribute_not_exists(pk) OR t = :t",
						...(once ? {} : { ExpressionAttributeValues: { ":t": { S: write.type } } }),
					},
				}),
			);
		}
		for (const [id, action] of actions) {
			highestId = Math.max(highestId, id);
			const existing = existingDocuments.get(id);
			const baseRecord: DocumentRecord =
				action.create !== undefined
					? ({ ...action.create, createdAt: seq } as DocumentRecord)
					: existing!.record;
			const record: DocumentRecord = action.retire ? { ...baseRecord, retiredAt: seq as Seq } : baseRecord;
			const currentOnly = isCurrentOnly(record);
			const writesRevision = action.content !== undefined && !(action.retire && currentOnly);
			const latestVersion = writesRevision ? action.content!.version : existing?.latestVersion;
			const latestSeq = writesRevision ? seq : existing?.latestSeq;
			items.push(
				this.planned("record", id, {
					Put: {
						TableName: this.tableName,
						Item: this.documentItem(record, latestVersion, latestSeq),
						ConditionExpression:
							action.create !== undefined ? "attribute_not_exists(pk)" : "attribute_exists(pk) AND t = :t",
						...(action.create !== undefined ? {} : { ExpressionAttributeValues: { ":t": { S: "document" } } }),
					},
				}),
			);
			if (writesRevision) {
				items.push(
					this.planned("revision", id, {
						Put: {
							TableName: this.tableName,
							Item: {
								pk: { S: this.pk },
								sk: { S: `V#${pad(id)}#${pad(seq)}` },
								c: { S: encode(action.content) },
							},
						},
					}),
				);
			}
			if (action.create === undefined && currentOnly) {
				if (action.retire) cleanups.push({ id, belowSeq: seq + 1 });
				else if (action.content?.kind === "base") cleanups.push({ id, belowSeq: seq });
			}
		}
		const metaValues: Item = {
			":expected": { N: String(this.seq) },
			":seq": { N: String(seq) },
			":nextId": { N: String(Math.max(this.nextId, highestId + 1)) },
			":token": { S: token },
		};
		items.push(
			this.planned("meta", undefined, {
				Update: {
					TableName: this.tableName,
					Key: { pk: { S: this.pk }, sk: { S: "META" } },
					UpdateExpression: "SET seq = :seq, nextId = :nextId, #token = :token",
					ExpressionAttributeNames: { "#token": "token" },
					ConditionExpression: "seq = :expected",
					ExpressionAttributeValues: metaValues,
				},
			}),
		);
		if (this.fence !== undefined) {
			items.push(
				this.planned("owner", undefined, {
					ConditionCheck: {
						TableName: this.tableName,
						Key: { pk: { S: this.pk }, sk: { S: "OWNER" } },
						ConditionExpression: "fence = :fence",
						ExpressionAttributeValues: { ":fence": { N: String(this.fence) } },
					},
				}),
			);
		}
		return { items, highestId, cleanups, token };
	}

	private planned(role: PlannedItem["role"], id: number | undefined, request: TransactWriteItem): PlannedItem {
		const item = request.Put?.Item ?? request.Update?.ExpressionAttributeValues ?? {};
		const meterItem =
			request.Put?.Item ??
			(request.Update !== undefined ? { ...request.Update.Key, ...request.Update.ExpressionAttributeValues } : undefined) ??
			request.ConditionCheck?.Key ??
			{};
		return { role, id, request, bytes: itemBytes(item), meterItem };
	}

	private recordItem(
		write: Exclude<StorageWrite, { type: `document.${string}` }>,
		seq: number,
	): Item {
		const id = write.value.id;
		const item: Item = {
			pk: { S: this.pk },
			sk: { S: `R#${pad(id)}` },
			t: { S: write.type },
			v: { S: encode(write.value) },
		};
		switch (write.type) {
			case "conversation": {
				item.l1 = { S: `C#${pad(id)}` };
				const owner = write.value.owner;
				if (owner !== undefined) {
					item.l2 = { S: `CT#${pad(owner.taskId)}#${pad(id)}` };
					item.l3 = { S: `CC#${pad(owner.conversationId)}#${pad(id)}` };
				}
				break;
			}
			case "entry":
				item.s = { N: String(seq) };
				item.l1 = { S: `E#${pad(write.value.conversationId)}#${pad(id)}` };
				if (write.value.head !== undefined) item.l2 = { S: `H#${pad(write.value.conversationId)}#${pad(id)}` };
				break;
			case "task":
				item.l1 = { S: `T#${pad(id)}` };
				item.l2 = { S: `TS#${write.value.state.status}#${pad(id)}` };
				break;
			case "submission":
				item.l1 = { S: `S#${pad(id)}` };
				item.l2 = { S: `SS#${write.value.status}#${pad(id)}` };
				if (write.value.requestId !== undefined) {
					item.l3 = {
						S: `SR#${pad(write.value.conversationId)}#${digest(encode(write.value.requestId))}#${pad(id)}`,
					};
				}
				break;
		}
		return item;
	}

	private documentItem(record: DocumentRecord, latestVersion: number | undefined, latestSeq: number | undefined): Item {
		const item: Item = {
			pk: { S: this.pk },
			sk: { S: `R#${pad(record.id)}` },
			t: { S: "document" },
			v: { S: encode(record) },
			l1: { S: `D#${digest(scopeKey(record.scope))}#${pad(record.id)}` },
			l2: { S: `DA#${digest(recordAddressKey(record))}#${pad(record.id)}` },
		};
		if (latestVersion !== undefined) item.ver = { N: String(latestVersion) };
		if (latestSeq !== undefined) item.last = { N: String(latestSeq) };
		return item;
	}

	/**
	 * Delete revisions a committed base or retirement made unreachable. Runs after the transaction landed and never
	 * fails the commit: anything left behind is garbage that reads never reach.
	 *
	 * @returns The error text when some revisions were left behind.
	 */
	private async cleanRevisionsBestEffort(cleanups: readonly RevisionCleanup[]): Promise<string | undefined> {
		if (cleanups.length === 0) return undefined;
		try {
			await this.cleanRevisions(cleanups);
			return undefined;
		} catch (error) {
			const message = `${(error as Error).name}: ${(error as Error).message}`;
			process.stderr.write(`[dynamodb-storage] revision cleanup left garbage: ${message}\n`);
			return message;
		}
	}

	private async cleanRevisions(cleanups: readonly RevisionCleanup[]): Promise<void> {
		for (const cleanup of cleanups) {
			const keys: Item[] = [];
			for await (const item of this.iterate(
				undefined,
				`V#${pad(cleanup.id)}#`,
				`V#${pad(cleanup.id)}#${pad(cleanup.belowSeq - 1)}`,
				true,
			)) {
				keys.push({ pk: item.pk!, sk: item.sk! });
			}
			for (let index = 0; index < keys.length; index += 25) {
				let requests: { DeleteRequest: { Key: Item } }[] | undefined = keys
					.slice(index, index + 25)
					.map((Key) => ({ DeleteRequest: { Key } }));
				for (let attempt = 1; requests !== undefined && requests.length > 0; attempt++) {
					if (attempt > CLEANUP_ATTEMPTS) throw new Error(`${requests.length} revision deletes still unprocessed`);
					if (attempt > 1) await backoff(attempt);
					this.meter.writes(requests.map((request) => request.DeleteRequest.Key));
					const response = await this.client.send(
						new BatchWriteItemCommand({ RequestItems: { [this.tableName]: requests } }),
					);
					requests = response.UnprocessedItems?.[this.tableName] as typeof requests;
				}
			}
		}
	}

	private async resolveDocumentCopies(writes: StorageWrite[]): Promise<StorageWrite[]> {
		if (!writes.some((write) => write.type === "document.copy")) return writes;
		const changed = new Set<number>();
		for (const write of writes) {
			if (write.type === "document.create" || write.type === "document.copy") changed.add(write.record.id);
			else if (write.type === "document.change" || write.type === "document.retire") changed.add(write.id);
		}
		const resolved: StorageWrite[] = [];
		for (const write of writes) {
			if (write.type !== "document.copy") {
				resolved.push(write);
				continue;
			}
			try {
				if (changed.has(write.source.id)) {
					throw new Error(`Fork source document ${write.source.id} is changed in the copy batch`);
				}
				const stored = await this.materialize(write.source.id, write.source.at);
				if (stored === undefined) throw new Error(`Fork source document ${write.source.id} cannot be read`);
				if (
					stored.record.scope.kind !== "conversation" ||
					write.record.scope.kind !== "conversation" ||
					stored.record.kind !== write.record.kind ||
					stored.record.key !== write.record.key ||
					stored.record.history !== write.record.history ||
					stored.record.fork !== write.record.fork
				) {
					throw new Error(`Fork source document ${write.source.id} does not match the copied record`);
				}
				resolved.push({
					type: "document.create",
					record: write.record,
					content: { kind: "base", version: stored.version, value: stored.value },
				});
			} catch (error) {
				if (error instanceof StorageRejected) throw error;
				throw new StorageRejected(`Document copy ${write.record.id} was rejected`, { cause: error });
			}
		}
		return resolved;
	}

	private checkBatchIds(writes: readonly StorageWrite[]): void {
		const claimed = new Map<number, TableName>();
		for (const write of writes) {
			if (write.type === "document.change" || write.type === "document.retire") continue;
			const document = write.type === "document.create" || write.type === "document.copy";
			const table: TableName = document ? "document" : (write.type as TableName);
			const id = document ? write.record.id : write.value.id;
			const earlier = claimed.get(id);
			if (table === "conversation" || table === "entry" || table === "document") {
				if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
			} else if (earlier !== undefined && earlier !== table) {
				throw new Error(`ID ${id} is written as two record types`);
			}
			claimed.set(id, table);
		}
	}

	private prepareDocumentActions(writes: readonly StorageWrite[]): Map<DocumentId, DocumentAction> {
		const actions = new Map<DocumentId, DocumentAction>();
		for (const write of writes) {
			if (write.type !== "document.create" && write.type !== "document.change" && write.type !== "document.retire") {
				continue;
			}
			const id = write.type === "document.create" ? write.record.id : write.id;
			let action = actions.get(id);
			if (action === undefined) {
				action = { retire: false };
				actions.set(id, action);
			}
			switch (write.type) {
				case "document.create":
					if (action.create !== undefined || action.content !== undefined) {
						throw new Error(`Document ${id} has more than one content command`);
					}
					action.create = write.record;
					action.content = write.content;
					break;
				case "document.change":
					if (action.content !== undefined) throw new Error(`Document ${id} has more than one content command`);
					action.content = write.content;
					break;
				case "document.retire":
					if (action.retire) throw new Error(`Document ${id} is retired more than once`);
					action.retire = true;
					break;
			}
		}
		return actions;
	}

	private async checkDocumentActions(
		actions: ReadonlyMap<DocumentId, DocumentAction>,
	): Promise<Map<DocumentId, StoredDocumentItem>> {
		const existingDocuments = new Map<DocumentId, StoredDocumentItem>();
		if (actions.size === 0) return existingDocuments;
		const items = await this.batchGet([...actions.keys()].map((id) => `R#${pad(id)}`));
		for (const [id, action] of actions) {
			const item = items.get(`R#${pad(id)}`);
			const table = item === undefined ? undefined : text(item, "t");
			if (action.create !== undefined && item !== undefined) {
				if (table !== "document") throw new Error(`ID ${id} already belongs to ${table}`);
				throw new Error(`Document ${id} already exists`);
			}
			if (action.create === undefined && (item === undefined || table !== "document")) {
				throw new Error(`Unknown document: ${id}`);
			}
			if (item !== undefined) {
				existingDocuments.set(id, {
					record: parse<DocumentRecord>(text(item, "v")!),
					latestVersion: number(item, "ver"),
					latestSeq: number(item, "last"),
				});
			}
		}
		const liveCounts = new Map<string, number>();
		for (const [id, action] of actions) {
			const existing = existingDocuments.get(id);
			if (existing?.record.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
			if (action.content?.kind === "delta") {
				if (existing?.latestVersion === undefined) throw new Error(`Document ${id} delta has no base`);
				if (existing.latestVersion !== action.content.version) {
					throw new Error(`Document ${id} version transition requires a base`);
				}
			}
			const address = action.create !== undefined ? action.create : existing!.record;
			const key = recordAddressKey(address);
			let live = liveCounts.get(key);
			const currentId =
				live === undefined || action.retire
					? (await this.findDocument({ kind: address.kind, scope: address.scope, key: address.key }, "current", BACKGROUND_CONTEXT))
							?.id
					: undefined;
			if (live === undefined) live = currentId === undefined ? 0 : 1;
			if (action.retire && currentId === id) live--;
			if (action.create !== undefined && !action.retire) live++;
			liveCounts.set(key, live);
		}
		for (const live of liveCounts.values()) {
			if (live > 1) throw new Error("Document address already has a current incarnation");
		}
		return existingDocuments;
	}

	async mintId<I extends Id<string>>(): Promise<I> {
		this.assertOpen();
		if (!Number.isSafeInteger(this.nextId)) throw new Error("ID space is exhausted");
		return this.nextId++ as I;
	}

	async conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
		this.assertOpen();
		return this.readRecord<ConversationRecord>(id, "conversation");
	}

	async scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		this.assertOpen();
		const after = cursorAfter(cursor);
		const [index, prefix] =
			query.ownerTaskId !== undefined
				? (["l2", `CT#${pad(query.ownerTaskId)}#`] as const)
				: query.ownerConversationId !== undefined
					? (["l3", `CC#${pad(query.ownerConversationId)}#`] as const)
					: (["l1", "C#"] as const);
		return this.scanAscending<ConversationRecord>(index, prefix, after, limit, (value) =>
			query.ownerConversationId === undefined || value.owner?.conversationId === query.ownerConversationId,
		);
	}

	entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	entry(
		conversationId: ConversationId,
		id: EntryId,
		context: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	async entry(
		idOrConversationId: EntryId | ConversationId,
		idOrContext: EntryId | Context,
		context?: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
		this.assertOpen();
		if (context === undefined) return this.readEntry(idOrConversationId as EntryId);
		if (typeof idOrContext !== "number") throw new TypeError("Storage.entry() requires an entry ID");
		let current = await this.requireConversation(idOrConversationId as ConversationId);
		const found = await this.readEntry(idOrContext as EntryId);
		if (found === undefined) return undefined;
		let upper = Number.POSITIVE_INFINITY;
		while (true) {
			if (found.entry.conversationId === current.id) return found.entry.id <= upper ? found : undefined;
			if (current.parent === undefined) return undefined;
			upper = Math.min(upper, current.parent.at);
			current = await this.requireConversation(current.parent.conversationId);
		}
	}

	async findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		_context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		this.assertOpen();
		let current = await this.requireConversation(conversationId);
		let upper = atOrBeforeEntryId ?? Number.POSITIVE_INFINITY;
		while (true) {
			const high = Number.isFinite(upper) ? `H#${pad(current.id)}#${pad(upper)}` : `H#${pad(current.id)}#~`;
			for await (const item of this.iterate("l2", `H#${pad(current.id)}#`, high, false, 1)) {
				const entry = parse<EntryRecord>(text(item, "v")!);
				return { ...entry, head: entry.head! };
			}
			if (current.parent === undefined) return undefined;
			upper = Math.min(upper, current.parent.at);
			current = await this.requireConversation(current.parent.conversationId);
		}
	}

	async scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		this.assertOpen();
		const after = cursorAfter(cursor);
		const maxEntryId =
			after === undefined ? query.maxEntryId : Math.min(query.maxEntryId ?? Number.POSITIVE_INFINITY, after - 1);
		const visible: EntryRecord[] = [];
		for await (const entry of this.visibleEntries(query.conversationId, query.minEntryId, maxEntryId)) {
			visible.push(entry);
			if (visible.length > limit) break;
		}
		return page(visible, limit);
	}

	async task(id: TaskId, _context: Context): Promise<StoredTask | undefined> {
		this.assertOpen();
		return this.readRecord<StoredTask>(id, "task");
	}

	async scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<StoredTask, Cursor>> {
		this.assertOpen();
		const after = cursorAfter(cursor);
		const [index, prefix] =
			query.status === undefined ? (["l1", "T#"] as const) : (["l2", `TS#${query.status}#`] as const);
		return this.scanAscending<StoredTask>(
			index,
			prefix,
			after,
			limit,
			(value) =>
				(query.conversationId === undefined || value.conversationId === query.conversationId) &&
				(query.kind === undefined || value.kind === query.kind) &&
				(query.abortRequested === undefined || value.abortRequested === query.abortRequested) &&
				(query.background === undefined || value.background === query.background),
		);
	}

	async submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
		this.assertOpen();
		return this.readRecord<SubmissionRecord>(id, "submission");
	}

	async scanSubmissions(
		query: SubmissionQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<SubmissionRecord, Cursor>> {
		this.assertOpen();
		const after = cursorAfter(cursor);
		const [index, prefix] =
			query.status === undefined ? (["l1", "S#"] as const) : (["l2", `SS#${query.status}#`] as const);
		return this.scanAscending<SubmissionRecord>(
			index,
			prefix,
			after,
			limit,
			(value) => query.conversationId === undefined || value.conversationId === query.conversationId,
		);
	}

	async submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		_context: Context,
	): Promise<SubmissionRecord | undefined> {
		this.assertOpen();
		const prefix = `SR#${pad(conversationId)}#${digest(encode(requestId))}#`;
		for await (const item of this.iterate("l3", prefix, `${prefix}~`, false)) {
			const value = parse<SubmissionRecord>(text(item, "v")!);
			if (value.requestId === requestId && value.conversationId === conversationId) return value;
		}
		return undefined;
	}

	async findDocument(
		address: DocumentAddress,
		at: DocumentPoint,
		_context: Context,
	): Promise<DocumentRecord | undefined> {
		this.assertOpen();
		const key = addressKey(address);
		const prefix = `DA#${digest(key)}#`;
		for await (const item of this.iterate("l2", prefix, `${prefix}~`, true)) {
			const record = parse<DocumentRecord>(text(item, "v")!);
			if (recordAddressKey(record) !== key) continue;
			if (isAliveAt(record, at)) return record;
		}
		return undefined;
	}

	async document(id: DocumentId, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined> {
		this.assertOpen();
		return this.materialize(id, at);
	}

	async scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<DocumentRecord, Cursor>> {
		this.assertOpen();
		const after = cursorAfter(cursor);
		const scope = scopeKey(query.scope);
		return this.scanAscending<DocumentRecord>(
			"l1",
			`D#${digest(scope)}#`,
			after,
			limit,
			(record) =>
				scopeKey(record.scope) === scope &&
				(query.kind === undefined || record.kind === query.kind) &&
				isAliveAt(record, query.at),
		);
	}

	async close(_context: Context): Promise<void> {
		this.closed = true;
	}

	/**
	 * Materialize one document at a point. The revision range is pinned to the latest revision seq read from the
	 * record in the same attempt. A current read of a current-only document that races its owner's post-commit
	 * cleanup can still find its base deleted; that case re-reads from the record, a bounded number of times.
	 */
	private async materialize(id: number, at: DocumentPoint): Promise<StoredDocument | undefined> {
		for (let attempt = 1; ; attempt++) {
			const item = await this.getItem(`R#${pad(id)}`);
			if (item === undefined || text(item, "t") !== "document") return undefined;
			const record = parse<DocumentRecord>(text(item, "v")!);
			if (at !== "current" && isCurrentOnly(record)) {
				throw new Error(`Document ${id} does not retain historical content`);
			}
			if (!isAliveAt(record, at)) return undefined;
			const pinned = at === "current" ? number(item, "last") : at;
			const high = pinned === undefined ? `V#${pad(id)}#~` : `V#${pad(id)}#${pad(pinned)}`;
			const newestFirst: DocumentRevision[] = [];
			for await (const revisionItem of this.iterate(undefined, `V#${pad(id)}#`, high, false)) {
				const content = parse<DocumentContent>(text(revisionItem, "c")!);
				const seq = Number(text(revisionItem, "sk")!.slice(-16)) as Seq;
				newestFirst.push({ ...content, seq } as DocumentRevision);
				if (content.kind === "base") break;
			}
			const base = newestFirst.at(-1);
			if (base?.kind !== "base") {
				if (at === "current" && attempt < MATERIALIZE_ATTEMPTS) continue;
				throw new Error(`Document ${id} is missing a required base`);
			}
			const deltas = newestFirst.slice(0, -1).reverse();
			const batches = function* (): Generator<readonly Op[]> {
				for (const revision of deltas) {
					if (revision.kind !== "delta" || revision.version !== base.version) {
						throw new Error(`Document ${id} crosses a stored version boundary without a base`);
					}
					yield revision.ops;
				}
			};
			const value = applyImmutableBatches(base.value, batches()) as JsonObject;
			return {
				record,
				version: base.version,
				value: parse<JsonObject>(encode(value)),
				deltasSinceBase: deltas.length,
			};
		}
	}

	private async *visibleEntries(
		conversationId: ConversationId,
		minEntryId: number = Number.NEGATIVE_INFINITY,
		maxEntryId: number = Number.POSITIVE_INFINITY,
	): AsyncGenerator<EntryRecord> {
		let current = await this.requireConversation(conversationId);
		let upper = maxEntryId;
		while (true) {
			const prefix = `E#${pad(current.id)}#`;
			const low = Number.isFinite(minEntryId) && minEntryId > 0 ? `${prefix}${pad(minEntryId)}` : prefix;
			const high = Number.isFinite(upper) ? `${prefix}${pad(upper)}` : `${prefix}~`;
			if (!(Number.isFinite(upper) && upper < 0)) {
				for await (const item of this.iterate("l1", low, high, false)) {
					yield parse<EntryRecord>(text(item, "v")!);
				}
			}
			if (current.parent === undefined) break;
			upper = Math.min(upper, current.parent.at);
			if (upper < minEntryId) break;
			current = await this.requireConversation(current.parent.conversationId);
		}
	}

	private async scanAscending<T extends { readonly id: number }>(
		index: "l1" | "l2" | "l3",
		prefix: string,
		after: number | undefined,
		limit: number,
		accept: (value: T) => boolean,
	): Promise<Page<T, Cursor>> {
		const low = after === undefined ? prefix : `${prefix}${pad(after + 1)}`;
		const values: T[] = [];
		for await (const item of this.iterate(index, low, `${prefix}~`, true)) {
			const value = parse<T>(text(item, "v")!);
			if (!accept(value)) continue;
			values.push(value);
			if (values.length > limit) break;
		}
		return page(values, limit);
	}

	private async *iterate(
		index: "l1" | "l2" | "l3" | undefined,
		low: string,
		high: string,
		forward: boolean,
		pageSize = QUERY_PAGE_SIZE,
	): AsyncGenerator<Item> {
		const keyName = index ?? "sk";
		let startKey: Item | undefined;
		do {
			this.preReads++;
			const response = await this.client.send(
				new QueryCommand({
					TableName: this.tableName,
					IndexName: `${index}-index`,
					ConsistentRead: true,
					KeyConditionExpression: "pk = :pk AND #k BETWEEN :low AND :high",
					ExpressionAttributeNames: { "#k": keyName },
					ExpressionAttributeValues: { ":pk": { S: this.pk }, ":low": { S: low }, ":high": { S: high } },
					ScanIndexForward: forward,
					Limit: pageSize,
					ExclusiveStartKey: startKey,
				}),
			);
			this.meter.read(response.Items ?? [], false);
			for (const item of response.Items ?? []) yield item;
			startKey = response.LastEvaluatedKey;
		} while (startKey !== undefined);
	}

	private async getItem(sk: string): Promise<Item | undefined> {
		this.preReads++;
		const response = await this.client.send(
			new GetItemCommand({ TableName: this.tableName, Key: { pk: { S: this.pk }, sk: { S: sk } }, ConsistentRead: true }),
		);
		this.meter.read(response.Item === undefined ? [] : [response.Item], true);
		return response.Item;
	}

	private async batchGet(sortKeys: readonly string[]): Promise<Map<string, Item>> {
		const found = new Map<string, Item>();
		for (let index = 0; index < sortKeys.length; index += 100) {
			let keys: Item[] | undefined = sortKeys
				.slice(index, index + 100)
				.map((sk) => ({ pk: { S: this.pk }, sk: { S: sk } }));
			while (keys !== undefined && keys.length > 0) {
				this.preReads++;
				const response = await this.client.send(
					new BatchGetItemCommand({ RequestItems: { [this.tableName]: { Keys: keys, ConsistentRead: true } } }),
				);
				this.meter.read(response.Responses?.[this.tableName] ?? [], true);
				for (const item of response.Responses?.[this.tableName] ?? []) found.set(text(item, "sk")!, item);
				keys = response.UnprocessedKeys?.[this.tableName]?.Keys as Item[] | undefined;
			}
		}
		return found;
	}

	private async readRecord<T>(id: number, table: TableName): Promise<T | undefined> {
		const item = await this.getItem(`R#${pad(id)}`);
		if (item === undefined || text(item, "t") !== table) return undefined;
		return parse<T>(text(item, "v")!);
	}

	private async readEntry(id: EntryId): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
		const item = await this.getItem(`R#${pad(id)}`);
		if (item === undefined || text(item, "t") !== "entry") return undefined;
		return { entry: parse<EntryRecord>(text(item, "v")!), commitSeq: number(item, "s")! as Seq };
	}

	private async requireConversation(id: ConversationId): Promise<ConversationRecord> {
		const conversation = await this.readRecord<ConversationRecord>(id, "conversation");
		if (conversation === undefined) throw new Error(`Unknown conversation: ${id}`);
		return conversation;
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("DynamoDbStorage is closed");
	}
}

type PlannedItem = {
	readonly role: "record" | "revision" | "meta" | "owner";
	readonly id: number | undefined;
	readonly request: TransactWriteItem;
	readonly bytes: number;
	readonly meterItem: Item;
};

type RevisionCleanup = { readonly id: number; readonly belowSeq: number };
