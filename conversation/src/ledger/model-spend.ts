import { Decimal } from "../budget/decimal.ts";
import { type CostReadDependencies, readCostRows, totalsOf } from "../domain/costs.ts";

/**
 * The monthly model spend ceiling, in US dollars, that applies to every organization in every environment when the
 * deployment does not set `CHATTICUS_MONTHLY_MODEL_SPEND_CEILING_USD`. It limits what the model gateway forwards to the
 * vendor, and is separate from the organization's monthly AWS spend ceiling.
 */
export const DEFAULT_MONTHLY_MODEL_SPEND_CEILING_USD = "25.00";

/** The environment variable that replaces {@link DEFAULT_MONTHLY_MODEL_SPEND_CEILING_USD} for a deployment. */
export const MONTHLY_MODEL_SPEND_CEILING_VARIABLE = "CHATTICUS_MONTHLY_MODEL_SPEND_CEILING_USD";

/**
 * Read the monthly model spend ceiling from a deployment's environment.
 *
 * @param environment The process environment.
 * @returns The configured ceiling, or the default when the variable is unset or empty.
 * @throws When the variable is set to something that is not a positive decimal amount, so a typo stops the deployment instead of removing the limit.
 */
export function monthlyModelSpendCeilingUsdFrom(environment: Record<string, string | undefined>): Decimal {
	const configured = environment[MONTHLY_MODEL_SPEND_CEILING_VARIABLE];
	const ceiling = Decimal.parse(configured === undefined || configured === "" ? DEFAULT_MONTHLY_MODEL_SPEND_CEILING_USD : configured);
	if (!ceiling.isPositive()) {
		throw new Error(`${MONTHLY_MODEL_SPEND_CEILING_VARIABLE} must be a positive USD amount.`);
	}
	return ceiling;
}

/** Where the model gateway learns how much an organization has spent on models this month. */
export interface ModelSpendReader {
	/**
	 * The organization's model spend so far in the calendar month (UTC) of `now`, in US dollars: the priced dollars of
	 * every row of the cost index for that month. A call with no price adds nothing, because the gateway refuses
	 * models the price book does not price.
	 */
	monthToDateUsd(tenantId: string, now: Date): Promise<Decimal>;
}

/** Reads the month's spend from the cost index in the messaging table: one consistent query of one partition. */
export class DynamoModelSpendReader implements ModelSpendReader {
	private readonly table: CostReadDependencies;

	constructor(table: CostReadDependencies) {
		this.table = table;
	}

	async monthToDateUsd(tenantId: string, now: Date): Promise<Decimal> {
		const rows = await readCostRows(this.table, tenantId, [now.toISOString().slice(0, 7)]);
		return Decimal.parse(totalsOf(rows).priced_cost_usd);
	}
}
