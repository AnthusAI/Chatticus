import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { recordBudgetAlertFromSns } from "../../src/budget/alert-recorder.ts";
import { budgetRollupKey } from "../../src/budget/budget-store.ts";
import { dayWrittenIn } from "../../src/budget/calendar.ts";
import { Decimal } from "../../src/budget/decimal.ts";
import {
	AWS_BUDGET_ALERT_SOURCE,
	BILLED_VIA_AWS,
	BILLED_VIA_VENDOR,
	type BudgetRollupRow,
	ROLLUP_ALERT_SOURCE,
} from "../../src/budget/models.ts";
import { RecordedRuntimeComputerSpendReader } from "../../src/budget/computer-runtime.ts";
import { RollupDateInvalidError, resolveRollupDate } from "../../src/budget/rollup-date.ts";
import { runDailyRollup } from "../../src/budget/runner.ts";
import { organizationComputerWorkPaused } from "../../src/domain/organization-spend.ts";
import { reconcilerOf } from "../cost-reconciliation-support.ts";
import { DEPLOYMENT_AWS_ACCOUNT_ID } from "../messaging-table.ts";
import type { ChatticusWorld } from "../world.ts";

const CUSTOMER_ACCOUNT_ID = "111122223333";

Given("a daily budget rollup harness for environment {string}", function (this: ChatticusWorld, environment: string) {
	this.budgetEnvironment = environment;
});

Given("the account monthly budget limit is {word} USD", function (this: ChatticusWorld, amount: string) {
	this.monthlyLimitUsd = Decimal.parse(amount);
});

Given(
	"organization {string} with tenant {string} is enabled",
	async function (this: ChatticusWorld, name: string, tenantId: string) {
		await this.messagingTable.putOrganization(
			{ tenantId, name, awsAccountId: DEPLOYMENT_AWS_ACCOUNT_ID },
			this.now.toISOString(),
		);
	},
);

Given(
	"organization {string} with tenant {string} runs in its own AWS account",
	async function (this: ChatticusWorld, name: string, tenantId: string) {
		await this.messagingTable.putOrganization(
			{
				tenantId,
				name,
				awsAccountId: CUSTOMER_ACCOUNT_ID,
				awsCrossAccountRole: `arn:aws:iam::${CUSTOMER_ACCOUNT_ID}:role/ChatticusOrganizationComputerRole`,
				awsExternalId: tenantId,
			},
			this.now.toISOString(),
		);
		this.customerOrganization = {
			tenantId,
			awsAccountId: CUSTOMER_ACCOUNT_ID,
			awsCrossAccountRole: `arn:aws:iam::${CUSTOMER_ACCOUNT_ID}:role/ChatticusOrganizationComputerRole`,
			awsExternalId: tenantId,
		};
	},
);

function customerAccountId(world: ChatticusWorld): string {
	assert.ok(world.customerOrganization !== null, "no customer-account organization was seeded");
	assert.ok(world.customerOrganization.awsAccountId !== null);
	return world.customerOrganization.awsAccountId;
}

Given("its own account spent {word} USD on {word}", function (this: ChatticusWorld, amount: string, day: string) {
	this.accountSpend.setTotal(customerAccountId(this), day, Decimal.parse(amount));
});

Given("its own account cannot be read", function (this: ChatticusWorld) {
	this.accountSpend.failAccount(customerAccountId(this));
});

Given("its own account has no data for {word}", function (this: ChatticusWorld, day: string) {
	this.accountSpend.setDayPending(customerAccountId(this), day);
});

When("its own account can be read again", function (this: ChatticusWorld) {
	this.accountSpend.restoreAccount(customerAccountId(this));
});

async function clearVendorSpendForDay(world: ChatticusWorld, tenantId: string, day: string): Promise<void> {
	for (const row of await world.store.listVendorLedgerRowsForTenant(tenantId)) {
		if (dayWrittenIn(row.recordedAt) === day) {
			await world.messagingTable.deleteVendorLedgerRow(tenantId, row.turnId);
		}
	}
}

async function recordVendorSpend(
	world: ChatticusWorld,
	request: {
		tenantId: string;
		day: string;
		amount: Decimal | null;
		billedVia: string;
		turnSuffix?: string;
		unpricedCalls?: number;
		responseIds?: readonly string[];
	},
): Promise<void> {
	await world.messagingTable.putVendorLedgerRow({
		tenantId: request.tenantId,
		turnId: `${request.tenantId}-${request.day}-${request.billedVia}${request.turnSuffix ?? ""}`,
		billedVia: request.billedVia,
		costUsd: request.billedVia === BILLED_VIA_VENDOR ? request.amount : null,
		recordedAt: `${request.day}T12:00:00+00:00`,
		...(request.unpricedCalls === undefined ? {} : { unpricedCalls: request.unpricedCalls }),
		...(request.responseIds === undefined ? {} : { responseIds: request.responseIds }),
	});
}

