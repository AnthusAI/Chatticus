import { PublishCommand, type SNSClient } from "@aws-sdk/client-sns";
import type { Decimal } from "./decimal.ts";
import { ROLLUP_ALERT_SOURCE } from "./models.ts";

export interface ThresholdCrossing {
	readonly environment: string;
	readonly thresholdPercent: number;
	readonly vendorMtdUsd: Decimal;
	readonly monthlyLimitUsd: Decimal;
	readonly rollupDate: string;
}

/** Publish rollup threshold alerts to the budgets SNS topic. */
export interface BudgetAlertsPublisher {
	publishThresholdCrossing(crossing: ThresholdCrossing): Promise<void>;
}

export interface ThresholdAlertPayload {
	readonly source: string;
	readonly kind: string;
	readonly environment: string;
	readonly threshold_percent: number;
	readonly vendor_mtd_usd: string;
	readonly monthly_limit_usd: string;
	readonly rollup_date: string;
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
}
