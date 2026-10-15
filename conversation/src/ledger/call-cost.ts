import type { Context } from "@earendil-works/chord";
import {
	AssistantEntry,
	type ConversationId,
	type Cursor,
	defineDocFamily,
	type EntryId,
	type Session,
	type Storage,
	UsageDoc,
} from "@earendil-works/pi-durable";
import {
	contextTokensOf,
	PRICED_WITH_LONG_CONTEXT_TIER,
	priceCall,
	type PricedCallSubject,
	UnpricedModelError,
	type VendorPriceBook,
} from "./price-book.ts";

const ENTRY_PAGE_SIZE = 100;
const DOCUMENT_PAGE_SIZE = 100;

/** The kind of the session document family that holds one cost record per model call. */
export const CALL_COST_DOCUMENT_KIND = "chatticus.cost";

/** The version of the record shape; a reader that meets another version must migrate, not branch. */
export const CALL_COST_RECORD_VERSION = 1;

/** The price tier a call was priced at: the base rates or the long-context rates above them. */
export type CallCostTier = "standard" | "long_context";

/**
 * What a cost record is the cost of. `turn_round` is one model call of a turn, derived from the assistant entry that
 * answered it (a successful, errored or aborted response alike). `compaction` is the summarization spend of a
 * conversation, which has no entry and is recovered from the session's own usage ledger. `voice_understanding` is the
 * call that repairs a spoken line; it has no session and lives only in the messaging table.
 */
export type CostRecordKind = "turn_round" | "compaction" | "voice_understanding";

/** One model call's usage and who served it, in the counters the Pi session stores. */
export type ModelCallUsage = PricedCallSubject & { readonly reasoningTokens: number };

/**
 * The cost of one model call, derived from the assistant entry that answered it and priced from a versioned price book.
 * `inputTokens` excludes cached tokens and `outputTokens` includes reasoning tokens, exactly as the Pi session stores
 * them. `reasoningTokens` is the part of `outputTokens` spent reasoning (0 when the vendor reports none). `costUsd` is
 * decimal text, and null with `unpriced` true when the book had no price for the model, which means unknown and never zero.
 */
export type ModelCallCost = {
	version: number;
	filled: boolean;
	conversationId: string;
	entryId: number;
	kind: CostRecordKind;
	turnId: string;
	round: number;
	provider: string;
	model: string;
	responseId: string | null;
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	contextTokens: number;
	priceBookId: string;
	tier: CallCostTier | null;
	pricedWith: string[];
	inputRatePerMillionUsd: string | null;
	outputRatePerMillionUsd: string | null;
	costUsd: string | null;
	unpriced: boolean;
	providerCostEstimateUsd: number;
	recordedAt: string;
};

/** What a cost record needs to exist before it is filled: the conversation it belongs to. */
export type CallCostSeed = { readonly conversationId: string };

const emptyCallCost = (seed: CallCostSeed): ModelCallCost => ({
	version: CALL_COST_RECORD_VERSION,
	filled: false,
	conversationId: seed.conversationId,
	entryId: 0,
	kind: "turn_round",
	turnId: "",
	round: 0,
	provider: "",
	model: "",
	responseId: null,
	inputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	outputTokens: 0,
	reasoningTokens: 0,
	contextTokens: 0,
	priceBookId: "",
	tier: null,
	pricedWith: [],
	inputRatePerMillionUsd: null,
	outputRatePerMillionUsd: null,
	costUsd: null,
	unpriced: false,
	providerCostEstimateUsd: 0,
	recordedAt: "",
});

/**
 * The `chatticus.cost` session document family: one keyed record per model call of a conversation, committed with the
 * session so it is copied, restored and handed to a new owner with it. A fork starts with no records (`fork: "initial"`),
 * because the calls of a parent are the parent's cost; copying them would count them twice.
 */
export const CallCostDoc = defineDocFamily<ModelCallCost, CallCostSeed>({
	kind: CALL_COST_DOCUMENT_KIND,
	version: CALL_COST_RECORD_VERSION,
	family: true,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: (seed) => emptyCallCost(seed),
});

