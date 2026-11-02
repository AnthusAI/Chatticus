export declare class Decimal {
	static parse(value: string): Decimal;
}

export declare class VendorPriceBook {
	constructor(priceBookId: string);
	register(vendor: string, model: string, price: { inputPerMillionUsd: Decimal; outputPerMillionUsd: Decimal; cacheReadPerMillionUsd?: Decimal; cacheWritePerMillionUsd?: Decimal }): void;
}

export type TurnExecutionOutcome = "done" | "failed" | "lost" | "reconciling" | "yielded" | "parked";

export declare function consumeRunJob(job: unknown, dependencies: unknown, acknowledge: () => Promise<void>): Promise<TurnExecutionOutcome>;
