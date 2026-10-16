import type { AccountDayResult, AccountSpendReader } from "../../src/budget/cost-explorer.ts";
import { AccountSpendUnreadableError } from "../../src/budget/cost-explorer.ts";
import { Decimal } from "../../src/budget/decimal.ts";
import type { Organization } from "../../src/budget/models.ts";

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

	restoreAccount(accountId: string): void {
		this.unreadableAccounts.delete(accountId);
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