/** The key of the record of one assistant entry; the same entry always has the same key, which is the idempotency. */
export const callCostKeyOf = (entryId: number): string => `entry-${entryId}`;

type AssistantCall = {
	readonly entryId: number;
	readonly subject: PricedCallSubject;
	readonly reasoningTokens: number;
	readonly responseId: string | null;
	readonly providerCostEstimateUsd: number;
};

async function assistantCallsOf(
	storage: Pick<Storage, "scanEntries">,
	conversationId: ConversationId,
	fromEntryId: number,
	context: Context,
): Promise<AssistantCall[]> {
	const calls: AssistantCall[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanEntries({ conversationId, minEntryId: fromEntryId as EntryId }, ENTRY_PAGE_SIZE, cursor, context);
		for (const entry of page.items) {
			if (entry.kind !== AssistantEntry.kind || entry.conversationId !== conversationId) continue;
			const message = entry.model?.[0];
			if (message?.role !== "assistant") continue;
			calls.push({
				entryId: Number(entry.id),
				subject: {
					vendor: message.provider,
					model: message.model,
					inputTokens: message.usage.input,
					cacheReadTokens: message.usage.cacheRead,
					cacheWriteTokens: message.usage.cacheWrite,
					outputTokens: message.usage.output,
				},
				reasoningTokens: message.usage.reasoning ?? 0,
				responseId: message.responseId ?? null,
				providerCostEstimateUsd: message.usage.cost.total,
			});
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return calls.sort((left, right) => left.entryId - right.entryId);
}

function priceInto(draft: ModelCallCost, subject: PricedCallSubject, prices: VendorPriceBook): void {
	draft.priceBookId = prices.priceBookId;
	try {
		const priced = priceCall(prices, subject);
		draft.costUsd = priced.costUsd.toString();
		draft.pricedWith = [...priced.pricedWith];
		draft.tier = priced.pricedWith.includes(PRICED_WITH_LONG_CONTEXT_TIER) ? "long_context" : "standard";
		draft.inputRatePerMillionUsd = priced.appliedRates.inputPerMillionUsd.toString();
		draft.outputRatePerMillionUsd = priced.appliedRates.outputPerMillionUsd.toString();
		draft.unpriced = false;
	} catch (error) {
		if (!(error instanceof UnpricedModelError)) throw error;
		draft.unpriced = true;
	}
}

/** Everything that identifies and measures one cost record before it is priced. */
export type CostRecordFacts = {
	readonly kind: CostRecordKind;
	readonly conversationId: string;
	readonly entryId: number;
	readonly turnId: string;
	readonly round: number;
	readonly usage: ModelCallUsage;
	readonly responseId: string | null;
	readonly providerCostEstimateUsd: number;
	readonly recordedAt: string;
};

function fillFacts(draft: ModelCallCost, facts: CostRecordFacts, prices: VendorPriceBook): void {
	draft.filled = true;
	draft.kind = facts.kind;
	draft.entryId = facts.entryId;
	draft.turnId = facts.turnId;
	draft.round = facts.round;
	draft.provider = facts.usage.vendor;
	draft.model = facts.usage.model;
	draft.responseId = facts.responseId;
	draft.inputTokens = facts.usage.inputTokens;
	draft.cacheReadTokens = facts.usage.cacheReadTokens;
	draft.cacheWriteTokens = facts.usage.cacheWriteTokens;
	draft.outputTokens = facts.usage.outputTokens;
	draft.reasoningTokens = facts.usage.reasoningTokens;
	draft.contextTokens = contextTokensOf(facts.usage);
	draft.providerCostEstimateUsd = facts.providerCostEstimateUsd;
	draft.recordedAt = facts.recordedAt;
	priceInto(draft, facts.usage, prices);
}

/**
 * A priced cost record for a call that has no session, such as the voice understanding call. It is the same record, priced
 * by the same function, as the ones the session holds, so every consumer of cost records reads it alike.
 *
 * @param facts What identifies and measures the call.
 * @param prices The price book.
 * @returns The filled record.
 */
export function buildModelCallCost(facts: CostRecordFacts, prices: VendorPriceBook): ModelCallCost {
	const record = emptyCallCost({ conversationId: facts.conversationId });
	fillFacts(record, facts, prices);
	return record;
}

function fillRecord(
	draft: ModelCallCost,
	call: AssistantCall,
	round: number,
	turnId: string,
	prices: VendorPriceBook,
	recordedAt: string,
): void {
	fillFacts(
		draft,
		{
			kind: "turn_round",
			conversationId: draft.conversationId,
			entryId: call.entryId,
			turnId,
			round,
			usage: { ...call.subject, reasoningTokens: call.reasoningTokens },
			responseId: call.responseId,
			providerCostEstimateUsd: call.providerCostEstimateUsd,
			recordedAt,
		},
		prices,
	);
}

/** What deriving the cost records of one turn of one conversation needs to know. */
export type DeriveCallCostRequest = {
	readonly conversationId: ConversationId;
	readonly turnId: string;
	/** The entry of the turn's prompt: the calls of the turn are the assistant entries from it on. */
	readonly promptEntryId: number;
	readonly prices: VendorPriceBook;
	readonly now: () => Date;
};

/**
 * The one writer of cost records. Scan the assistant entries of one conversation from the turn's prompt entry on and
 * write a keyed record for each that has none yet, all in one commit. A record is a pure function of the entry and the
 * price book, and its key is the entry, so running this any number of times, on any owner, after any crash, writes each
 * call exactly once and loses none that the session committed. Entries a fork inherits from its parent are not the
 * fork's calls and are skipped by their own conversation id.
 *
 * @param session The owner's session; the commit is fenced by its storage, so a stale owner writes nothing.
 * @param storage The session's storage, for scanning entries.
 * @param request The conversation, the turn, the entry the turn began at, the price book and the clock.
 * @param context Cancellation context.
 * @returns How many records this call wrote.
 */
export async function deriveCostRecordsFromEntries(
	session: Pick<Session, "commit">,
	storage: Pick<Storage, "scanEntries">,
	request: DeriveCallCostRequest,
	context: Context,
): Promise<number> {
	const calls = await assistantCallsOf(storage, request.conversationId, request.promptEntryId, context);
	if (calls.length === 0) return 0;
	const recordedAt = request.now().toISOString();
	return session.commit(async (tx) => {
		let written = 0;
		for (const [index, call] of calls.entries()) {
			const draft = await tx.doc(CallCostDoc, request.conversationId, callCostKeyOf(call.entryId), {
				conversationId: String(request.conversationId),
			});
			if (draft.filled) continue;
			fillRecord(draft, call, index + 1, request.turnId, request.prices, recordedAt);
			written += 1;
		}
		return written;
	}, context);
}

type TokenCounters = {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	reasoning: number;
	estimateUsd: number;
};

const zeroCounters = (): TokenCounters => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, estimateUsd: 0 });

