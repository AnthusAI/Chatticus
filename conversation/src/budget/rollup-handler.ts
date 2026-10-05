import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SNSClient } from "@aws-sdk/client-sns";
import { STSClient } from "@aws-sdk/client-sts";
import { SnsBudgetAlertsPublisher } from "./budget-alerts.ts";
import { DynamoBudgetStore } from "./budget-store.ts";
import { addDays, utcDayOf } from "./calendar.ts";
import {
	AwsAccountSpendReader,
	AwsCostExplorerReader,
	costExplorerApiForCredentials,
	hostedCostExplorerApi,
} from "./cost-explorer.ts";
import { Decimal } from "./decimal.ts";
import { runDailyRollup } from "./runner.ts";

function requiredEnvironmentValue(name: string): string {
	const value = (process.env[name] ?? "").trim();
	if (value === "") {
		throw new Error(`${name} is required for daily rollup.`);
	}
	return value;
}

/** Scheduled entrypoint: run one daily rollup for yesterday in the configured environment. */
export async function handler(): Promise<void> {
	const environment = requiredEnvironmentValue("CHATTICUS_ENVIRONMENT");
	const tableName = requiredEnvironmentValue("CHATTICUS_MESSAGING_TABLE");
	const monthlyLimitUsd = Decimal.parse(requiredEnvironmentValue("CHATTICUS_BUDGETS_MONTHLY_LIMIT_USD"));
	const topicArn = (process.env.CHATTICUS_BUDGETS_ALERTS_TOPIC_ARN ?? "").trim();
	const now = new Date();
	const rollupDate = addDays(utcDayOf(now), -1);
	console.log(`daily_rollup_start environment=${environment} rollup_date=${rollupDate}`);
	await runDailyRollup({
		store: new DynamoBudgetStore(new DynamoDBClient({}), tableName),
		costExplorer: new AwsCostExplorerReader(hostedCostExplorerApi()),
		accountSpend: new AwsAccountSpendReader(new STSClient({}), costExplorerApiForCredentials),
		alerts: topicArn === "" ? null : new SnsBudgetAlertsPublisher(topicArn, new SNSClient({})),
		environment,
		rollupDate,
		monthlyLimitUsd,
		now,
	});
	console.log(`daily_rollup_complete environment=${environment} rollup_date=${rollupDate}`);
}
