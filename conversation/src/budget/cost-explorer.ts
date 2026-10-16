import {
	CostExplorerClient,
	GetCostAndUsageCommand,
	type GetCostAndUsageCommandInput,
	type GetCostAndUsageCommandOutput,
} from "@aws-sdk/client-cost-explorer";
import { AssumeRoleCommand, type STSClient } from "@aws-sdk/client-sts";
import { addDays } from "./calendar.ts";
import { Decimal } from "./decimal.ts";
import type { Organization } from "./models.ts";

const COST_EXPLORER_REGION = "us-east-1";

export class AccountSpendUnreadableError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "AccountSpendUnreadableError";
	}
}

export interface AccountDayResult {
	readonly pending: boolean;
	readonly totalUsd: Decimal | null;
}

/** Read a customer's whole-account AWS spend through its own account. */
export interface AccountSpendReader {
	dailyTotal(request: { organization: Organization; rollupDate: string }): Promise<AccountDayResult>;
}

/** The one Cost Explorer call the customer-account reader makes, so tests can substitute it. */
export interface CostExplorerApi {
	getCostAndUsage(input: GetCostAndUsageCommandInput): Promise<GetCostAndUsageCommandOutput>;
}

export function costExplorerApiFor(client: CostExplorerClient): CostExplorerApi {
	return {
		getCostAndUsage: (input) => client.send(new GetCostAndUsageCommand(input)),
	};
}

export function accountDayFromResponse(response: GetCostAndUsageCommandOutput): AccountDayResult {
	const results = response.ResultsByTime ?? [];
	if (results.length === 0) {
		return { pending: true, totalUsd: null };
	}
	const amount = results[0]?.Total?.UnblendedCost?.Amount;
	if (amount === undefined) {
		throw new AccountSpendUnreadableError("Cost Explorer returned no total cost for the day");
	}
	try {
		return { pending: false, totalUsd: Decimal.parse(amount) };
	} catch (error) {
		throw new AccountSpendUnreadableError("Cost Explorer returned no total cost for the day", { cause: error });
	}
}

function dayTimePeriod(rollupDate: string): { Start: string; End: string } {
	return { Start: rollupDate, End: addDays(rollupDate, 1) };
}

export interface AssumedCredentials {
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly sessionToken: string;
}

/** Assume the customer's role and read its whole-account daily spend. */
export class AwsAccountSpendReader implements AccountSpendReader {
	private readonly stsClient: STSClient;
	private readonly costExplorerFor: (credentials: AssumedCredentials) => CostExplorerApi;

	constructor(stsClient: STSClient, costExplorerFor: (credentials: AssumedCredentials) => CostExplorerApi) {
		this.stsClient = stsClient;
		this.costExplorerFor = costExplorerFor;
	}

	async dailyTotal(request: { organization: Organization; rollupDate: string }): Promise<AccountDayResult> {
		const { organization, rollupDate } = request;
		const roleArn = organization.awsCrossAccountRole;
		if (roleArn === null || roleArn === "") {
			throw new AccountSpendUnreadableError("no cross-account role is recorded");
		}
		let response: GetCostAndUsageCommandOutput;
		try {
			const assumed = await this.stsClient.send(
				new AssumeRoleCommand({
					RoleArn: roleArn,
					RoleSessionName: `chatticus-spend-${organization.tenantId}`.slice(0, 64),
					ExternalId: organization.awsExternalId ?? organization.tenantId,
				}),
			);
			const credentials = assumed.Credentials;
			if (
				credentials?.AccessKeyId === undefined ||
				credentials.SecretAccessKey === undefined ||
				credentials.SessionToken === undefined
			) {
				throw new Error("AssumeRole returned no credentials");
			}
			response = await this.costExplorerFor({
				accessKeyId: credentials.AccessKeyId,
				secretAccessKey: credentials.SecretAccessKey,
				sessionToken: credentials.SessionToken,
			}).getCostAndUsage({
				TimePeriod: dayTimePeriod(rollupDate),
				Granularity: "DAILY",
				Metrics: ["UnblendedCost"],
			});
		} catch (error) {
			throw new AccountSpendUnreadableError(`${error instanceof Error ? error.name : "Error"}: ${String(error)}`, {
				cause: error,
			});
		}
		return accountDayFromResponse(response);
	}
}

export function costExplorerApiForCredentials(credentials: AssumedCredentials): CostExplorerApi {
	return costExplorerApiFor(new CostExplorerClient({ region: COST_EXPLORER_REGION, credentials }));
}
