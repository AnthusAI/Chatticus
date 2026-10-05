import {
	CostExplorerClient,
	GetCostAndUsageCommand,
	type GetCostAndUsageCommandInput,
	type GetCostAndUsageCommandOutput,
	ListCostAllocationTagsCommand,
	type ListCostAllocationTagsCommandInput,
	type ListCostAllocationTagsCommandOutput,
} from "@aws-sdk/client-cost-explorer";
import { AssumeRoleCommand, type STSClient } from "@aws-sdk/client-sts";
import { addDays } from "./calendar.ts";
import { Decimal } from "./decimal.ts";
import type { Organization } from "./models.ts";

export const TENANT_TAG_KEY = "chatticus:tenant";
export const ENVIRONMENT_TAG_KEY = "chatticus:environment";
const COST_EXPLORER_REGION = "us-east-1";

export interface CostExplorerDayResult {
	readonly pending: boolean;
	readonly costsByTenant: ReadonlyMap<string, Decimal>;
	readonly tenantTagActive: boolean;
}

/** Read tenant-attributed AWS spend for one calendar day. */
export interface CostExplorerReader {
	dailyCostsByTenant(request: { environment: string; rollupDate: string }): Promise<CostExplorerDayResult>;
}

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

/** The two Cost Explorer calls the readers make, so tests can substitute them. */
export interface CostExplorerApi {
	getCostAndUsage(input: GetCostAndUsageCommandInput): Promise<GetCostAndUsageCommandOutput>;
	listCostAllocationTags(input: ListCostAllocationTagsCommandInput): Promise<ListCostAllocationTagsCommandOutput>;
}

export function costExplorerApiFor(client: CostExplorerClient): CostExplorerApi {
	return {
		getCostAndUsage: (input) => client.send(new GetCostAndUsageCommand(input)),
		listCostAllocationTags: (input) => client.send(new ListCostAllocationTagsCommand(input)),
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

/** Live Cost Explorer reader for the Lambda run. */
export class AwsCostExplorerReader implements CostExplorerReader {
	private readonly api: CostExplorerApi;

	constructor(api: CostExplorerApi) {
		this.api = api;
	}

	async dailyCostsByTenant(request: { environment: string; rollupDate: string }): Promise<CostExplorerDayResult> {
		const response = await this.api.getCostAndUsage({
			TimePeriod: dayTimePeriod(request.rollupDate),
			Granularity: "DAILY",
			Metrics: ["UnblendedCost"],
			GroupBy: [{ Type: "TAG", Key: TENANT_TAG_KEY }],
			Filter: { Tags: { Key: ENVIRONMENT_TAG_KEY, Values: [request.environment] } },
		});
		const results = response.ResultsByTime ?? [];
		if (results.length === 0) {
			return { pending: true, costsByTenant: new Map(), tenantTagActive: true };
		}
		const tenantTagActive = await this.tenantTagActive();
		const costsByTenant = new Map<string, Decimal>();
		const prefix = `${TENANT_TAG_KEY}$`;
		for (const group of results[0]?.Groups ?? []) {
			const tenantKey = group.Keys?.[0];
			if (tenantKey === undefined || !tenantKey.startsWith(prefix)) {
				continue;
			}
			const amount = group.Metrics?.UnblendedCost?.Amount;
			if (amount === undefined) {
				throw new Error("Cost Explorer group has no UnblendedCost amount.");
			}
			costsByTenant.set(tenantKey.slice(prefix.length), Decimal.parse(amount));
		}
		return { pending: false, costsByTenant, tenantTagActive };
	}

	/**
	 * Report whether Cost Explorer can group by the tenant tag at all. A tag
	 * that is not an active cost allocation tag never appears in results, so an
	 * absent tenant is unknowable rather than zero. A failed lookup counts as not
	 * active: the meter must not look fine unverified.
	 */
	private async tenantTagActive(): Promise<boolean> {
		try {
			const response = await this.api.listCostAllocationTags({ Status: "Active", TagKeys: [TENANT_TAG_KEY] });
			return (response.CostAllocationTags ?? []).length > 0;
		} catch (error) {
			console.warn(`tenant_tag_lookup_failed reason=${String(error)}`);
			return false;
		}
	}
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

export function hostedCostExplorerApi(): CostExplorerApi {
	return costExplorerApiFor(new CostExplorerClient({ region: COST_EXPLORER_REGION }));
}