Given(
	"vendor spend for tenant {string} on {word} totals {word} USD",
	async function (this: ChatticusWorld, tenantId: string, day: string, amount: string) {
		await clearVendorSpendForDay(this, tenantId, day);
		await recordVendorSpend(this, { tenantId, day, amount: Decimal.parse(amount), billedVia: BILLED_VIA_VENDOR });
	},
);

Given(
	"vendor spend for tenant {string} on {word} includes {word} USD billed_via vendor",
	async function (this: ChatticusWorld, tenantId: string, day: string, amount: string) {
		await recordVendorSpend(this, { tenantId, day, amount: Decimal.parse(amount), billedVia: BILLED_VIA_VENDOR });
	},
);

Given(
	"vendor spend for tenant {string} on {word} includes {word} USD billed_via vendor for response {string}",
	async function (this: ChatticusWorld, tenantId: string, day: string, amount: string, response: string) {
		await recordVendorSpend(this, {
			tenantId,
			day,
			amount: Decimal.parse(amount),
			billedVia: BILLED_VIA_VENDOR,
			turnSuffix: `-${response}`,
			responseIds: [response],
		});
	},
);

Given(
	"vendor spend for tenant {string} on {word} includes a turn with {int} unpriced calls and no dollars",
	async function (this: ChatticusWorld, tenantId: string, day: string, unpricedCalls: number) {
		await recordVendorSpend(this, {
			tenantId,
			day,
			amount: null,
			billedVia: BILLED_VIA_VENDOR,
			turnSuffix: "-unpriced",
			unpricedCalls,
		});
	},
);

Given(
	"vendor spend for tenant {string} on {word} includes aws-billed tokens with null dollars",
	async function (this: ChatticusWorld, tenantId: string, day: string) {
		await recordVendorSpend(this, {
			tenantId,
			day,
			amount: Decimal.zero(),
			billedVia: BILLED_VIA_AWS,
			turnSuffix: "-aws",
		});
	},
);

async function runRollup(world: ChatticusWorld, day: string): Promise<void> {
	await runDailyRollup({
		store: world.store,
		hostedComputerSpend: new RecordedRuntimeComputerSpendReader(world.store),
		accountSpend: world.accountSpend,
		alerts: world.budgetAlerts,
		reconciler: reconcilerOf(world),
		environment: world.budgetEnvironment,
		rollupDate: day,
		monthlyLimitUsd: world.monthlyLimitUsd,
		now: world.now,
	});
}

When("the daily budget rollup runs for {word}", async function (this: ChatticusWorld, day: string) {
	await runRollup(this, day);
});

When("the daily budget rollup runs for {word} again", async function (this: ChatticusWorld, day: string) {
	await runRollup(this, day);
});

async function recordAwsBudgetAlert(world: ChatticusWorld, day: string, payload: object): Promise<void> {
	await recordBudgetAlertFromSns({
		store: world.store,
		environment: world.budgetEnvironment,
		rollupDate: day,
		snsMessage: JSON.stringify(payload),
		now: world.now,
	});
}

When(
	"an AWS Budgets alert arrives for budget {string} on {word}",
	async function (this: ChatticusWorld, budgetName: string, day: string) {
		await recordAwsBudgetAlert(this, day, {
			budgetName,
			budgetType: "COST",
			budgetThreshold: "80",
			notificationType: "ACTUAL",
		});
	},
);

When(
	"a PascalCase AWS Budgets alert arrives for budget {string} on {word}",
	async function (this: ChatticusWorld, budgetName: string, day: string) {
		await recordAwsBudgetAlert(this, day, {
			BudgetName: budgetName,
			BudgetType: "COST",
			BudgetThreshold: "80",
			NotificationType: "ACTUAL",
			AccountId: "111111111111",
		});
	},
);

When("a rollup threshold alert message arrives on the budgets topic", async function (this: ChatticusWorld) {
	await recordAwsBudgetAlert(this, "2026-08-31", {
		source: ROLLUP_ALERT_SOURCE,
		kind: "vendor_threshold",
		threshold_percent: 50,
	});
});

