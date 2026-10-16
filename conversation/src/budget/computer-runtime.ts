import type { BudgetStore } from "./budget-store.ts";
import { Decimal } from "./decimal.ts";
import type { ComputerRuntimeSegment } from "./models.ts";

/**
 * What one hour of the organization computer task costs in United States dollars: 0.25 vCPU at 0.03238 plus 0.5 GB at
 * 0.00356, which is 0.008095 plus 0.00178. Those are the AWS Fargate on-demand Linux/ARM64 rates for us-east-1, where the
 * deployment account runs, as the AWS Price List API published them on 2026-09-11 (usage types
 * USE1-Fargate-ARM-vCPU-Hours:perCPU and USE1-Fargate-ARM-GB-Hours). The task size is the one infra/lib/computer-stack.ts
 * declares. Change this figure when either the rates or the task size change.
 */
export const COMPUTER_TASK_USD_PER_HOUR = Decimal.parse("0.009875");

/** Fargate bills a task for at least one minute. */
export const MINIMUM_BILLED_SECONDS = 60;

const SECONDS_PER_HOUR = 3600;
const MILLISECONDS_PER_DAY = 86_400_000;
const COST_SCALE = 8;

/**
 * The seconds of one owner run that fall inside one UTC day. A run is billed for at least the Fargate minimum, counted
 * from its start, so a short run is lengthened before it is cut at the day boundaries.
 */
export function billedSecondsWithinDay(segment: ComputerRuntimeSegment, day: string): number {
	const dayStart = Date.parse(`${day}T00:00:00Z`);
	const dayEnd = dayStart + MILLISECONDS_PER_DAY;
	const start = segment.startedAt.getTime();
	const observedMilliseconds = Math.max(0, segment.lastSeenAt.getTime() - start);
	const billedEnd = start + Math.max(observedMilliseconds, MINIMUM_BILLED_SECONDS * 1000);
	const overlapMilliseconds = Math.min(billedEnd, dayEnd) - Math.max(start, dayStart);
	return Math.max(0, overlapMilliseconds) / 1000;
}

/** What the organization's computer task cost over the given runs inside one UTC day. */
export function computerSpendForDay(segments: readonly ComputerRuntimeSegment[], day: string): Decimal {
	let billedMilliseconds = 0;
	for (const segment of segments) {
		billedMilliseconds += billedSecondsWithinDay(segment, day) * 1000;
	}
	return COMPUTER_TASK_USD_PER_HOUR.multiplyByInteger(Math.round(billedMilliseconds)).divideByInteger(
		SECONDS_PER_HOUR * 1000,
		COST_SCALE,
	);
}

/**
 * Read what an organization hosted in the deployment account spent on its computer in one UTC day. It rejects when the
 * runtime records cannot be read; a day the computer never ran is a measured zero.
 */
export interface HostedComputerSpendReader {
	dailyTotal(request: { tenantId: string; rollupDate: string }): Promise<Decimal>;
}

/** Price the owner runs the control plane recorded for the organization. */
export class RecordedRuntimeComputerSpendReader implements HostedComputerSpendReader {
	private readonly store: Pick<BudgetStore, "listComputerRuntimeSegments">;

	constructor(store: Pick<BudgetStore, "listComputerRuntimeSegments">) {
		this.store = store;
	}

	async dailyTotal(request: { tenantId: string; rollupDate: string }): Promise<Decimal> {
		return computerSpendForDay(await this.store.listComputerRuntimeSegments(request.tenantId), request.rollupDate);
	}
}
