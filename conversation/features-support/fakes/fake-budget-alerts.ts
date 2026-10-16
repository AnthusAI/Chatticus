import {
	type BudgetAlertsPublisher,
	type ThresholdAlertPayload,
	type ThresholdCrossing,
	type UnreadableSpendAlertPayload,
	type UnreadableSpendReport,
	thresholdAlertPayload,
	unreadableSpendAlertPayload,
} from "../../src/budget/budget-alerts.ts";

/** Records published alerts for the cucumber world. */
export class FakeBudgetAlertsPublisher implements BudgetAlertsPublisher {
	readonly published: ThresholdAlertPayload[] = [];
	readonly unreadableSpendPublished: UnreadableSpendAlertPayload[] = [];

	publishThresholdCrossing(crossing: ThresholdCrossing): Promise<void> {
		this.published.push(thresholdAlertPayload(crossing));
		return Promise.resolve();
	}

	publishUnreadableSpend(report: UnreadableSpendReport): Promise<void> {
		this.unreadableSpendPublished.push(unreadableSpendAlertPayload(report));
		return Promise.resolve();
	}
}
