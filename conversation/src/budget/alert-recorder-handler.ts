import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoBudgetStore } from "./budget-store.ts";
import { utcDayOf } from "./calendar.ts";
import { recordBudgetAlertFromSns } from "./alert-recorder.ts";

interface SnsEvent {
	readonly Records?: ReadonlyArray<{ readonly Sns?: { readonly Message?: unknown } }>;
}

function requiredEnvironmentValue(name: string): string {
	const value = (process.env[name] ?? "").trim();
	if (value === "") {
		throw new Error(`${name} is required for the budget alert recorder.`);
	}
	return value;
}

/** SNS entrypoint: append AWS Budgets alerts to the account rollup row. */
export async function handler(event: SnsEvent): Promise<void> {
	const tableName = requiredEnvironmentValue("CHATTICUS_MESSAGING_TABLE");
	const environment = requiredEnvironmentValue("CHATTICUS_ENVIRONMENT");
	const store = new DynamoBudgetStore(new DynamoDBClient({}), tableName);
	for (const record of event.Records ?? []) {
		const snsMessage = record.Sns?.Message;
		if (typeof snsMessage !== "string") {
			continue;
		}
		const now = new Date();
		await recordBudgetAlertFromSns({ store, environment, rollupDate: utcDayOf(now), snsMessage, now });
	}
}