const hasTokens = (counters: TokenCounters): boolean =>
	counters.input + counters.cacheRead + counters.cacheWrite + counters.output > 0;

const positiveDifference = (left: TokenCounters, right: TokenCounters): TokenCounters => ({
	input: Math.max(0, left.input - right.input),
	cacheRead: Math.max(0, left.cacheRead - right.cacheRead),
	cacheWrite: Math.max(0, left.cacheWrite - right.cacheWrite),
	output: Math.max(0, left.output - right.output),
	reasoning: Math.max(0, left.reasoning - right.reasoning),
	estimateUsd: Math.max(0, left.estimateUsd - right.estimateUsd),
});

function addCounters(total: TokenCounters, part: TokenCounters): void {
	total.input += part.input;
	total.cacheRead += part.cacheRead;
	total.cacheWrite += part.cacheWrite;
	total.output += part.output;
	total.reasoning += part.reasoning;
	total.estimateUsd += part.estimateUsd;
}

const modelKeyOf = (provider: string, model: string): string => `${provider}/${model}`;

async function usageLedgerOfConversation(
	session: Pick<Session, "snapshot">,
	conversationId: ConversationId,
	context: Context,
): Promise<Map<string, TokenCounters>> {
	const state = await session.snapshot(UsageDoc, conversationId, context);
	const byModel = new Map<string, TokenCounters>();
	for (const [key, usage] of Object.entries(state?.models ?? {})) {
		byModel.set(key, {
			input: usage.input,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			output: usage.output,
			reasoning: usage.reasoning ?? 0,
			estimateUsd: usage.cost.total,
		});
	}
	return byModel;
}