async function rollupRow(
	world: ChatticusWorld,
	tenantId: string,
	environment: string,
	day: string,
): Promise<BudgetRollupRow> {
	const row = await world.store.getBudgetRollupRow(tenantId, environment, day);
	assert.ok(row !== null, `No rollup row for ${tenantId} ${environment} on ${day}.`);
	return row;
}

function assertDecimalEquals(actual: Decimal | null, expected: string): void {
	assert.ok(actual !== null, `expected ${expected} but the value is null`);
	assert.ok(actual.equals(Decimal.parse(expected)), `expected ${expected} but got ${actual.toString()}`);
}

Then(
	"the budget rollup for tenant {string} environment {string} on {word} has aws_cost_usd {word}",
	async function (this: ChatticusWorld, tenantId: string, environment: string, day: string, amount: string) {
		assertDecimalEquals((await rollupRow(this, tenantId, environment, day)).awsCostUsd, amount);
	},
);

Then(
	"the budget rollup for tenant {string} environment {string} on {word} has vendor_cost_usd {word}",
	async function (this: ChatticusWorld, tenantId: string, environment: string, day: string, amount: string) {
		assertDecimalEquals((await rollupRow(this, tenantId, environment, day)).vendorCostUsd, amount);
	},
);

Then(
	"the budget rollup for tenant {string} environment {string} on {word} has unpriced_calls {int}",
	async function (this: ChatticusWorld, tenantId: string, environment: string, day: string, count: number) {
		assert.equal((await rollupRow(this, tenantId, environment, day)).unpricedCalls, count);
	},
);

Then("the budget threshold alert reports {int} unpriced calls", function (this: ChatticusWorld, count: number) {
	const payload = this.budgetAlerts.published.at(-1);
	assert.ok(payload !== undefined, "no budget threshold alert was published");
	assert.equal(payload.unpriced_calls, count);
});

Then(
	"the budget rollup for tenant {string} environment {string} on {word} has combined_report_usd {word}",
	async function (this: ChatticusWorld, tenantId: string, environment: string, day: string, amount: string) {
		assertDecimalEquals((await rollupRow(this, tenantId, environment, day)).combinedReportUsd, amount);
	},
);

Then(
	"the budget rollup for tenant {string} environment {string} on {word} has null aws_cost_usd",
	async function (this: ChatticusWorld, tenantId: string, environment: string, day: string) {
		assert.equal((await rollupRow(this, tenantId, environment, day)).awsCostUsd, null);
	},
);

Then(
	"the budget rollup for tenant {string} environment {string} on {word} has null combined_report_usd",
	async function (this: ChatticusWorld, tenantId: string, environment: string, day: string) {
		assert.equal((await rollupRow(this, tenantId, environment, day)).combinedReportUsd, null);
	},
);

Then(
	"the budget rollup for tenant {string} environment {string} on {word} has ce_status {string}",
	async function (this: ChatticusWorld, tenantId: string, environment: string, day: string, status: string) {
		assert.equal((await rollupRow(this, tenantId, environment, day)).ceStatus, status);
	},
);

Then("exactly {int} budget threshold alert was published", function (this: ChatticusWorld, count: number) {
	assert.equal(this.budgetAlerts.published.length, count);
});

Then("exactly {int} budget threshold alerts were published", function (this: ChatticusWorld, count: number) {
	assert.equal(this.budgetAlerts.published.length, count);
});

Then("no budget threshold alert was published", function (this: ChatticusWorld) {
	assert.equal(this.budgetAlerts.published.length, 0);
});

Then("exactly {int} unreadable spend alert was published", function (this: ChatticusWorld, count: number) {
	assert.equal(this.budgetAlerts.unreadableSpendPublished.length, count);
});

Then("no unreadable spend alert was published", function (this: ChatticusWorld) {
	assert.equal(this.budgetAlerts.unreadableSpendPublished.length, 0);
});

function lastUnreadableSpendAlertDays(world: ChatticusWorld): ReadonlyArray<{ tenant_id: string; rollup_date: string }> {
	const payload = world.budgetAlerts.unreadableSpendPublished.at(-1);
	assert.ok(payload !== undefined, "no unreadable spend alert was published");
	assert.equal(payload.source, ROLLUP_ALERT_SOURCE);
	return payload.unreadable_days;
}

Then(
	"the unreadable spend alert names tenant {string} on {word}",
	function (this: ChatticusWorld, tenantId: string, day: string) {
		const days = lastUnreadableSpendAlertDays(this);
		assert.ok(days.some((entry) => entry.tenant_id === tenantId && entry.rollup_date === day), JSON.stringify(days));
	},
);

