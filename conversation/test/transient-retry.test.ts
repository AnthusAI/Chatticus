import {
	ConditionalCheckFailedException,
	InternalServerError,
	ProvisionedThroughputExceededException,
	RequestLimitExceeded,
	TransactionCanceledException,
	TransactionConflictException,
} from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import {
	isTransientDynamoError,
	retryTransient,
	TRANSIENT_RETRY_BASE_DELAY_MILLISECONDS,
	TRANSIENT_RETRY_BUDGET_MILLISECONDS,
	TRANSIENT_RETRY_MAX_ATTEMPTS,
} from "../src/store/transient-retry.ts";

const metadata = { $metadata: {} };
const named = (name: string): Error => Object.assign(new Error(name), { name });
const canceled = (...codes: string[]): TransactionCanceledException =>
	new TransactionCanceledException({ message: "canceled", ...metadata, CancellationReasons: codes.map((Code) => ({ Code })) });
const conflict = (): TransactionConflictException => new TransactionConflictException({ message: "ongoing", ...metadata });

const recorder = (): { sleeps: number[]; sleep: (milliseconds: number) => Promise<void> } => {
	const sleeps: number[] = [];
	return {
		sleeps,
		sleep: async (milliseconds) => {
			sleeps.push(milliseconds);
		},
	};
};

const failing = (failures: number, error: () => Error): { calls: () => number; operation: () => Promise<string> } => {
	let calls = 0;
	return {
		calls: () => calls,
		operation: async () => {
			calls += 1;
			if (calls <= failures) throw error();
			return "ok";
		},
	};
};

describe("isTransientDynamoError", () => {
	it("accepts a transaction conflict, throttling and service faults", () => {
		expect(isTransientDynamoError(conflict())).toBe(true);
		expect(isTransientDynamoError(new ProvisionedThroughputExceededException({ message: "m", ...metadata }))).toBe(true);
		expect(isTransientDynamoError(new RequestLimitExceeded({ message: "m", ...metadata }))).toBe(true);
		expect(isTransientDynamoError(new InternalServerError({ message: "m", ...metadata }))).toBe(true);
		expect(isTransientDynamoError(named("ThrottlingException"))).toBe(true);
		expect(isTransientDynamoError(named("ServiceUnavailable"))).toBe(true);
	});

	it("accepts a canceled transaction only when an item lost to a conflicting transaction", () => {
		expect(isTransientDynamoError(canceled("None", "TransactionConflict"))).toBe(true);
	});

	it("rejects a canceled transaction that failed a condition, even beside a conflict", () => {
		expect(isTransientDynamoError(canceled("ConditionalCheckFailed", "None"))).toBe(false);
		expect(isTransientDynamoError(canceled("TransactionConflict", "ConditionalCheckFailed"))).toBe(false);
		expect(isTransientDynamoError(canceled("None", "None"))).toBe(false);
	});

	it("rejects a failed condition and ordinary errors", () => {
		expect(isTransientDynamoError(new ConditionalCheckFailedException({ message: "m", ...metadata }))).toBe(false);
		expect(isTransientDynamoError(named("ValidationException"))).toBe(false);
		expect(isTransientDynamoError(new Error("boom"))).toBe(false);
		expect(isTransientDynamoError(null)).toBe(false);
		expect(isTransientDynamoError("TransactionConflictException")).toBe(false);
	});
});

describe("retryTransient", () => {
	it("returns the first success without sleeping", async () => {
		const { sleeps, sleep } = recorder();
		const subject = failing(0, conflict);
		expect(await retryTransient(subject.operation, { sleep, random: () => 0.5 })).toBe("ok");
		expect(subject.calls()).toBe(1);
		expect(sleeps).toEqual([]);
	});

	it("repeats after transient failures with full-jitter delays under a doubling ceiling", async () => {
		const { sleeps, sleep } = recorder();
		const subject = failing(3, conflict);
		expect(await retryTransient(subject.operation, { sleep, random: () => 0.5 })).toBe("ok");
		expect(subject.calls()).toBe(4);
		const base = TRANSIENT_RETRY_BASE_DELAY_MILLISECONDS;
		expect(sleeps).toEqual([0.5 * base, 0.5 * base * 2, 0.5 * base * 4]);
	});

	it("uses the whole range from zero up to the ceiling", async () => {
		const low = recorder();
		await retryTransient(failing(1, conflict).operation, { sleep: low.sleep, random: () => 0 });
		const high = recorder();
		await retryTransient(failing(1, conflict).operation, { sleep: high.sleep, random: () => 0.999999 });
		expect(low.sleeps).toEqual([0]);
		expect(high.sleeps[0]).toBeGreaterThan(TRANSIENT_RETRY_BASE_DELAY_MILLISECONDS * 0.99);
		expect(high.sleeps[0]).toBeLessThan(TRANSIENT_RETRY_BASE_DELAY_MILLISECONDS);
	});

	it("rethrows the last error after the attempt limit and never makes more attempts", async () => {
		const { sleeps, sleep } = recorder();
		const subject = failing(Number.MAX_SAFE_INTEGER, conflict);
		await expect(retryTransient(subject.operation, { sleep, random: () => 0.5 })).rejects.toBeInstanceOf(TransactionConflictException);
		expect(subject.calls()).toBe(TRANSIENT_RETRY_MAX_ATTEMPTS);
		expect(sleeps).toHaveLength(TRANSIENT_RETRY_MAX_ATTEMPTS - 1);
	});

	it("stops when the sleeping budget would be exceeded", async () => {
		const { sleeps, sleep } = recorder();
		const subject = failing(Number.MAX_SAFE_INTEGER, conflict);
		await expect(
			retryTransient(subject.operation, { sleep, random: () => 0.999, baseDelayMilliseconds: 1000, maxAttempts: 50 }),
		).rejects.toBeInstanceOf(TransactionConflictException);
		expect(sleeps.reduce((total, milliseconds) => total + milliseconds, 0)).toBeLessThanOrEqual(TRANSIENT_RETRY_BUDGET_MILLISECONDS);
		expect(subject.calls()).toBeLessThan(10);
	});

	it("rethrows a failed condition at once", async () => {
		const { sleeps, sleep } = recorder();
		const subject = failing(5, () => new ConditionalCheckFailedException({ message: "m", ...metadata }));
		await expect(retryTransient(subject.operation, { sleep })).rejects.toBeInstanceOf(ConditionalCheckFailedException);
		expect(subject.calls()).toBe(1);
		expect(sleeps).toEqual([]);
	});

	it("rethrows a canceled transaction with a failed condition at once", async () => {
		const subject = failing(5, () => canceled("TransactionConflict", "ConditionalCheckFailed"));
		await expect(retryTransient(subject.operation, { sleep: recorder().sleep })).rejects.toBeInstanceOf(TransactionCanceledException);
		expect(subject.calls()).toBe(1);
	});

	it("rethrows a non-transient error at once", async () => {
		const subject = failing(5, () => new Error("boom"));
		await expect(retryTransient(subject.operation, { sleep: recorder().sleep })).rejects.toThrow("boom");
		expect(subject.calls()).toBe(1);
	});

	it("retries a canceled transaction that lost to a conflict", async () => {
		const subject = failing(2, () => canceled("None", "TransactionConflict"));
		expect(await retryTransient(subject.operation, { sleep: recorder().sleep, random: () => 0.1 })).toBe("ok");
		expect(subject.calls()).toBe(3);
	});
});