async function entryUsageOfConversation(
	storage: Pick<Storage, "scanEntries">,
	conversationId: ConversationId,
	context: Context,
): Promise<{ byModel: Map<string, TokenCounters>; newestEntryId: number }> {
	const byModel = new Map<string, TokenCounters>();
	let newestEntryId = 0;
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanEntries({ conversationId }, ENTRY_PAGE_SIZE, cursor, context);
		for (const entry of page.items) {
			if (entry.conversationId !== conversationId) continue;
			newestEntryId = Math.max(newestEntryId, Number(entry.id));
			if (entry.kind !== AssistantEntry.kind) continue;
			const message = entry.model?.[0];
			if (message?.role !== "assistant") continue;
			const key = modelKeyOf(message.provider, message.model);
			const total = byModel.get(key) ?? zeroCounters();
			addCounters(total, {
				input: message.usage.input,
				cacheRead: message.usage.cacheRead,
				cacheWrite: message.usage.cacheWrite,
				output: message.usage.output,
				reasoning: message.usage.reasoning ?? 0,
				estimateUsd: message.usage.cost.total,
			});
			byModel.set(key, total);
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return { byModel, newestEntryId };
}

/** The key of a compaction record; it names the cumulative spend it brings the conversation's records up to. */
export const compactionCostKeyOf = (provider: string, model: string, cumulative: TokenCounters): string =>
	`compaction-${provider}-${model}-${cumulative.input}-${cumulative.cacheRead}-${cumulative.cacheWrite}-${cumulative.output}`;

/**
 * Record the summarization spend of compaction, which has no assistant entry. The session's own usage ledger
 * (`pi.usage`) counts every response and every compaction summary of a conversation, per model; the entries hold every
 * response. What the ledger holds beyond the entries is the compaction spend so far, and what the conversation's
 * compaction records already hold is subtracted, so only the new spend becomes a new record. The ledger is read before
 * the entries, so a response committed between the two reads makes the remainder smaller, never larger, and is then
 * counted as its own entry and not as compaction. Running this again with nothing new writes nothing.
 *
 * @param session The owner's session; the commit is fenced by its storage.
 * @param storage The session's storage.
 * @param request The conversation, the turn the spend is attributed to, the price book and the clock.
 * @param context Cancellation context.
 * @returns How many records this call wrote.
 */
export async function deriveCompactionCostRecords(
	session: Pick<Session, "commit" | "snapshot">,
	storage: Pick<Storage, "scanEntries" | "scanDocuments">,
	request: Pick<DeriveCallCostRequest, "conversationId" | "turnId" | "prices" | "now">,
	context: Context,
): Promise<number> {
	const ledger = await usageLedgerOfConversation(session, request.conversationId, context);
	if (ledger.size === 0) return 0;
	const entries = await entryUsageOfConversation(storage, request.conversationId, context);
	const remainders = new Map<string, TokenCounters>();
	for (const [key, counters] of ledger) {
		const remainder = positiveDifference(counters, entries.byModel.get(key) ?? zeroCounters());
		if (hasTokens(remainder)) remainders.set(key, remainder);
	}
	if (remainders.size === 0) return 0;
	const recorded = new Map<string, TokenCounters>();
	for (const record of await readCallCostRecords(session, storage, request.conversationId, context)) {
		if (record.kind !== "compaction") continue;
		const key = modelKeyOf(record.provider, record.model);
		const total = recorded.get(key) ?? zeroCounters();
		addCounters(total, {
			input: record.inputTokens,
			cacheRead: record.cacheReadTokens,
			cacheWrite: record.cacheWriteTokens,
			output: record.outputTokens,
			reasoning: record.reasoningTokens,
			estimateUsd: record.providerCostEstimateUsd,
		});
		recorded.set(key, total);
	}
	const recordedAt = request.now().toISOString();
	return session.commit(async (tx) => {
		let written = 0;
		for (const [key, cumulative] of remainders) {
			const fresh = positiveDifference(cumulative, recorded.get(key) ?? zeroCounters());
			if (!hasTokens(fresh)) continue;
			const separator = key.indexOf("/");
			const provider = key.slice(0, separator);
			const model = key.slice(separator + 1);
			const draft = await tx.doc(CallCostDoc, request.conversationId, compactionCostKeyOf(provider, model, cumulative), {
				conversationId: String(request.conversationId),
			});
			if (draft.filled) continue;
			fillFacts(
				draft,
				{
					kind: "compaction",
					conversationId: String(request.conversationId),
					entryId: entries.newestEntryId,
					turnId: request.turnId,
					round: 0,
					usage: {
						vendor: provider,
						model,
						inputTokens: fresh.input,
						cacheReadTokens: fresh.cacheRead,
						cacheWriteTokens: fresh.cacheWrite,
						outputTokens: fresh.output,
						reasoningTokens: fresh.reasoning,
					},
					responseId: null,
					providerCostEstimateUsd: fresh.estimateUsd,
					recordedAt,
				},
				request.prices,
			);
			written += 1;
		}
		return written;
	}, context);
}

/**
 * Derive every cost record a conversation owes at this moment: one per assistant entry from the turn's prompt on, and the
 * compaction spend the session's usage ledger holds beyond its entries. Both are keyed and idempotent.
 *
 * @param session The owner's session.
 * @param storage The session's storage.
 * @param request The conversation, the turn, its prompt entry, the price book and the clock.
 * @param context Cancellation context.
 * @returns How many records this call wrote.
 */
export async function deriveCostRecords(
	session: Pick<Session, "commit" | "snapshot">,
	storage: Pick<Storage, "scanEntries" | "scanDocuments">,
	request: DeriveCallCostRequest,
	context: Context,
): Promise<number> {
	const fromEntries = await deriveCostRecordsFromEntries(session, storage, request, context);
	return fromEntries + (await deriveCompactionCostRecords(session, storage, request, context));
}

/**
 * Read every cost record of one conversation, oldest call first, through any handle on the session: an owner's, or a
 * plain reader over an unfenced storage that replays nothing.
 *
 * @param session Anything that can snapshot a document.
 * @param storage Anything that can list documents.
 * @param conversationId The conversation.
 * @param context Cancellation context.
 * @returns The filled records.
 */
export async function readCallCostRecords(
	session: Pick<Session, "snapshot">,
	storage: Pick<Storage, "scanDocuments">,
	conversationId: ConversationId,
	context: Context,
): Promise<ModelCallCost[]> {
	const keys: string[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanDocuments(
			{ scope: { kind: "conversation", conversationId }, at: "current", kind: CALL_COST_DOCUMENT_KIND },
			DOCUMENT_PAGE_SIZE,
			cursor,
			context,
		);
		for (const record of page.items) if (record.key !== undefined) keys.push(record.key);
		cursor = page.next;
	} while (cursor !== undefined);
	const records: ModelCallCost[] = [];
	for (const key of keys) {
		const value = await session.snapshot(CallCostDoc, conversationId, key, context);
		if (value !== undefined && value.filled) records.push({ ...value, pricedWith: [...value.pricedWith] });
	}
	return records.sort((left, right) => left.entryId - right.entryId);
}
