import {
	type AttributeValue,
	GetItemCommand,
	type DynamoDBClient,
	PutItemCommand,
	QueryCommand,
	type QueryCommandInput,
	ScanCommand,
	type ScanCommandInput,
} from "@aws-sdk/client-dynamodb";
import { Decimal } from "./decimal.ts";
import {
	ACCOUNT_TENANT_ID,
	type BudgetAlertEvent,
	type BudgetRollupRow,
	type BudgetThresholdState,
	ORGANIZATION_STATUS_ENABLED,
	type Organization,
	type VendorLedgerRow,
} from "./models.ts";

type Item = Record<string, AttributeValue>;

/**
 * What the budget jobs need from the single `Messaging` table. The vendor
 * ledger and organization items are written by the Python control plane and
 * are read-only here; rollup rows and threshold state belong to the budget jobs.
 */
export interface BudgetStore {
	listEnabledOrganizations(): Promise<Organization[]>;
	listVendorLedgerRowsForTenant(tenantId: string): Promise<VendorLedgerRow[]>;
	getBudgetRollupRow(tenantId: string, environment: string, rollupDate: string): Promise<BudgetRollupRow | null>;
	putBudgetRollupRow(row: BudgetRollupRow): Promise<void>;
	getAccountBudgetRollupRow(environment: string, rollupDate: string): Promise<BudgetRollupRow | null>;
	putAccountBudgetRollupRow(row: BudgetRollupRow): Promise<void>;
	getBudgetThresholdState(environment: string): Promise<BudgetThresholdState | null>;
	putBudgetThresholdState(state: BudgetThresholdState): Promise<void>;
}

export function vendorLedgerKey(tenantId: string, turnId: string): { pk: string; sk: string } {
	return { pk: `${tenantId}#vendor_ledger`, sk: `turn#${turnId}` };
}

export function organizationKey(tenantId: string): { pk: string; sk: string } {
	return { pk: `${tenantId}#org`, sk: "meta" };
}

export function budgetRollupKey(
	tenantId: string,
	environment: string,
	rollupDate: string,
): { pk: string; sk: string } {
	return { pk: `${tenantId}#budget_rollup`, sk: `${environment}#day#${rollupDate}` };
}

export function budgetThresholdStateKey(environment: string): { pk: string; sk: string } {
	return { pk: `${ACCOUNT_TENANT_ID}#budget_rollup`, sk: `${environment}#threshold_state` };
}

function keyOf(key: { pk: string; sk: string }): Item {
	return { pk: { S: key.pk }, sk: { S: key.sk } };
}

function requireString(item: Item, name: string): string {
	const value = item[name]?.S;
	if (value === undefined) {
		throw new Error(`Item is missing string attribute ${name}.`);
	}
	return value;
}

function requireNumber(item: Item, name: string): string {
	const value = item[name]?.N;
	if (value === undefined) {
		throw new Error(`Item is missing number attribute ${name}.`);
	}
	return value;
}

function optionalString(item: Item, name: string): string | null {
	return item[name]?.S ?? null;
}

function optionalDecimal(item: Item, name: string): Decimal | null {
	const raw = item[name]?.N;
	return raw === undefined ? null : Decimal.parse(raw);
}

export function organizationFromItem(item: Item): Organization {
	return {
		tenantId: requireString(item, "tenant_id"),
		awsAccountId: optionalString(item, "aws_account_id"),
		awsCrossAccountRole: optionalString(item, "aws_cross_account_role"),
		awsExternalId: optionalString(item, "aws_external_id"),
	};
}

export function vendorLedgerRowFromItem(item: Item): VendorLedgerRow {
	return {
		tenantId: requireString(item, "tenant_id"),
		turnId: requireString(item, "turn_id"),
		billedVia: requireString(item, "billed_via"),
		costUsd: optionalDecimal(item, "cost_usd"),
		recordedAt: requireString(item, "recorded_at"),
	};
}

export function budgetRollupItem(row: BudgetRollupRow): Item {
	const events = row.alertEvents.map((event) => ({
		source: event.source,
		fired_at: event.firedAt,
		detail: event.detail,
	}));
	const item: Item = {
		...keyOf(budgetRollupKey(row.tenantId, row.environment, row.rollupDate)),
		tenant_id: { S: row.tenantId },
		environment: { S: row.environment },
		rollup_date: { S: row.rollupDate },
		vendor_cost_usd: { N: row.vendorCostUsd.toString() },
		ce_status: { S: row.ceStatus },
		updated_at: { S: row.updatedAt },
		alert_events: { S: JSON.stringify(events) },
	};
	if (row.awsCostUsd !== null) {
		item.aws_cost_usd = { N: row.awsCostUsd.toString() };
	}
	if (row.combinedReportUsd !== null) {
		item.combined_report_usd = { N: row.combinedReportUsd.toString() };
	}
	return item;
}

