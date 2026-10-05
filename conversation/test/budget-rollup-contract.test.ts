import {
	CreateTableCommand,
	DynamoDBClient,
	GetItemCommand,
	ResourceInUseException,
} from "@aws-sdk/client-dynamodb";
import { beforeAll, describe, expect, it } from "vitest";
import { DynamoBudgetStore } from "../src/budget/budget-store.ts";
import { Decimal } from "../src/budget/decimal.ts";

/**
 * The Python spend-ceiling reader (python/src/chatticus/messaging/store.py)
 * still parses the rollup rows this writer produces, until slice 2 deletes it.
 * Python side of the contract:
 *   key      store.py:2792-2796   pk `{tenant}#budget_rollup`, sk `{env}#day#{date}`
 *   get      store.py:2459-2472   get_budget_rollup_row
 *   parse    store.py:3316-3337   _budget_rollup_from_item
 * Required attributes it reads: tenant_id S, environment S, rollup_date S,
 * vendor_cost_usd N, ce_status S, updated_at S. Optional: aws_cost_usd N,
 * combined_report_usd N, alert_events S (JSON list of source/fired_at/detail).
 * Remove this test with the Python reader in slice 2.
 */
const endpoint = process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5555";
const client = new DynamoDBClient({
	endpoint,
	region: "us-east-1",
	credentials: { accessKeyId: "test", secretAccessKey: "test" },
	maxAttempts: 1,
});
const tableName = "contract-budget-rollup";

beforeAll(async () => {
	try {
		await client.send(
			new CreateTableCommand({
				TableName: tableName,
				KeySchema: [
					{ AttributeName: "pk", KeyType: "HASH" },
					{ AttributeName: "sk", KeyType: "RANGE" },
				],
				AttributeDefinitions: [
					{ AttributeName: "pk", AttributeType: "S" },
					{ AttributeName: "sk", AttributeType: "S" },
				],
				BillingMode: "PAY_PER_REQUEST",
			}),
		);
	} catch (error) {
		if (!(error instanceof ResourceInUseException)) {
			throw error;
		}
	}
});

describe("rollup row written to DynamoDB for the Python reader", () => {
	it("has exactly the attributes and types store.py:3316 parses", async () => {
		const store = new DynamoBudgetStore(client, tableName);
		await store.putBudgetRollupRow({
			tenantId: "anthus",
			environment: "development",
			rollupDate: "2026-08-31",
			awsCostUsd: Decimal.parse("5.00"),
			vendorCostUsd: Decimal.parse("0.00004"),
			combinedReportUsd: Decimal.parse("5.00004"),
			ceStatus: "ok",
			alertEvents: [{ source: "aws_budget", firedAt: "2026-08-31T06:00:00+00:00", detail: "{}" }],
			updatedAt: "2026-08-31T06:00:00+00:00",
		});
		const response = await client.send(
			new GetItemCommand({
				TableName: tableName,
				Key: { pk: { S: "anthus#budget_rollup" }, sk: { S: "development#day#2026-08-31" } },
			}),
		);
		const item = response.Item ?? {};
		expect(Object.keys(item).sort()).toEqual(
			[
				"alert_events",
				"aws_cost_usd",
				"ce_status",
				"combined_report_usd",
				"environment",
				"pk",
				"rollup_date",
				"sk",
				"tenant_id",
				"updated_at",
				"vendor_cost_usd",
			].sort(),
		);
		expect(item.tenant_id).toEqual({ S: "anthus" });
		expect(item.environment).toEqual({ S: "development" });
		expect(item.rollup_date).toEqual({ S: "2026-08-31" });
		expect(item.ce_status).toEqual({ S: "ok" });
		expect(item.updated_at).toEqual({ S: "2026-08-31T06:00:00+00:00" });
		expect(Object.keys(item.vendor_cost_usd ?? {})).toEqual(["N"]);
		expect(Object.keys(item.aws_cost_usd ?? {})).toEqual(["N"]);
		expect(Object.keys(item.combined_report_usd ?? {})).toEqual(["N"]);
		expect(JSON.parse(item.alert_events?.S ?? "null")).toEqual([
			{ source: "aws_budget", fired_at: "2026-08-31T06:00:00+00:00", detail: "{}" },
		]);
	});
});
