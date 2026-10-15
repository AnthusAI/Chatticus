import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { calculateCost, createModels, createProvider, type Provider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
	AssistantEntry,
	type CommitPublication,
	type Conversation,
	type ConversationId,
	createRegistry,
	createSession,
	defineDocFamily,
	defineExtension,
	defineTool,
	type Extension,
	GenerationTask,
	Harness,
	hook,
	type Session,
	type Storage,
	type StorageWrite,
	type ToolRegistration,
	UsageDoc,
} from "@earendil-works/pi-durable";
import { beforeAll, describe, expect, it } from "vitest";
import { IndexedStorage } from "../src/storage/indexed-storage.ts";
import { OwnershipLost, storageIdFor } from "../src/storage/storage-support.ts";
import { createPiSessionBucket, createPiSessionTable } from "../src/storage/table-definition.ts";
import { openOwnerStorage } from "../src/pi/session.ts";

/**
 * Library-contract guard for the cost accounting design (Kanbus chatticus-9e7710, docs/COST_ACCOUNTING.md section 3.2).
 * It pins what pi-durable lets a per-model-call cost record do. It is a vitest of the library contract, not of a
 * Chatticus behavior: no production code is imported except the storage and the owner-fence helper the owner uses.
 */

const endpoint = process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5555";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };
const client = new DynamoDBClient({ endpoint, region: "us-east-1", credentials, maxAttempts: 1 });
const s3 = new S3Client({ endpoint, region: "us-east-1", credentials, forcePathStyle: true, maxAttempts: 1 });
const tableName = "pi-durable-cost-contract";
const bucket = "pi-durable-cost-contract";
const context = BACKGROUND_CONTEXT;

beforeAll(async () => {
	await createPiSessionTable(client, tableName);
	await createPiSessionBucket(s3, bucket);
});

const MODEL_ID = "priced-model";
const PRICE_BOOK_PER_MILLION = { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 };
const LONG_CONTEXT_TIER = { inputTokensAbove: 272000, input: 2, output: 6, cacheRead: 0.2, cacheWrite: 2.5 };

type PricedUsage = {
	readonly input: number;
	readonly output: number;
	readonly cacheRead?: number;
	readonly reasoning?: number;
};

type PricedStep = {
	readonly text: string;
	readonly usage: PricedUsage;
	readonly toolCall?: { readonly name: string; readonly args: Record<string, unknown> };
	readonly responseId?: string;
	readonly failure?: string;
};

/** A provider whose answers come from a queue and whose usage carries a cost estimate computed the way pi-ai does. */
class PricedProvider {
	readonly provider: Provider;
	callCount = 0;
	private readonly steps: PricedStep[] = [];
	private readonly model: Model<string>;

	constructor() {
		this.model = {
			id: MODEL_ID,
			name: MODEL_ID,
			api: "priced",
			provider: "openai",
			baseUrl: "http://localhost:0",
			reasoning: false,
			input: ["text"],
			cost: { ...PRICE_BOOK_PER_MILLION, tiers: [LONG_CONTEXT_TIER] },
			contextWindow: 1000000,
			maxTokens: 16384,
		} as Model<string>;
		this.provider = createProvider({
			id: "openai",
			auth: { apiKey: { name: "Priced", resolve: async () => ({ auth: {} }) } },
			models: [this.model],
			api: {
				stream: () => this.stream(),
				streamSimple: () => this.stream(),
			},
		});
	}

	enqueue(step: PricedStep): this {
		this.steps.push(step);
		return this;
	}

