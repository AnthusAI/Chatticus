import type {
	AccountDayResult,
	AccountSpendReader,
	CostExplorerDayResult,
	CostExplorerReader,
} from "../../src/budget/cost-explorer.ts";
import { AccountSpendUnreadableError } from "../../src/budget/cost-explorer.ts";
import { Decimal } from "../../src/budget/decimal.ts";
import type { Organization } from "../../src/budget/models.ts";

/** In-memory Cost Explorer for the cucumber world. */
export class FakeCostExplorerReader implements CostExplorerReader {
	private readonly pendingDays = new Set<string>();
	private readonly costs = new Map<string, Decimal>();
	private tenantTagActive = true;

	setTenantTagActive(active: boolean): void {
		this.tenantTagActive = active;
	}

	setDayPending(environment: string, rollupDate: string): void {
		this.pendingDays.add(`${environment}|${rollupDate}`);
	}

	setDailyCost(environment: string, tenantId: string, rollupDate: string, amount: Decimal): void {
		this.pendingDays.delete(`${environment}|${rollupDate}`);
		this.costs.set(`${environment}|${tenantId}|${rollupDate}`, amount);
	}

	markDayAvailable(environment: string, rollupDate: string): void {
		this.pendingDays.delete(`${environment}|${rollupDate}`);
	}

	dailyCostsByTenant(request: { environment: string; rollupDate: string }): Promise<CostExplorerDayResult> {
		const { environment, rollupDate } = request;
		if (this.pendingDays.has(`${environment}|${rollupDate}`)) {
			return Promise.resolve({ pending: true, costsByTenant: new Map(), tenantTagActive: true });
		}
		const costsByTenant = new Map<string, Decimal>();
		for (const [key, amount] of this.costs) {
			const [costEnvironment, tenantId, day] = key.split("|");
			if (costEnvironment === environment && day === rollupDate && tenantId !== undefined) {
				costsByTenant.set(tenantId, amount);
			}
		}
		return Promise.resolve({ pending: false, costsByTenant, tenantTagActive: this.tenantTagActive });
	}
}

/** In-memory customer-account spend for the cucumber world. */
export class FakeAccountSpendReader implements AccountSpendReader {
	private readonly totals = new Map<string, Decimal>();
	private readonly pendingDays = new Set<string>();
	private readonly unreadableAccounts = new Set<string>();

	setTotal(accountId: string, rollupDate: string, amount: Decimal): void {
		this.totals.set(`${accountId}|${rollupDate}`, amount);
	}

	setDayPending(accountId: string, rollupDate: string): void {
		this.pendingDays.add(`${accountId}|${rollupDate}`);
	}

	failAccount(accountId: string): void {
		this.unreadableAccounts.add(accountId);
	}

	dailyTotal(request: { organization: Organization; rollupDate: string }): Promise<AccountDayResult> {
		const accountId = request.organization.awsAccountId ?? "";
		const key = `${accountId}|${request.rollupDate}`;
		if (this.unreadableAccounts.has(accountId)) {
			return Promise.reject(new AccountSpendUnreadableError(`account ${accountId} is unreadable`));
		}
		if (this.pendingDays.has(key)) {
			return Promise.resolve({ pending: true, totalUsd: null });
		}
		return Promise.resolve({ pending: false, totalUsd: this.totals.get(key) ?? Decimal.zero() });
	}
}
