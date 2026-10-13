import type { Context } from "@earendil-works/chord";
import {
	AssistantEntry,
	type ConversationId,
	type Cursor,
	defineDocFamily,
	type EntryId,
	type Session,
	type Storage,
} from "@earendil-works/pi-durable";
import {
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
	kind: "turn_round";
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

function fillRecord(
	draft: ModelCallCost,
	call: AssistantCall,
	round: number,
	turnId: string,
	prices: VendorPriceBook,
	recordedAt: string,
): void {
	draft.filled = true;
	draft.entryId = call.entryId;
	draft.turnId = turnId;
	draft.round = round;
	draft.provider = call.subject.vendor;
	draft.model = call.subject.model;
	draft.responseId = call.responseId;
	draft.inputTokens = call.subject.inputTokens;
	draft.cacheReadTokens = call.subject.cacheReadTokens;
	draft.cacheWriteTokens = call.subject.cacheWriteTokens;
	draft.outputTokens = call.subject.outputTokens;
	draft.reasoningTokens = call.reasoningTokens;
	draft.contextTokens = call.subject.inputTokens + call.subject.cacheReadTokens + call.subject.cacheWriteTokens;
	draft.priceBookId = prices.priceBookId;
	draft.providerCostEstimateUsd = call.providerCostEstimateUsd;
	draft.recordedAt = recordedAt;
	try {
		const priced = priceCall(prices, call.subject);
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