	private stream() {
		const outer = createAssistantMessageEventStream();
		this.callCount += 1;
		const step = this.steps.shift();
		const callNumber = this.callCount;
		queueMicrotask(() => {
			const usage = {
				input: step?.usage.input ?? 0,
				output: step?.usage.output ?? 0,
				cacheRead: step?.usage.cacheRead ?? 0,
				cacheWrite: 0,
				...(step?.usage.reasoning === undefined ? {} : { reasoning: step.usage.reasoning }),
				totalTokens: (step?.usage.input ?? 0) + (step?.usage.output ?? 0) + (step?.usage.cacheRead ?? 0),
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			calculateCost(this.model as never, usage);
			const base = {
				role: "assistant" as const,
				api: this.model.api,
				provider: this.model.provider,
				model: this.model.id,
				usage,
				timestamp: Date.now() + callNumber,
				...(step?.responseId === undefined ? {} : { responseId: step.responseId }),
			};
			if (step === undefined || step.failure !== undefined) {
				const failed = {
					...base,
					content: [],
					stopReason: "error" as const,
					errorMessage: step?.failure ?? "No more queued responses",
				} as AssistantMessage;
				outer.push({ type: "error", reason: "error", error: failed });
				outer.end(failed);
				return;
			}
			const content: AssistantMessage["content"] = [{ type: "text", text: step.text }];
			if (step.toolCall !== undefined) {
				content.push({
					type: "toolCall",
					id: `call-${callNumber}`,
					name: step.toolCall.name,
					arguments: step.toolCall.args as never,
				});
			}
			const message = { ...base, content, stopReason: step.toolCall === undefined ? "stop" : "toolUse" } as AssistantMessage;
			outer.push({ type: "start", partial: { ...message, content: [] } });
			outer.push({ type: "done", reason: step.toolCall === undefined ? "stop" : "toolUse", message });
			outer.end(message);
		});
		return outer;
	}
}

type CostRecordSeed = { readonly conversationId: string };

type CostRecordValue = {
	filled: boolean;
	source: string;
	entryId: number | null;
	responseKey: string;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	reasoning: number | null;
	contextTokens: number;
	providerCostEstimateUsd: number;
};

const emptyCostRecord = (): CostRecordValue => ({
	filled: false,
	source: "",
	entryId: null,
	responseKey: "",
	input: 0,
	cacheRead: 0,
	cacheWrite: 0,
	output: 0,
	reasoning: null,
	contextTokens: 0,
	providerCostEstimateUsd: 0,
});

const CostRecordFamilyForkInitial = defineDocFamily<CostRecordValue, CostRecordSeed>({
	kind: "spike.cost-record",
	version: 1,
	family: true,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => emptyCostRecord(),
});

const CostRecordFamilyForkCurrent = defineDocFamily<CostRecordValue, CostRecordSeed>({
	kind: "spike.cost-record-forks-copy",
	version: 1,
	family: true,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => emptyCostRecord(),
});

const fillRecord = (draft: CostRecordValue, message: AssistantMessage, source: string, entryId: number | null, responseKey: string): void => {
	draft.filled = true;
	draft.source = source;
	draft.entryId = entryId;
	draft.responseKey = responseKey;
	draft.input = message.usage.input;
	draft.cacheRead = message.usage.cacheRead;
	draft.cacheWrite = message.usage.cacheWrite;
	draft.output = message.usage.output;
	draft.reasoning = message.usage.reasoning ?? null;
	draft.contextTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
	draft.providerCostEstimateUsd = message.usage.cost.total;
};

const responseKeyOf = (message: AssistantMessage): string => message.responseId ?? `timestamp-${message.timestamp}`;

type RuntimeWithCommit = {
	commit(change: (tx: import("@earendil-works/pi-durable").Tx) => unknown, context: typeof BACKGROUND_CONTEXT): Promise<unknown>;
};

type HookObservation = { responseKey: string; hadCommitFunction: boolean; hookCalls: number };

/** An extension whose afterResponse hook reaches for the runtime's commit, which `HookApi` does not declare, and writes a keyed record. */
const hookWritingCostExtension = (observation: HookObservation[]): Extension =>
	defineExtension({
		name: "spike-cost-hook",
		hooks: [
			hook(GenerationTask, {
				afterResponse: async (message, api, hookContext) => {
					const runtime = api as unknown as RuntimeWithCommit;
					const responseKey = responseKeyOf(message);
					const hadCommitFunction = typeof runtime.commit === "function";
					observation.push({ responseKey, hadCommitFunction, hookCalls: observation.length + 1 });
					if (!hadCommitFunction) return;
					await runtime.commit(async (tx) => {
						const draft = await tx.doc(CostRecordFamilyForkInitial, api.conversationId, `response-${responseKey}`, {
							conversationId: String(api.conversationId),
						});
						if (!draft.filled) fillRecord(draft, message, "afterResponse-hook", null, responseKey);
						return undefined;
					}, hookContext);
				},
			}),
		],
	});

const echoToolExtension = (): Extension => {
	const tool = defineTool({
		name: "echo",
		description: "Echo the text.",
		parameters: Type.Object({ text: Type.String() }),
		replay: "safe",
		execute: async (args) => ({ content: [{ type: "text", text: String(args.text) }] }),
	}) as unknown as ToolRegistration;
	return defineExtension({ name: "spike-echo", tools: [tool] });
};

const delegateToolExtension = (): Extension => {
	const tool = defineTool({
		name: "delegate",
		description: "Run a sub-agent.",
		parameters: Type.Object({ task: Type.String() }),
		replay: "safe",
		execute: async (args, api, toolContext) => {
			const childId = await api.commit(async (tx) => {
				const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
				if (existing !== undefined) return existing.id;
				const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
				return created.id;
			}, toolContext);
			const child = await api.conversation(childId, toolContext);
			const request = { type: "input", content: String(args.task), requestId: `delegate:${api.taskId}` } as const;
			const settled = await (await child!.submit(request, toolContext)).wait(toolContext);
			return { content: [{ type: "text", text: settled.status }] };
		},
	}) as unknown as ToolRegistration;
	return defineExtension({ name: "spike-delegate", tools: [tool] });
};

class SimulatedProcessDeath extends Error {}

type DeathSwitch = { armed: boolean; dead: boolean; deathCommitWrites: string[] };

const describeWrites = (writes: readonly StorageWrite[]): string[] =>
	writes.map((write) => {
		if (write.type === "entry") return `entry:${write.value.kind}`;
		if (write.type === "document.create" || write.type === "document.copy") {
			return `doc.create:${write.record.kind}${write.record.key === undefined ? "" : `#${write.record.key}`}`;
		}
		if (write.type === "document.change") return "doc.change";
		return write.type;
	});

const withDeathSwitch = (storage: IndexedStorage, death: DeathSwitch): Storage =>
	new Proxy(storage, {
		get: (target, property) => {
			if (property === "commit") {
				return async (writes: readonly StorageWrite[], commitContext: typeof BACKGROUND_CONTEXT) => {
					if (death.dead) throw new SimulatedProcessDeath("process is dead");
					const writesAssistantEntry = writes.some((write) => write.type === "entry" && write.value.kind === AssistantEntry.kind);
					if (death.armed && writesAssistantEntry) {
						death.dead = true;
						death.deathCommitWrites = describeWrites(writes);
						throw new SimulatedProcessDeath("process died before the response commit landed");
					}
					return target.commit(writes, commitContext);
				};
			}
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as unknown as Storage;

type Owner = {
	readonly harness: Harness;
	readonly storage: IndexedStorage;
	readonly fence: number;
	readonly storageId: string;
	readonly commits: { seq: number; changes: string[] }[];
	readonly death: DeathSwitch;
	root(): Promise<Conversation>;
	stop(): Promise<void>;
};

const agentFor = () => ({ model: { provider: "openai", modelId: MODEL_ID }, thinkingLevel: "off" as const });

const describeChanges = (publication: CommitPublication): string[] =>
	publication.changes.map((change) => {
		if (change.type === "entry") return `entry:${change.value.kind}`;
		if (change.type === "document") return `doc:${change.record.kind}${change.record.key === undefined ? "" : `#${change.record.key}`}`;
		if (change.type === "document.copy") return `doc.copy:${change.record.kind}`;
		return change.type;
	});

async function openOwner(storageId: string, provider: PricedProvider, extensions: Extension[], armDeath = false): Promise<Owner> {
	const { storage, fence } = await openOwnerStorage(storageId, { client, s3, tableName, bucket });
	const death: DeathSwitch = { armed: armDeath, dead: false, deathCommitWrites: [] };
	const models = createModels();
	models.setProvider(provider.provider);
	const registry = createRegistry();
	for (const extension of extensions) registry.install(extension);
	const harness = await Harness.open(
		withDeathSwitch(storage, death),
		{ models, registry, settings: { retry: { maxRetries: 0, baseDelayMs: 1 }, compaction: { keepRecentTokens: 1 } }, onReport: () => undefined },
		context,
	);
	const commits: { seq: number; changes: string[] }[] = [];
	harness.subscribeCommits((publication) => {
		commits.push({ seq: Number(publication.seq), changes: describeChanges(publication) });
	});
	return {
		harness,
		storage,
		fence,
		storageId,
		commits,
		death,
		root: () => harness.root(context, { agent: agentFor() }),
		stop: async () => {
			await Promise.race([harness.close(context).catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 1500))]);
		},
	};
}

const runTurn = async (root: Conversation, content: string, requestId: string) => {
	const submission = await root.submit({ type: "input", content, requestId }, context);
	return submission.wait(context);
};

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitUntil = async (predicate: () => boolean, label: string, timeoutMilliseconds = 8000): Promise<void> => {
	const deadline = Date.now() + timeoutMilliseconds;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await sleep(20);
	}
};

const freshStorageId = (): string => storageIdFor("tenant", "bot", randomUUID());

const assistantEntriesOf = async (storage: Storage, conversationId: ConversationId) => {
	const found: { id: number; message: AssistantMessage }[] = [];
	let cursor: unknown;
	do {
		const page = await storage.scanEntries({ conversationId }, 100, cursor as never, context);
		for (const entry of page.items) {
			if (entry.kind !== AssistantEntry.kind || entry.conversationId !== conversationId) continue;
			found.push({ id: Number(entry.id), message: (entry.model as readonly AssistantMessage[])[0]! });
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return found.sort((left, right) => left.id - right.id);
};

/** The fallback writer under test: derive keyed records from the assistant entries of one conversation, in one commit. */
async function deriveCostRecordsFromEntries(
	session: Session,
	storage: Storage,
	conversationId: ConversationId,
	token: typeof CostRecordFamilyForkInitial | typeof CostRecordFamilyForkCurrent = CostRecordFamilyForkInitial,
): Promise<number> {
	const entries = await assistantEntriesOf(storage, conversationId);
	return session.commit(async (tx) => {
		let written = 0;
		for (const entry of entries) {
			const draft = await tx.doc(token, conversationId, `entry-${entry.id}`, { conversationId: String(conversationId) });
			if (draft.filled) continue;
			fillRecord(draft, entry.message, "derived-from-entry", entry.id, responseKeyOf(entry.message));
			written += 1;
		}
		return written;
	}, context);
}

const recordsOf = async (session: Session, conversationId: ConversationId, keys: string[]) => {
	const records: Record<string, Readonly<CostRecordValue> | undefined> = {};
	for (const key of keys) {
		records[key] = (await session.snapshot(CostRecordFamilyForkInitial, conversationId, key, context)) as Readonly<CostRecordValue> | undefined;
	}
	return records;
};

const listRecordKeys = async (storage: Storage, conversationId: ConversationId, kind = "spike.cost-record"): Promise<string[]> => {
	const keys: string[] = [];
	let cursor: unknown;
	do {
		const page = await storage.scanDocuments({ scope: { kind: "conversation", conversationId }, at: "current", kind }, 100, cursor as never, context);
		for (const record of page.items) if (record.key !== undefined) keys.push(record.key);
		cursor = page.next;
	} while (cursor !== undefined);
	return keys.sort();
};

const TWO_CALL_TURN = (provider: PricedProvider, prefix: string): void => {
	provider
		.enqueue({
			text: "calling the tool",
			usage: { input: 1000, output: 50, cacheRead: 4000, reasoning: 20 },
			toolCall: { name: "echo", args: { text: "hi" } },
			responseId: `${prefix}-1`,
		})
		.enqueue({ text: "done", usage: { input: 1200, output: 80, cacheRead: 4000, reasoning: 30 }, responseId: `${prefix}-2` });
};

describe("pi-durable contract for per-model-call cost records", () => {
	it("question 1: afterResponse has no transaction, so a record it writes is its own commit, before the response commit", async () => {
		const provider = new PricedProvider();
		TWO_CALL_TURN(provider, "atomic");
		const observation: HookObservation[] = [];
		const owner = await openOwner(freshStorageId(), provider, [echoToolExtension(), hookWritingCostExtension(observation)]);
		const root = await owner.root();
		const settled = await runTurn(root, "go", "turn:atomic");
		expect(settled.status).toBe("done");
		await owner.stop();

		expect(observation.map((entry) => entry.hadCommitFunction)).toEqual([true, true]);

		const commitWithCost = (key: string) => owner.commits.find((commit) => commit.changes.some((change) => change === `doc:spike.cost-record#response-${key}`));
		const assistantCommits = owner.commits.filter((commit) => commit.changes.includes(`entry:${AssistantEntry.kind}`));
		expect(assistantCommits).toHaveLength(2);
		for (const [index, key] of ["atomic-1", "atomic-2"].entries()) {
			const costCommit = commitWithCost(key)!;
			expect(costCommit).toBeDefined();
			expect(costCommit.changes.some((change) => change === `entry:${AssistantEntry.kind}`)).toBe(false);
			expect(costCommit.seq).toBeLessThan(assistantCommits[index]!.seq);
			expect(assistantCommits[index]!.changes.some((change) => change.startsWith("doc:spike.cost-record"))).toBe(false);
		}
		expect(assistantCommits[0]!.changes).toContain("doc:pi.usage");
	});

	it("question 1: pi.usage rides in the same commit as the assistant entry, so the entry itself is the atomic cost record", async () => {
		const provider = new PricedProvider();
		TWO_CALL_TURN(provider, "same");
		const owner = await openOwner(freshStorageId(), provider, [echoToolExtension()]);
		const root = await owner.root();
		await runTurn(root, "go", "turn:same");
		await owner.stop();
		const assistantCommits = owner.commits.filter((commit) => commit.changes.includes(`entry:${AssistantEntry.kind}`));
		expect(assistantCommits).toHaveLength(2);
		for (const commit of assistantCommits) expect(commit.changes).toContain("doc:pi.usage");
	});

	it("question 1: a death between the hook commit and the response commit leaves the record without the response", async () => {
		const storageId = freshStorageId();
		const provider = new PricedProvider();
		provider.enqueue({ text: "answer", usage: { input: 500, output: 40 }, responseId: "lost-1" });
		const observation: HookObservation[] = [];
		const first = await openOwner(storageId, provider, [hookWritingCostExtension(observation)], true);
		const root = await first.root();
		void root.submit({ type: "input", content: "go", requestId: "turn:death" }, context).catch(() => undefined);
		await waitUntil(() => first.death.dead, "the simulated process death");
		await first.stop();

		const readerStorage = await IndexedStorage.open({ client, s3, tableName, bucket, storageId });
		const reader = createSession(readerStorage);
		const conversationId = root.id;
		const survivors = await recordsOf(reader, conversationId, ["response-lost-1"]);
		expect(survivors["response-lost-1"]?.filled).toBe(true);
		const entriesAfterDeath = await assistantEntriesOf(readerStorage, conversationId);
		expect(entriesAfterDeath).toHaveLength(0);
		const usageAfterDeath = await reader.snapshot(UsageDoc, conversationId, context);
		expect(Object.keys(usageAfterDeath?.models ?? {})).toHaveLength(0);
		expect(first.death.deathCommitWrites).toContain(`entry:${AssistantEntry.kind}`);
		await reader.close(context);
	});

	it("question 2: after the death a new fence re-requests the model; distinct provider ids give two records for two paid calls, one id gives one", async () => {
		for (const [label, secondId, expectedRecords] of [
			["distinct", "retry-2", ["response-retry-1", "response-retry-2"]],
			["repolled", "retry-1", ["response-retry-1"]],
		] as const) {
			const storageId = freshStorageId();
			const first = await openOwner(storageId, new PricedProvider().enqueue({ text: "a", usage: { input: 500, output: 40 }, responseId: "retry-1" }), [hookWritingCostExtension([])], true);
			const root = await first.root();
			void root.submit({ type: "input", content: "go", requestId: `turn:${label}` }, context).catch(() => undefined);
			await waitUntil(() => first.death.dead, "the simulated process death");
			await first.stop();

			const provider = new PricedProvider().enqueue({ text: "a", usage: { input: 500, output: 40 }, responseId: secondId });
			const second = await openOwner(storageId, provider, [hookWritingCostExtension([])]);
			expect(second.fence).toBeGreaterThan(first.fence);
			const root2 = await second.root();
			second.harness.resume();
			const again = await root2.submit({ type: "input", content: "", requestId: `turn:${label}` }, context);
			const settled = await again.wait(context);
			expect(settled.status).toBe("done");
			expect(provider.callCount).toBe(1);
			const keys = await listRecordKeys(second.storage, root2.id);
			expect(keys).toEqual([...expectedRecords]);
			const entries = await assistantEntriesOf(second.storage, root2.id);
			expect(entries).toHaveLength(1);
			const usage = await second.harness.usage(context);
			expect(usage.models["openai/priced-model"]!.input).toBe(500);
			await second.stop();
		}
	});

	it("question 2: a stale owner cannot write a record after a takeover, so a zombie cannot double record", async () => {
		const storageId = freshStorageId();
		const provider = new PricedProvider().enqueue({ text: "ok", usage: { input: 10, output: 5 }, responseId: "zombie-1" });
		const first = await openOwner(storageId, provider, []);
		const root = await first.root();
		await runTurn(root, "go", "turn:zombie");

		const second = await openOwner(storageId, new PricedProvider(), []);
		expect(second.fence).toBeGreaterThan(first.fence);
		const writeFromStaleOwner = first.harness.commit(async (tx) => {
			const draft = await tx.doc(CostRecordFamilyForkInitial, root.id, "response-zombie-late", { conversationId: String(root.id) });
			draft.filled = true;
			return undefined;
		}, context);
		await expect(writeFromStaleOwner).rejects.toSatisfy((error: unknown) => {
			const chain: unknown[] = [error];
			for (let current = error as { cause?: unknown } | undefined; current?.cause !== undefined; current = current.cause as { cause?: unknown }) {
				chain.push(current.cause);
			}
			return chain.some((candidate) => candidate instanceof OwnershipLost);
		});
		expect(await listRecordKeys(second.storage, root.id)).toEqual([]);
		await first.stop();
		await second.stop();
	});

	it("question 2: the fallback derives keyed records from entries and is idempotent across a takeover", async () => {
		const storageId = freshStorageId();
		const provider = new PricedProvider();
		TWO_CALL_TURN(provider, "derive");
		const first = await openOwner(storageId, provider, [echoToolExtension()]);
		const root = await first.root();
		await runTurn(root, "go", "turn:derive");
		expect(await deriveCostRecordsFromEntries(first.harness, first.storage, root.id)).toBe(2);
		await first.stop();

		const second = await openOwner(storageId, new PricedProvider(), [echoToolExtension()]);
		expect(await deriveCostRecordsFromEntries(second.harness, second.storage, root.id)).toBe(0);
		expect(await deriveCostRecordsFromEntries(second.harness, second.storage, root.id)).toBe(0);
		const keys = await listRecordKeys(second.storage, root.id);
		expect(keys).toHaveLength(2);
		expect(keys.every((key) => key.startsWith("entry-"))).toBe(true);
		await second.stop();
	});

	it("question 2: a crash after the response commit loses nothing because the entry is the record the fallback derives from", async () => {
		const storageId = freshStorageId();
		const provider = new PricedProvider();
		TWO_CALL_TURN(provider, "after");
		const first = await openOwner(storageId, provider, [echoToolExtension()]);
		const root = await first.root();
		await runTurn(root, "go", "turn:after");
		await first.stop();

		const reader = await IndexedStorage.open({ client, s3, tableName, bucket, storageId });
		expect(await listRecordKeys(reader, root.id)).toEqual([]);
		const second = await openOwner(storageId, new PricedProvider(), [echoToolExtension()]);
		expect(await deriveCostRecordsFromEntries(second.harness, second.storage, root.id)).toBe(2);
		await second.stop();
		await reader.close(context);
	});

	it("question 3: a keyed record is readable by key and by listing through a reader session that replays nothing", async () => {
		const storageId = freshStorageId();
		const provider = new PricedProvider();
		TWO_CALL_TURN(provider, "read");
		const owner = await openOwner(storageId, provider, [echoToolExtension(), hookWritingCostExtension([])]);
		const root = await owner.root();
		await runTurn(root, "go", "turn:read");
		await owner.stop();

		const readerStorage = await IndexedStorage.open({ client, s3, tableName, bucket, storageId });
		const reader = createSession(readerStorage);
		const record = await reader.snapshot(CostRecordFamilyForkInitial, root.id, "response-read-2", context);
		expect(record).toMatchObject({ filled: true, input: 1200, cacheRead: 4000, output: 80, reasoning: 30, contextTokens: 5200 });
		expect(await listRecordKeys(readerStorage, root.id)).toEqual(["response-read-1", "response-read-2"]);
		const usage = await reader.snapshot(UsageDoc, root.id, context);
		expect(usage?.models["openai/priced-model"]).toMatchObject({ input: 2200, output: 130, cacheRead: 8000 });
		await reader.close(context);
	});

	it("question 3: a session opened by a different owner carries the records without any rebuild", async () => {
		const storageId = freshStorageId();
		const provider = new PricedProvider();
		TWO_CALL_TURN(provider, "carry");
		const first = await openOwner(storageId, provider, [echoToolExtension(), hookWritingCostExtension([])]);
		const root = await first.root();
		await runTurn(root, "go", "turn:carry");
		await first.stop();
		const second = await openOwner(storageId, new PricedProvider(), []);
		const carried = await second.harness.snapshot(CostRecordFamilyForkInitial, root.id, "response-carry-1", context);
		expect(carried?.filled).toBe(true);
		await second.stop();
	});

	it("question 3 and sub-agents: a fork starts empty under fork initial and copies the parent under fork current", async () => {
		const provider = new PricedProvider();
		TWO_CALL_TURN(provider, "fork");
		const owner = await openOwner(freshStorageId(), provider, [echoToolExtension()]);
		const root = await owner.root();
		await runTurn(root, "go", "turn:fork");
		await deriveCostRecordsFromEntries(owner.harness, owner.storage, root.id, CostRecordFamilyForkInitial);
		await deriveCostRecordsFromEntries(owner.harness, owner.storage, root.id, CostRecordFamilyForkCurrent);
		const page = await root.entries({}, 50, undefined, context);
		const lastEntry = page.items[0]!;
		const fork = await root.fork(lastEntry.id, { ownership: { kind: "ownerless" } }, context);

		expect(await listRecordKeys(owner.storage, fork.id, "spike.cost-record")).toEqual([]);
		expect((await listRecordKeys(owner.storage, fork.id, "spike.cost-record-forks-copy")).length).toBe(2);

		const forkEntriesWithoutOwnerFilter = await owner.storage.scanEntries({ conversationId: fork.id }, 100, undefined, context);
		const inherited = forkEntriesWithoutOwnerFilter.items.filter((entry) => entry.kind === AssistantEntry.kind && entry.conversationId === root.id);
		expect(inherited.length).toBe(2);
		expect(await assistantEntriesOf(owner.storage, fork.id)).toHaveLength(0);

		const usageOfFork = await owner.harness.snapshot(UsageDoc, fork.id, context);
		expect(Object.keys(usageOfFork?.models ?? {})).toHaveLength(0);
		await owner.stop();
	});

	it("sub-agents: task-owned child conversations enumerate by ownerTaskId and by the whole partition, and the session usage sums them", async () => {
		const provider = new PricedProvider();
		provider
			.enqueue({ text: "delegating", usage: { input: 100, output: 10 }, toolCall: { name: "delegate", args: { task: "child work" } }, responseId: "p-1" })
			.enqueue({ text: "child answer", usage: { input: 300, output: 30 }, responseId: "c-1" })
			.enqueue({ text: "parent done", usage: { input: 150, output: 15 }, responseId: "p-2" });
		const owner = await openOwner(freshStorageId(), provider, [delegateToolExtension(), hookWritingCostExtension([])]);
		const root = await owner.root();
		const settled = await runTurn(root, "go", "turn:child");
		expect(settled.status).toBe("done");
		await owner.stop();

		const enumerationStorage = await IndexedStorage.open({ client, s3, tableName, bucket, storageId: owner.storageId });
		const all = await enumerationStorage.scanConversations({}, 100, undefined, context);
		const children = all.items.filter((conversation) => conversation.owner !== undefined);
		expect(children).toHaveLength(1);
		const child = children[0]!;
		const byTask = await enumerationStorage.scanConversations({ ownerTaskId: child.owner!.taskId }, 100, undefined, context);
		expect(byTask.items.map((conversation) => conversation.id)).toEqual([child.id]);
		const byParent = await enumerationStorage.scanConversations({ ownerConversationId: root.id }, 100, undefined, context);
		expect(byParent.items.map((conversation) => conversation.id)).toEqual([child.id]);

		const readerStorage = await IndexedStorage.open({ client, s3, tableName, bucket, storageId: owner.storageId });
		const reader = createSession(readerStorage);
		const rootUsage = await reader.snapshot(UsageDoc, root.id, context);
		const childUsage = await reader.snapshot(UsageDoc, child.id, context);
		expect(rootUsage?.models["openai/priced-model"]).toMatchObject({ input: 250, output: 25 });
		expect(childUsage?.models["openai/priced-model"]).toMatchObject({ input: 300, output: 30 });
		expect(await listRecordKeys(readerStorage, child.id)).toEqual(["response-c-1"]);
		expect(await listRecordKeys(readerStorage, root.id)).toEqual(["response-p-1", "response-p-2"]);
		await reader.close(context);

		const again = await openOwner(owner.storageId, new PricedProvider(), []);
		const sessionTotal = await again.harness.usage(context);
		expect(sessionTotal.models["openai/priced-model"]).toMatchObject({ input: 550, output: 55 });
		await again.stop();
	});

	it("question 4: the stored response carries enough to derive dollars from our own price book, and the tier follows the context size", async () => {
		const provider = new PricedProvider();
		provider
			.enqueue({ text: "small", usage: { input: 1000, output: 100, cacheRead: 4000, reasoning: 40 }, responseId: "price-1" })
			.enqueue({ text: "large", usage: { input: 280000, output: 100, cacheRead: 10000, reasoning: 0 }, responseId: "price-2" });
		const owner = await openOwner(freshStorageId(), provider, []);
		const root = await owner.root();
		await runTurn(root, "one", "turn:price:1");
		await runTurn(root, "two", "turn:price:2");
		const entries = await assistantEntriesOf(owner.storage, root.id);
		await owner.stop();
		expect(entries).toHaveLength(2);

		const ourPriceBook = {
			rates: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 },
			tiers: [{ inputTokensAbove: 272000, input: 2, output: 6, cacheRead: 0.2, cacheWrite: 2.5 }],
		};
		const dollarsFrom = (usage: AssistantMessage["usage"]): number => {
			const contextTokens = usage.input + usage.cacheRead + usage.cacheWrite;
			const tier = ourPriceBook.tiers.find((candidate) => contextTokens > candidate.inputTokensAbove);
			const rates = tier ?? ourPriceBook.rates;
			return (
				(rates.input * usage.input + rates.output * usage.output + rates.cacheRead * usage.cacheRead + rates.cacheWrite * usage.cacheWrite) /
				1_000_000
			);
		};
		for (const entry of entries) {
			expect(dollarsFrom(entry.message.usage)).toBeCloseTo(entry.message.usage.cost.total, 12);
		}
		expect(entries[0]!.message.usage.reasoning).toBe(40);
		expect(entries[0]!.message.usage.output).toBe(100);
		expect(entries[1]!.message.usage.cost.input).toBeCloseTo((280000 * 2) / 1_000_000, 12);
		expect(entries[0]!.message.model).toBe(MODEL_ID);
		expect(entries[0]!.message.provider).toBe("openai");
	});

	it("question 4: an errored response with usage is an assistant entry and is counted in pi.usage", async () => {
		const provider = new PricedProvider();
		provider.enqueue({ text: "", usage: { input: 700, output: 0 }, failure: "upstream failed", responseId: "err-1" });
		const owner = await openOwner(freshStorageId(), provider, []);
		const root = await owner.root();
		const failed = await runTurn(root, "go", "turn:error");
		expect(failed.status).not.toBe("done");
		const entries = await assistantEntriesOf(owner.storage, root.id);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.message.stopReason).toBe("error");
		const usage = await owner.harness.usage(context);
		expect(usage.models["openai/priced-model"]!.input).toBe(700);
		await owner.stop();
	});

	it("question 4: compaction summarization is counted in pi.usage and the afterResponse hook never sees it", async () => {
		const provider = new PricedProvider();
		provider
			.enqueue({ text: "first answer", usage: { input: 200, output: 20 }, responseId: "k-1" })
			.enqueue({ text: "second answer", usage: { input: 260, output: 20 }, responseId: "k-2" })
			.enqueue({ text: "a summary of the work", usage: { input: 900, output: 60 }, responseId: "k-summary" });
		const observation: HookObservation[] = [];
		const owner = await openOwner(freshStorageId(), provider, [hookWritingCostExtension(observation)]);
		const root = await owner.root();
		await runTurn(root, "one", "turn:k:1");
		await runTurn(root, "two", "turn:k:2");
		const taskId = await root.compact(undefined, context);
		await owner.harness.waitForTask(taskId, context);
		const entries = await assistantEntriesOf(owner.storage, root.id);
		await owner.stop();
		expect(entries).toHaveLength(2);
		expect(provider.callCount).toBe(3);
		expect(observation.map((entry) => entry.responseKey)).toEqual(["k-1", "k-2"]);
		const usage = await (await openOwner(owner.storageId, new PricedProvider(), [])).harness.usage(context);
		expect(usage.models["openai/priced-model"]).toMatchObject({ input: 200 + 260 + 900, output: 20 + 20 + 60 });
	});
});