export function budgetRollupFromItem(item: Item): BudgetRollupRow {
	const rawEvents = item.alert_events?.S ?? "[]";
	const parsed: unknown = JSON.parse(rawEvents);
	if (!Array.isArray(parsed)) {
		throw new Error("alert_events is not a JSON list.");
	}
	const alertEvents: BudgetAlertEvent[] = parsed.map((entry: Record<string, unknown>) => ({
		source: String(entry.source),
		firedAt: String(entry.fired_at),
		detail: String(entry.detail),
	}));
	return {
		tenantId: requireString(item, "tenant_id"),
		environment: requireString(item, "environment"),
		rollupDate: requireString(item, "rollup_date"),
		awsCostUsd: optionalDecimal(item, "aws_cost_usd"),
		vendorCostUsd: Decimal.parse(requireNumber(item, "vendor_cost_usd")),
		combinedReportUsd: optionalDecimal(item, "combined_report_usd"),
		ceStatus: requireString(item, "ce_status"),
		alertEvents,
		updatedAt: requireString(item, "updated_at"),
	};
}

/** The DynamoDB-backed store used by the Lambdas and by the cucumber world against moto. */
export class DynamoBudgetStore implements BudgetStore {
	private readonly client: DynamoDBClient;
	private readonly tableName: string;

	constructor(client: DynamoDBClient, tableName: string) {
		this.client = client;
		this.tableName = tableName;
	}

	async listEnabledOrganizations(): Promise<Organization[]> {
		const organizations: Organization[] = [];
		let startKey: ScanCommandInput["ExclusiveStartKey"];
		do {
			const response = await this.client.send(
				new ScanCommand({
					TableName: this.tableName,
					FilterExpression: "sk = :meta AND attribute_exists(owner_user_id) AND #status = :status",
					ExpressionAttributeNames: { "#status": "status" },
					ExpressionAttributeValues: {
						":meta": { S: "meta" },
						":status": { S: ORGANIZATION_STATUS_ENABLED },
					},
					ExclusiveStartKey: startKey,
				}),
			);
			for (const item of response.Items ?? []) {
				organizations.push(organizationFromItem(item));
			}
			startKey = response.LastEvaluatedKey;
		} while (startKey !== undefined);
		return organizations.sort((left, right) => (left.tenantId < right.tenantId ? -1 : 1));
	}

	async listVendorLedgerRowsForTenant(tenantId: string): Promise<VendorLedgerRow[]> {
		const rows: VendorLedgerRow[] = [];
		let startKey: QueryCommandInput["ExclusiveStartKey"];
		do {
			const response = await this.client.send(
				new QueryCommand({
					TableName: this.tableName,
					KeyConditionExpression: "pk = :pk",
					ExpressionAttributeValues: { ":pk": { S: `${tenantId}#vendor_ledger` } },
					ExclusiveStartKey: startKey,
				}),
			);
			for (const item of response.Items ?? []) {
				rows.push(vendorLedgerRowFromItem(item));
			}
			startKey = response.LastEvaluatedKey;
		} while (startKey !== undefined);
		return rows;
	}

	async getBudgetRollupRow(
		tenantId: string,
		environment: string,
		rollupDate: string,
	): Promise<BudgetRollupRow | null> {
		const response = await this.client.send(
			new GetItemCommand({
				TableName: this.tableName,
				Key: keyOf(budgetRollupKey(tenantId, environment, rollupDate)),
			}),
		);
		return response.Item === undefined ? null : budgetRollupFromItem(response.Item);
	}

	async putBudgetRollupRow(row: BudgetRollupRow): Promise<void> {
		await this.client.send(new PutItemCommand({ TableName: this.tableName, Item: budgetRollupItem(row) }));
	}

	getAccountBudgetRollupRow(environment: string, rollupDate: string): Promise<BudgetRollupRow | null> {
		return this.getBudgetRollupRow(ACCOUNT_TENANT_ID, environment, rollupDate);
	}

	putAccountBudgetRollupRow(row: BudgetRollupRow): Promise<void> {
		return this.putBudgetRollupRow(row);
	}

	async getBudgetThresholdState(environment: string): Promise<BudgetThresholdState | null> {
		const response = await this.client.send(
			new GetItemCommand({
				TableName: this.tableName,
				Key: keyOf(budgetThresholdStateKey(environment)),
			}),
		);
		const item = response.Item;
		if (item === undefined) {
			return null;
		}
		return {
			environment,
			lastNotifiedBand: Number(requireNumber(item, "last_notified_band")),
			updatedAt: requireString(item, "updated_at"),
		};
	}

	async putBudgetThresholdState(state: BudgetThresholdState): Promise<void> {
		await this.client.send(
			new PutItemCommand({
				TableName: this.tableName,
				Item: {
					...keyOf(budgetThresholdStateKey(state.environment)),
					last_notified_band: { N: String(state.lastNotifiedBand) },
					updated_at: { S: state.updatedAt },
				},
			}),
		);
	}
}
