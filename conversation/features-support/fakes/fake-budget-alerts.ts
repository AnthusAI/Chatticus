import {
	type BudgetAlertsPublisher,
	type ThresholdAlertPayload,
	type ThresholdCrossing,
	thresholdAlertPayload,
} from "../../src/budget/budget-alerts.ts";

/** Records published alerts for the cucumber world. */
export class FakeBudgetAlertsPublisher implements BudgetAlertsPublisher {
	readonly published: ThresholdAlertPayload[] = [];

	publishThresholdCrossing(crossing: ThresholdCrossing): Promise<void> {
		this.published.push(thresholdAlertPayload(crossing));
		return Promise.resolve();
	}
}
