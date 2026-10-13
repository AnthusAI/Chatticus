import { Decimal } from "../budget/decimal.ts";

const MILLION_EXPONENT = 6;
const COST_SCALE = 8;

/** How a priced call was priced; a call can carry several labels. */
export const PRICED_WITH_LIST = "list";
export const PRICED_WITH_LONG_CONTEXT_TIER = "long_context_tier";
export const PRICED_WITH_UNCACHED_FALLBACK = "uncached_fallback";

/**
 * Per-million-token list rates in United States dollars. The cache rates are optional: a model whose source lists no
 * cached-input pricing carries none, and a call's cached tokens are then priced at the input rate and flagged
 * `uncached_fallback` rather than at a guessed rate.
 */
export type VendorRates = {
	readonly inputPerMillionUsd: Decimal;
	readonly outputPerMillionUsd: Decimal;
	readonly cacheReadPerMillionUsd?: Decimal;
	readonly cacheWritePerMillionUsd?: Decimal;
};

/** Rates that replace the base rates for a call whose context is larger than `inputTokensAbove`. */
export type VendorPriceTier = VendorRates & { readonly inputTokensAbove: number };

/** The price of one vendor model: base rates and the long-context tiers above them. */
export type VendorPrice = VendorRates & { readonly tiers?: readonly VendorPriceTier[] };

/**
 * Write-time vendor model prices under one version id. The id names the source and retrieval date of the figures and is
 * recorded on every ledger row the book prices.
 */
export class VendorPriceBook {
	readonly priceBookId: string;
	private readonly prices = new Map<string, VendorPrice>();

	/** @param priceBookId Version id naming the source and date of the prices. */
	constructor(priceBookId: string) {
		this.priceBookId = priceBookId;
	}

	/** Register the price of one vendor model. */
	register(vendor: string, model: string, price: VendorPrice): void {
		this.prices.set(`${vendor}\u0000${model}`, price);
	}

	/** The price of one vendor model, or null when none is registered. */
	lookup(vendor: string, model: string): VendorPrice | null {
		return this.prices.get(`${vendor}\u0000${model}`) ?? null;
	}
}

/**
 * Token counts of one model call as the Pi session stores them: `inputTokens` excludes cached tokens, `outputTokens`
 * includes reasoning tokens, and the context size is the sum of the three input counters.
 */
export type CallUsage = {
	readonly inputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly outputTokens: number;
};

/** One model call: who served it and what it used. */
export type PricedCallSubject = CallUsage & { readonly vendor: string; readonly model: string };

/** The dollars of one call and how they were reached. */
export type PricedCall = {
	readonly costUsd: Decimal;
	readonly pricedWith: readonly string[];
	readonly appliedRates: VendorRates;
};

/** Raised when the price book has no entry for the model of a call; a model is never priced as zero. */
export class UnpricedModelError extends Error {
	readonly vendor: string;
	readonly model: string;
	readonly priceBookId: string;

	constructor(vendor: string, model: string, priceBookId: string) {
		super(`No price is tabled for model ${vendor}/${model} in price book ${priceBookId}.`);
		this.name = "UnpricedModelError";
		this.vendor = vendor;
		this.model = model;
		this.priceBookId = priceBookId;
	}
}

/** The context size of a call, which selects its price tier. */
export const contextTokensOf = (usage: CallUsage): number => usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;

function ratesFor(price: VendorPrice, contextTokens: number): { rates: VendorRates; tiered: boolean } {
	let chosen: VendorPriceTier | null = null;
	for (const tier of price.tiers ?? []) {
		if (contextTokens > tier.inputTokensAbove && (chosen === null || tier.inputTokensAbove > chosen.inputTokensAbove)) chosen = tier;
	}
	return chosen === null ? { rates: price, tiered: false } : { rates: chosen, tiered: true };
}

const componentCost = (rate: Decimal, tokens: number): Decimal =>
	rate.multiplyByInteger(tokens).divideByPowerOfTen(MILLION_EXPONENT).quantize(COST_SCALE);

/**
 * Dollars for one model call at the rates of its own model: uncached input at the input rate, cached reads and writes at
 * their cache rates, output (reasoning included) at the output rate, all at the tier its context size selects. Each part
 * is rounded half to even at eight places.
 *
 * @param book The price book.
 * @param call The model that served the call and its token counters.
 * @throws UnpricedModelError When the book has no price for the model.
 */
export function priceCall(book: VendorPriceBook, call: PricedCallSubject): PricedCall {
	const price = book.lookup(call.vendor, call.model);
	if (price === null) throw new UnpricedModelError(call.vendor, call.model, book.priceBookId);
	const { rates, tiered } = ratesFor(price, contextTokensOf(call));
	const labels = new Set<string>([tiered ? PRICED_WITH_LONG_CONTEXT_TIER : PRICED_WITH_LIST]);
	let cost = componentCost(rates.inputPerMillionUsd, call.inputTokens).add(componentCost(rates.outputPerMillionUsd, call.outputTokens));
	const cached: ReadonlyArray<readonly [number, Decimal | undefined]> = [
		[call.cacheReadTokens, rates.cacheReadPerMillionUsd],
		[call.cacheWriteTokens, rates.cacheWritePerMillionUsd],
	];
	for (const [tokens, rate] of cached) {
		if (tokens === 0) continue;
		if (rate === undefined) labels.add(PRICED_WITH_UNCACHED_FALLBACK);
		cost = cost.add(componentCost(rate ?? rates.inputPerMillionUsd, tokens));
	}
	return { costUsd: cost, pricedWith: [...labels].sort(), appliedRates: rates };
}

/** The dollars of a set of calls, each priced by its own model. */
export type PricedCalls = {
	readonly costUsd: Decimal | null;
	readonly pricedWith: readonly string[];
	readonly unpricedCalls: number;
	readonly models: readonly string[];
};

/**
 * Price every call of a turn by its own model. A call whose model is not in the book is counted as unpriced, and the
 * total is then unknown (null) rather than the sum of the priced part, so a partial figure is never shown as complete.
 */
export function priceCalls(book: VendorPriceBook, calls: readonly PricedCallSubject[]): PricedCalls {
	let total = Decimal.zero();
	let unpricedCalls = 0;
	const labels = new Set<string>();
	const models = new Set<string>();
	for (const call of calls) {
		models.add(call.model);
		try {
			const priced = priceCall(book, call);
			total = total.add(priced.costUsd);
			for (const label of priced.pricedWith) labels.add(label);
		} catch (error) {
			if (!(error instanceof UnpricedModelError)) throw error;
			unpricedCalls += 1;
		}
	}
	return { costUsd: unpricedCalls > 0 ? null : total, pricedWith: [...labels].sort(), unpricedCalls, models: [...models].sort() };
}