Then("the unreadable spend alert does not name tenant {string}", function (this: ChatticusWorld, tenantId: string) {
	const days = lastUnreadableSpendAlertDays(this);
	assert.ok(!days.some((entry) => entry.tenant_id === tenantId), JSON.stringify(days));
});

Then("the budget threshold alert has threshold_percent {int}", function (this: ChatticusWorld, percent: number) {
	const payload = this.budgetAlerts.published.at(-1);
	assert.ok(payload !== undefined, "no budget threshold alert was published");
	assert.equal(payload.threshold_percent, percent);
});

Then("the budget threshold alert source is {string}", function (this: ChatticusWorld, source: string) {
	const payload = this.budgetAlerts.published.at(-1);
	assert.ok(payload !== undefined, "no budget threshold alert was published");
	assert.equal(payload.source, source);
});

Then("the account budget rollup for {word} records an aws_budget_alert", async function (this: ChatticusWorld, day: string) {
	const row = await this.store.getAccountBudgetRollupRow(this.budgetEnvironment, day);
	assert.ok(row !== null, `no account rollup row for ${day}`);
	assert.ok(row.alertEvents.some((event) => event.source === AWS_BUDGET_ALERT_SOURCE));
});

Then(
	"the account budget rollup for {word} still has {int} aws_budget_alert",
	async function (this: ChatticusWorld, day: string, count: number) {
		const row = await this.store.getAccountBudgetRollupRow(this.budgetEnvironment, day);
		assert.ok(row !== null, `no account rollup row for ${day}`);
		assert.equal(row.alertEvents.filter((event) => event.source === AWS_BUDGET_ALERT_SOURCE).length, count);
	},
);

Then(
	"there is {int} budget rollup row for tenant {string} environment {string} on {word}",
	async function (this: ChatticusWorld, count: number, tenantId: string, environment: string, day: string) {
		const key = budgetRollupKey(tenantId, environment, day);
		assert.equal(await this.messagingTable.countItemsWithSortKeyPrefix(key.pk, key.sk), count);
	},
);

async function invokeScheduledRollup(world: ChatticusWorld, event: { date?: unknown } | undefined, invokedAt: string): Promise<void> {
	world.scheduledRollupRejection = null;
	const invocationTime = new Date(invokedAt);
	try {
		const rollupDate = resolveRollupDate(event, invocationTime);
		await runDailyRollup({
			store: world.store,
			hostedComputerSpend: new RecordedRuntimeComputerSpendReader(world.store),
			accountSpend: world.accountSpend,
			alerts: world.budgetAlerts,
			reconciler: reconcilerOf(world),
			environment: world.budgetEnvironment,
			rollupDate,
			monthlyLimitUsd: world.monthlyLimitUsd,
			now: invocationTime,
		});
	} catch (error) {
		if (!(error instanceof RollupDateInvalidError)) {
			throw error;
		}
		world.scheduledRollupRejection = error;
	}
}

When(
	"the scheduled daily budget rollup is invoked without a date at {word}",
	async function (this: ChatticusWorld, invokedAt: string) {
		await invokeScheduledRollup(this, undefined, invokedAt);
	},
);

When(
	"the scheduled daily budget rollup is invoked with date {string} at {word}",
	async function (this: ChatticusWorld, date: string, invokedAt: string) {
		await invokeScheduledRollup(this, { date }, invokedAt);
	},
);

Then("the scheduled daily budget rollup is rejected for its date", function (this: ChatticusWorld) {
	assert.ok(this.scheduledRollupRejection instanceof RollupDateInvalidError, "the invocation was not rejected for its date");
});

async function pausedUnderCeiling(world: ChatticusWorld, tenantId: string, day: string, ceiling: string): Promise<boolean> {
	const organization = await world.messagingStore().getOrganization(tenantId);
	assert.ok(organization !== null, `no organization ${tenantId}`);
	const pause = await organizationComputerWorkPaused(
		{ ...organization, monthlyAwsSpendCeilingUsd: Decimal.parse(ceiling) },
		world.store,
		world.budgetEnvironment,
		day,
	);
	return pause.paused;
}

Then(
	"computer work of tenant {string} is paused as of {word} under a ceiling of {word} USD",
	async function (this: ChatticusWorld, tenantId: string, day: string, ceiling: string) {
		assert.equal(await pausedUnderCeiling(this, tenantId, day, ceiling), true);
	},
);

Then(
	"computer work of tenant {string} is not paused as of {word} under a ceiling of {word} USD",
	async function (this: ChatticusWorld, tenantId: string, day: string, ceiling: string) {
		assert.equal(await pausedUnderCeiling(this, tenantId, day, ceiling), false);
	},
);
