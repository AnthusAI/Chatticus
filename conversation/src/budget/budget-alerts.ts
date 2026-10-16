import { PublishCommand, type SNSClient } from "@aws-sdk/client-sns";
import type { Decimal } from "./decimal.ts";
import { ROLLUP_ALERT_SOURCE } from "./models.ts";

export interface ThresholdCrossing {
	readonly environment: string;
	readonly thresholdPercent: number;
	readonly vendorMtdUsd: Decimal;
	readonly monthlyLimitUsd: Decimal;
	readonly rollupDate: string;
	/** Month-to-date model calls the price book could not price; their dollars are missing from `vendorMtdUsd`. */
	readonly unpricedCalls: number;
}

/** One organization-day the rollup could not read. */
export interface UnreadableSpendDay {
	readonly tenantId: string;
	readonly rollupDate: string;
}

/** The organization-days one rollup run could not read. */
export interface UnreadableSpendReport {
	readonly environment: string;
	readonly rollupDate: string;
	readonly unreadableDays: readonly UnreadableSpendDay[];
}

/** Publish rollup alerts to the budgets SNS topic. */
export interface BudgetAlertsPublisher {
	publishThresholdCrossing(crossing: ThresholdCrossing): Promise<void>;
	publishUnreadableSpend(report: UnreadableSpendReport): Promise<void>;
}

export interface ThresholdAlertPayload {
	readonly source: string;
	readonly kind: string;
	readonly environment: string;
	readonly threshold_percent: number;
	readonly vendor_mtd_usd: string;
	readonly monthly_limit_usd: string;
	readonly rollup_date: string;
	readonly unpriced_calls: number;
}

export function thresholdAlertPayload(crossing: ThresholdCrossing): ThresholdAlertPayload {
	return {
		source: ROLLUP_ALERT_SOURCE,
		kind: "vendor_threshold",
		environment: crossing.environment,
		threshold_percent: crossing.thresholdPercent,
		vendor_mtd_usd: crossing.vendorMtdUsd.toString(),
		monthly_limit_usd: crossing.monthlyLimitUsd.toString(),
		rollup_date: crossing.rollupDate,
		unpriced_calls: crossing.unpricedCalls,
	};
}

export interface UnreadableSpendAlertPayload {
	readonly source: string;
	readonly kind: string;
	readonly environment: string;
	readonly rollup_date: string;
	readonly unreadable_days: ReadonlyArray<{ readonly tenant_id: string; readonly rollup_date: string }>;
}

export function unreadableSpendAlertPayload(report: UnreadableSpendReport): UnreadableSpendAlertPayload {
	return {
		source: ROLLUP_ALERT_SOURCE,
		kind: "spend_unreadable",
		environment: report.environment,
		rollup_date: report.rollupDate,
		unreadable_days: report.unreadableDays.map((day) => ({ tenant_id: day.tenantId, rollup_date: day.rollupDate })),
	};
}

/** Publish rollup alerts through SNS. */
export class SnsBudgetAlertsPublisher implements BudgetAlertsPublisher {
	private readonly topicArn: string;
	private readonly client: SNSClient;

	constructor(topicArn: string, client: SNSClient) {
		this.topicArn = topicArn;
		this.client = client;
	}

	async publishThresholdCrossing(crossing: ThresholdCrossing): Promise<void> {
		await this.client.send(
			new PublishCommand({
				TopicArn: this.topicArn,
				Message: JSON.stringify(thresholdAlertPayload(crossing)),
				Subject:
					`Chatticus vendor spend reached ${crossing.thresholdPercent}% ` +
					`of monthly limit (${crossing.environment})`,
			}),
		);
	}

	async publishUnreadableSpend(report: UnreadableSpendReport): Promise<void> {
		await this.client.send(
			new PublishCommand({
				TopicArn: this.topicArn,
				Message: JSON.stringify(unreadableSpendAlertPayload(report)),
				Subject: `Chatticus spend could not be read for ${report.unreadableDays.length} organization-days (${report.environment})`,
			}),
		);
	}
}
