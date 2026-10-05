import { randomUUID } from "node:crypto";
import {
	BatchGetItemCommand,
	type DynamoDBClient,
	GetItemCommand,
	PutItemCommand,
	QueryCommand,
	type TransactWriteItem,
	TransactWriteItemsCommand,
	UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
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
import {
	addressKey,
	backoff,
	CommitOutcomeUnknown,
	type CommitState,
	cursorAfter,
	digest,
	encode,
	isAliveAt,
	isCurrentOnly,
	type Item,
	number,
	OwnershipLost,
	pad,
	page,
	parse,
	RETRYABLE_ERRORS,
	recordAddressKey,
	scopeKey,
	TRANSACTION_ATTEMPTS,
	TRANSACTION_ITEM_LIMIT,
	TRANSIENT_CANCELLATIONS,
	text,
} from "./storage-support.ts";

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type TableName = "conversation" | "entry" | "task" | "submission" | "document";
type DocumentAction = { create?: DocumentCreate; content?: DocumentContent; retire: boolean; position?: number };
type StoredDocumentItem = { record: DocumentRecord; latestVersion: number | undefined; latestSeq: number | undefined };
type RecordWrite = Extract<StorageWrite, { type: TableName }>;

/** The immutable S3 object of one commit: every write of that commit, in order. */
export type CommitObject = {
	readonly seq: number;
	readonly fence: number;
	readonly token: string;
	readonly writes: readonly StorageWrite[];
};

const REVISION_PAGE_SIZE = 32;

export type IndexedStorageOptions = {
	readonly client: DynamoDBClient;
	readonly s3: S3Client;
	readonly tableName: string;
	readonly bucket: string;
	/** Partition identity, for example `tenant#bot#channel`. */
	readonly storageId: string;
	/** When set, every commit carries a condition that the partition's owner fence still equals this value. */
	readonly fence?: number;
};

/**
 * Commit object key by convention: `conversations/<storage>/commits/<seq:012>-<fence:08>.json`.
 *
 * The fence in the key makes every key writable by exactly one owner, so an owner can always replace its own
 * orphan and two owners racing for one sequence never collide on a key.
 *
 * @param storageId Storage identity.
 * @param seq Commit sequence.
 * @param fence Fence of the committing owner, 0 when unfenced.
 * @returns The S3 key.
 */
export const commitKey = (storageId: string, seq: number, fence: number): string =>
	`conversations/${encodeURIComponent(storageId)}/commits/${String(seq).padStart(12, "0")}-${String(fence).padStart(8, "0")}.json`;

/**
 * pi-durable `Storage` with the data in S3 and only an index in DynamoDB.
 *
 * Every `commit()` writes one immutable S3 object holding all its writes, then one small `TransactWriteItems` that
 * makes it visible: index items pointing at `(seq, fence, position)`, plus `META` (sequence, ID high-water mark,
 * idempotency token) and the owner-fence check. Readers only follow the index, so an object without a committed
 * transaction is never read.
 */
export class IndexedStorage implements Storage {
	private readonly client: DynamoDBClient;
	private readonly s3: S3Client;
	private readonly tableName: string;
	private readonly bucket: string;
	private readonly storageId: string;
	private readonly pk: string;
	private readonly fence: number | undefined;
	private readonly commits = new Map<string, Promise<CommitObject>>();
	private seq = 0;
	private nextId = 2;
	private closed = false;

	private constructor(options: IndexedStorageOptions) {
		this.client = options.client;
		this.s3 = options.s3;
		this.tableName = options.tableName;
		this.bucket = options.bucket;
		this.storageId = options.storageId;
		this.pk = `PI#${options.storageId}`;
		this.fence = options.fence;
	}

	/**
	 * Open (and on first use create) one storage and load its commit sequence and ID high-water mark.
	 *
	 * @param options Storage options.
	 * @returns The open storage.
	 */
	static async open(options: IndexedStorageOptions): Promise<IndexedStorage> {
		const storage = new IndexedStorage(options);
		await storage.load();
		return storage;
	}

	/**
	 * Raise the partition's owner fence. An owner may claim its own fence again; a strictly newer fence held by
	 * another owner throws `OwnershipLost`.
	 *
	 * @param options Client, table, partition, and the new fence.
	 */
	static async claimOwnership(options: {
		readonly client: DynamoDBClient;
		readonly tableName: string;
		readonly storageId: string;
		readonly fence: number;
	}): Promise<void> {
		try {
			await options.client.send(
				new UpdateItemCommand({
					TableName: options.tableName,
					Key: { pk: { S: `PI#${options.storageId}` }, sk: { S: "OWNER" } },
					UpdateExpression: "SET fence = :fence",
					ConditionExpression: "attribute_not_exists(fence) OR fence <= :fence",
					ExpressionAttributeValues: { ":fence": { N: String(options.fence) } },
				}),
			);
		} catch (error) {
			if ((error as Error).name === "ConditionalCheckFailedException") {
				throw new OwnershipLost("Owner fence moved: a newer owner holds this storage", { cause: error });
			}
			throw error;
		}
	}

	/**
	 * Allocate the next owner fence for a partition: one `UpdateItem` on its OWNER item that adds one to the current
	 * fence (starting from 0). It is called after the turn has been claimed, so a duplicate delivery cannot raise the
	 * fence under a live owner, and it fences out any earlier owner.
	 *
	 * @param client DynamoDB client.
	 * @param tableName Pi session table.
	 * @param storageId Partition identity, `tenant#bot#channel`.
	 * @returns The newly allocated fence.
	 */
	static async allocateFence(client: DynamoDBClient, tableName: string, storageId: string): Promise<number> {
		const result = await client.send(
			new UpdateItemCommand({
				TableName: tableName,
				Key: { pk: { S: `PI#${storageId}` }, sk: { S: "OWNER" } },
				UpdateExpression: "SET fence = if_not_exists(fence, :zero) + :one",
				ExpressionAttributeValues: { ":zero": { N: "0" }, ":one": { N: "1" } },
				ReturnValues: "UPDATED_NEW",
			}),
		);
		const allocated = result.Attributes?.fence?.N;
		if (allocated === undefined) throw new Error(`Fence allocation returned no fence for ${storageId}`);
		return Number(allocated);
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
		const seq = this.seq + 1;
		const fence = this.fence ?? 0;
		let objectWritten = false;
		const key = commitKey(this.storageId, seq, fence);
		try {
			const detached = parse<StorageWrite[]>(encode(writes));
			const resolved = await this.resolveDocumentCopies(detached);
			this.checkBatchIds(resolved);
			const actions = this.prepareDocumentActions(resolved);
			const existingDocuments = await this.checkDocumentActions(actions);
			const token = randomUUID();
			const plan = this.planTransaction(resolved, actions, existingDocuments, seq, fence, token);
			if (plan.items.length > TRANSACTION_ITEM_LIMIT) {
				throw new StorageRejected(
					`Commit needs ${plan.items.length} transaction items; DynamoDB allows ${TRANSACTION_ITEM_LIMIT}`,
				);
			}
			const object: CommitObject = { seq, fence, token, writes: resolved };
			const body = encode(object);
			await this.putCommitObject(key, seq, body, token);
			objectWritten = true;
			await this.transact(plan.items, token);
			this.commits.set(key, Promise.resolve(parse<CommitObject>(body)));
			this.seq = seq;
			this.nextId = Math.max(this.nextId, plan.highestId + 1);
			return seq as Seq;
		} catch (error) {
			const outcomeUnknown = error instanceof CommitOutcomeUnknown;
			if (objectWritten && !outcomeUnknown && (error instanceof StorageRejected || error instanceof OwnershipLost)) {
				await this.deleteOrphan(key);
			}
			throw error;
		}
	}

	/**
	 * Write the commit object without ever overwriting a key. A key is only ever written by this owner (its fence is
	 * in the key), so an existing object is either this commit's own earlier attempt (same token: keep it) or this
	 * owner's orphan from a commit whose transaction failed (replace it, but only after reading META and finding that
	 * the sequence is not committed: an object at or below META.seq is committed data and is never deleted). A 409
	 * ConditionalRequestConflict means a concurrent write to the same key is still in flight, which with the fence in
	 * the key can only be this owner's own earlier attempt; it is transient, so it is retried with backoff and the
	 * next attempt resolves to a 412 with the same token or a successful write.
	 */
	private async putCommitObject(key: string, seq: number, body: string, token: string): Promise<void> {
		for (let attempt = 1; ; attempt++) {
			try {
				await this.s3.send(
					new PutObjectCommand({
						Bucket: this.bucket,
						Key: key,
						Body: body,
						ContentType: "application/json",
						IfNoneMatch: "*",
					}),
				);
				return;
			} catch (error) {
				const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
				if (status === 412 && attempt < 3) {
					const existing = await this.fetchCommit(key, false);
					if (existing.token === token) return;
					const meta = await this.getItem("META");
					const committedSeq = meta === undefined ? 0 : number(meta, "seq")!;
					if (committedSeq >= seq) {
						throw new OwnershipLost(`Object ${key} belongs to an already committed sequence; refusing to replace it`, {
							cause: error,
						});
					}
					await this.deleteOrphan(key);
					continue;
				}
				if (status === 409 && attempt < TRANSACTION_ATTEMPTS) {
					await backoff(attempt);
					continue;
				}
				if (RETRYABLE_ERRORS.has((error as Error).name) && attempt < TRANSACTION_ATTEMPTS) {
					await backoff(attempt);
					continue;
				}
				throw error;
			}
		}
	}

	private async deleteOrphan(key: string): Promise<void> {
		try {
			await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
		} catch (error) {
			process.stderr.write(`[indexed-storage] orphan ${key} left for the sweeper: ${(error as Error).message}\n`);
		}
	}

	/**
	 * Send the index transaction, retrying transient failures with the same `ClientRequestToken`, which is also
	 * written to `META` so a lost response can be resolved by reading `META` and comparing tokens.
	 */
	private async transact(entries: readonly PlannedItem[], token: string): Promise<number> {
		for (let attempt = 1; ; attempt++) {
			try {
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
					throw new OwnershipLost(`Transaction kept conflicting after ${attempt} attempts`, { cause: error });
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
		fence: number,
		token: string,
	): { items: PlannedItem[]; highestId: number } {
		const items: PlannedItem[] = [];
		let highestId = 0;
		const lastRecordWrite = new Map<number, { write: RecordWrite; position: number }>();
		writes.forEach((write, position) => {
			if (write.type === "conversation" || write.type === "entry" || write.type === "task" || write.type === "submission") {
				lastRecordWrite.set(write.value.id, { write, position });
			}
		});
		const pointer = (position: number): Item => ({
			c: { N: String(seq) },
			f: { N: String(fence) },
			p: { N: String(position) },
		});
		for (const { write, position } of lastRecordWrite.values()) {
			highestId = Math.max(highestId, write.value.id);
			const once = write.type === "conversation" || write.type === "entry";
			items.push(
				this.planned("record", write.value.id, {
					Put: {
						TableName: this.tableName,
						Item: { ...this.recordItem(write), ...pointer(position) },
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
				action.create !== undefined ? ({ ...action.create, createdAt: seq } as DocumentRecord) : existing!.record;
			const record: DocumentRecord = action.retire ? { ...baseRecord, retiredAt: seq as Seq } : baseRecord;
			const currentOnly = isCurrentOnly(record);
			const writesRevision = action.content !== undefined && !(action.retire && currentOnly);
			const item: Item = {
				pk: { S: this.pk },
				sk: { S: `R#${pad(id)}` },
				t: { S: "document" },
				v: { S: encode(record) },
				l1: { S: `D#${digest(scopeKey(record.scope))}#${pad(id)}` },
				l2: { S: `DA#${digest(recordAddressKey(record))}#${pad(id)}` },
			};
			const latestVersion = writesRevision ? action.content!.version : existing?.latestVersion;
			if (latestVersion !== undefined) item.ver = { N: String(latestVersion) };
			const latestSeq = writesRevision ? seq : existing?.latestSeq;
			if (latestSeq !== undefined) item.last = { N: String(latestSeq) };
			items.push(
				this.planned("record", id, {
					Put: {
						TableName: this.tableName,
						Item: item,
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
								b: { N: action.content!.kind === "base" ? "1" : "0" },
								...pointer(action.position!),
							},
						},
					}),
				);
			}
		}
		items.push(
			this.planned("meta", undefined, {
				Update: {
					TableName: this.tableName,
					Key: { pk: { S: this.pk }, sk: { S: "META" } },
					UpdateExpression: "SET seq = :seq, nextId = :nextId, #token = :token",
					ExpressionAttributeNames: { "#token": "token" },
					ConditionExpression: "seq = :expected",
					ExpressionAttributeValues: {
						":expected": { N: String(this.seq) },
						":seq": { N: String(seq) },
						":nextId": { N: String(Math.max(this.nextId, highestId + 1)) },
						":token": { S: token },
					},
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
		return { items, highestId };
	}

	private planned(role: PlannedItem["role"], id: number | undefined, request: TransactWriteItem): PlannedItem {
		return { role, id, request };
	}

	private recordItem(write: RecordWrite): Item {
		const id = write.value.id;
		const item: Item = { pk: { S: this.pk }, sk: { S: `R#${pad(id)}` }, t: { S: write.type } };
		switch (write.type) {
			case "conversation": {
				item.v = { S: encode(write.value) };
				item.l1 = { S: `C#${pad(id)}` };
				const owner = write.value.owner;
				if (owner !== undefined) {
					item.l2 = { S: `CT#${pad(owner.taskId)}#${pad(id)}` };
					item.l3 = { S: `CC#${pad(owner.conversationId)}#${pad(id)}` };
				}
				break;
			}
			case "entry":
				item.cv = { N: String(write.value.conversationId) };
				item.l1 = { S: `E#${pad(write.value.conversationId)}#${pad(id)}` };
				if (write.value.head !== undefined) item.l2 = { S: `H#${pad(write.value.conversationId)}#${pad(id)}` };
				break;
			case "task":
				item.cv = { N: String(write.value.conversationId) };
				item.k = { S: encode(write.value.kind) };
				item.ab = { N: write.value.abortRequested ? "1" : "0" };
				item.bg = { N: write.value.background ? "1" : "0" };
				item.l1 = { S: `T#${pad(id)}` };
				item.l2 = { S: `TS#${write.value.state.status}#${pad(id)}` };
				break;
			case "submission":
				item.cv = { N: String(write.value.conversationId) };
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
		writes.forEach((write, position) => {
			if (write.type !== "document.create" && write.type !== "document.change" && write.type !== "document.retire") {
				return;
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
					action.position = position;
					break;
				case "document.change":
					if (action.content !== undefined) throw new Error(`Document ${id} has more than one content command`);
					action.content = write.content;
					action.position = position;
					break;
				case "document.retire":
					if (action.retire) throw new Error(`Document ${id} is retired more than once`);
					action.retire = true;
					break;
			}
		});
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
					? (
							await this.findDocument(
								{ kind: address.kind, scope: address.scope, key: address.key },
								"current",
								BACKGROUND_CONTEXT,
							)
						)?.id
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
		const item = await this.getItem(`R#${pad(id)}`);
		return item === undefined || text(item, "t") !== "conversation" ? undefined : parse(text(item, "v")!);
	}

	async scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		this.assertOpen();
		const [index, prefix] =
			query.ownerTaskId !== undefined
				? (["l2", `CT#${pad(query.ownerTaskId)}#`] as const)
				: query.ownerConversationId !== undefined
					? (["l3", `CC#${pad(query.ownerConversationId)}#`] as const)
					: (["l1", "C#"] as const);
		const items = await this.scanIndex(index, prefix, cursorAfter(cursor), limit, (item) => {
			const value = parse<ConversationRecord>(text(item, "v")!);
			return query.ownerConversationId === undefined || value.owner?.conversationId === query.ownerConversationId;
		});
		return page(
			items.map((item) => parse<ConversationRecord>(text(item, "v")!)),
			limit,
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
		const item = await this.getItem(`R#${pad(idOrContext)}`);
		if (item === undefined || text(item, "t") !== "entry") return undefined;
		const entryConversation = number(item, "cv")!;
		let upper = Number.POSITIVE_INFINITY;
		while (true) {
			if (entryConversation === current.id) {
				if (idOrContext > upper) return undefined;
				return { entry: await this.resolve<EntryRecord>(item), commitSeq: number(item, "c")! as Seq };
			}
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
			for await (const items of this.pages("l2", `H#${pad(current.id)}#`, high, false, 1)) {
				if (items.length === 0) continue;
				const entry = await this.resolve<EntryRecord>(items[0]!);
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
		const minEntryId = query.minEntryId ?? Number.NEGATIVE_INFINITY;
		const visible: Item[] = [];
		let current = await this.requireConversation(query.conversationId);
		let upper = maxEntryId ?? Number.POSITIVE_INFINITY;
		outer: while (true) {
			const prefix = `E#${pad(current.id)}#`;
			const low = Number.isFinite(minEntryId) && minEntryId > 0 ? `${prefix}${pad(minEntryId)}` : prefix;
			const high = Number.isFinite(upper) ? `${prefix}${pad(upper)}` : `${prefix}~`;
			if (!(Number.isFinite(upper) && upper < 0)) {
				for await (const items of this.pages("l1", low, high, false, Math.min(limit + 1, 100))) {
					for (const item of items) {
						visible.push(item);
						if (visible.length > limit) break outer;
					}
				}
			}
			if (current.parent === undefined) break;
			upper = Math.min(upper, current.parent.at);
			if (upper < minEntryId) break;
			current = await this.requireConversation(current.parent.conversationId);
		}
		return page(await Promise.all(visible.map((item) => this.resolve<EntryRecord>(item))), limit);
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
		const [index, prefix] =
			query.status === undefined ? (["l1", "T#"] as const) : (["l2", `TS#${query.status}#`] as const);
		const kind = query.kind === undefined ? undefined : encode(query.kind);
		const items = await this.scanIndex(
			index,
			prefix,
			cursorAfter(cursor),
			limit,
			(item) =>
				(query.conversationId === undefined || number(item, "cv") === query.conversationId) &&
				(kind === undefined || text(item, "k") === kind) &&
				(query.abortRequested === undefined || (number(item, "ab") === 1) === query.abortRequested) &&
				(query.background === undefined || (number(item, "bg") === 1) === query.background),
		);
		return page(await Promise.all(items.map((item) => this.resolve<StoredTask>(item))), limit);
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
		const [index, prefix] =
			query.status === undefined ? (["l1", "S#"] as const) : (["l2", `SS#${query.status}#`] as const);
		const items = await this.scanIndex(
			index,
			prefix,
			cursorAfter(cursor),
			limit,
			(item) => query.conversationId === undefined || number(item, "cv") === query.conversationId,
		);
		return page(await Promise.all(items.map((item) => this.resolve<SubmissionRecord>(item))), limit);
	}

	async submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		_context: Context,
	): Promise<SubmissionRecord | undefined> {
		this.assertOpen();
		const prefix = `SR#${pad(conversationId)}#${digest(encode(requestId))}#`;
		for await (const items of this.pages("l3", prefix, `${prefix}~`, false)) {
			for (const item of items) {
				const value = await this.resolve<SubmissionRecord>(item);
				if (value.requestId === requestId && value.conversationId === conversationId) return value;
			}
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
		for await (const items of this.pages("l2", prefix, `${prefix}~`, true)) {
			for (const item of items) {
				const record = parse<DocumentRecord>(text(item, "v")!);
				if (recordAddressKey(record) !== key) continue;
				if (isAliveAt(record, at)) return record;
			}
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
		const scope = scopeKey(query.scope);
		const items = await this.scanIndex("l1", `D#${digest(scope)}#`, cursorAfter(cursor), limit, (item) => {
			const record = parse<DocumentRecord>(text(item, "v")!);
			return (
				scopeKey(record.scope) === scope &&
				(query.kind === undefined || record.kind === query.kind) &&
				isAliveAt(record, query.at)
			);
		});
		return page(
			items.map((item) => parse<DocumentRecord>(text(item, "v")!)),
			limit,
		);
	}

	async close(_context: Context): Promise<void> {
		this.closed = true;
	}

	/**
	 * Materialize one document at a point: the revision index from the pinned seq (the record's latest revision for a
	 * current read) down to the newest base, then the referenced commit objects fetched in parallel. Nothing is ever
	 * deleted, so this is a consistent point-in-time read.
	 */
	private async materialize(id: number, at: DocumentPoint): Promise<StoredDocument | undefined> {
		const item = await this.getItem(`R#${pad(id)}`);
		if (item === undefined || text(item, "t") !== "document") return undefined;
		const record = parse<DocumentRecord>(text(item, "v")!);
		if (at !== "current" && isCurrentOnly(record)) {
			throw new Error(`Document ${id} does not retain historical content`);
		}
		if (!isAliveAt(record, at)) return undefined;
		const pinned = at === "current" ? number(item, "last") : at;
		const high = pinned === undefined ? `V#${pad(id)}#~` : `V#${pad(id)}#${pad(pinned)}`;
		const newestFirst: Item[] = [];
		outer: for await (const items of this.pages(undefined, `V#${pad(id)}#`, high, false, REVISION_PAGE_SIZE)) {
			for (const revision of items) {
				newestFirst.push(revision);
				if (number(revision, "b") === 1) break outer;
			}
		}
		if (newestFirst.length === 0 || number(newestFirst.at(-1)!, "b") !== 1) {
			throw new Error(`Document ${id} is missing a required base`);
		}
		const contents = await Promise.all(
			newestFirst.reverse().map(async (revision) => {
				const object = await this.fetchCommit(this.keyOf(revision), true);
				const write = object.writes[number(revision, "p")!]!;
				return (write as { content: DocumentContent }).content;
			}),
		);
		const base = contents[0]!;
		if (base.kind !== "base") throw new Error(`Document ${id} is missing a required base`);
		const deltas = contents.slice(1);
		const batches = function* (): Generator<readonly Op[]> {
			for (const revision of deltas) {
				if (revision.kind !== "delta" || revision.version !== base.version) {
					throw new Error(`Document ${id} crosses a stored version boundary without a base`);
				}
				yield revision.ops;
			}
		};
		const value = applyImmutableBatches(base.value, batches()) as JsonObject;
		return { record, version: base.version, value: parse<JsonObject>(encode(value)), deltasSinceBase: deltas.length };
	}

	private keyOf(item: Item): string {
		return commitKey(this.storageId, number(item, "c")!, number(item, "f")!);
	}

	private async resolve<T>(item: Item): Promise<T> {
		const object = await this.fetchCommit(this.keyOf(item), true);
		const write = object.writes[number(item, "p")!] as unknown as { value: T };
		return parse<T>(encode(write.value));
	}

	/**
	 * Fetch one immutable commit object, cached for the life of this owner. Objects never change, so the cache
	 * needs no invalidation.
	 */
	private fetchCommit(key: string, cache: boolean): Promise<CommitObject> {
		const cached = this.commits.get(key);
		if (cached !== undefined) return cached;
		const loading = (async () => {
			const response = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
			return parse<CommitObject>(await response.Body!.transformToString());
		})();
		if (cache) {
			this.commits.set(key, loading);
			loading.catch(() => this.commits.delete(key));
		}
		return loading;
	}

	private async readRecord<T>(id: number, table: TableName): Promise<T | undefined> {
		const item = await this.getItem(`R#${pad(id)}`);
		if (item === undefined || text(item, "t") !== table) return undefined;
		return this.resolve<T>(item);
	}

	private async readEntry(id: EntryId): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
		const item = await this.getItem(`R#${pad(id)}`);
		if (item === undefined || text(item, "t") !== "entry") return undefined;
		return { entry: await this.resolve<EntryRecord>(item), commitSeq: number(item, "c")! as Seq };
	}

	private async requireConversation(id: ConversationId): Promise<ConversationRecord> {
		const item = await this.getItem(`R#${pad(id)}`);
		if (item === undefined || text(item, "t") !== "conversation") throw new Error(`Unknown conversation: ${id}`);
		return parse<ConversationRecord>(text(item, "v")!);
	}

	private async scanIndex(
		index: "l1" | "l2" | "l3",
		prefix: string,
		after: number | undefined,
		limit: number,
		accept: (item: Item) => boolean,
	): Promise<Item[]> {
		const low = after === undefined ? prefix : `${prefix}${pad(after + 1)}`;
		const accepted: Item[] = [];
		for await (const items of this.pages(index, low, `${prefix}~`, true)) {
			for (const item of items) {
				if (!accept(item)) continue;
				accepted.push(item);
				if (accepted.length > limit) return accepted;
			}
		}
		return accepted;
	}

	private async *pages(
		index: "l1" | "l2" | "l3" | undefined,
		low: string,
		high: string,
		forward: boolean,
		pageSize = 100,
	): AsyncGenerator<Item[]> {
		const keyName = index ?? "sk";
		let startKey: Item | undefined;
		do {
			const response = await this.client.send(
				new QueryCommand({
					TableName: this.tableName,
					IndexName: index === undefined ? undefined : `${index}-index`,
					ConsistentRead: true,
					KeyConditionExpression: "pk = :pk AND #k BETWEEN :low AND :high",
					ExpressionAttributeNames: { "#k": keyName },
					ExpressionAttributeValues: { ":pk": { S: this.pk }, ":low": { S: low }, ":high": { S: high } },
					ScanIndexForward: forward,
					Limit: pageSize,
					ExclusiveStartKey: startKey,
				}),
			);
			yield response.Items ?? [];
			startKey = response.LastEvaluatedKey;
		} while (startKey !== undefined);
	}

	private async getItem(sk: string): Promise<Item | undefined> {
		const response = await this.client.send(
			new GetItemCommand({ TableName: this.tableName, Key: { pk: { S: this.pk }, sk: { S: sk } }, ConsistentRead: true }),
		);
		return response.Item;
	}

	private async batchGet(sortKeys: readonly string[]): Promise<Map<string, Item>> {
		const found = new Map<string, Item>();
		for (let index = 0; index < sortKeys.length; index += 100) {
			let keys: Item[] | undefined = sortKeys
				.slice(index, index + 100)
				.map((sk) => ({ pk: { S: this.pk }, sk: { S: sk } }));
			for (let attempt = 1; keys !== undefined && keys.length > 0; attempt++) {
				if (attempt > 1) await backoff(attempt);
				const response = await this.client.send(
					new BatchGetItemCommand({ RequestItems: { [this.tableName]: { Keys: keys, ConsistentRead: true } } }),
				);
				for (const item of response.Responses?.[this.tableName] ?? []) found.set(text(item, "sk")!, item);
				keys = response.UnprocessedKeys?.[this.tableName]?.Keys as Item[] | undefined;
			}
		}
		return found;
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("IndexedStorage is closed");
	}
}

type PlannedItem = {
	readonly role: "record" | "revision" | "meta" | "owner";
	readonly id: number | undefined;
	readonly request: TransactWriteItem;
};
