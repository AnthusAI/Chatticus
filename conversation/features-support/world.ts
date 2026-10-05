import { setWorldConstructor, World, type DataTable, type IWorldOptions } from "@cucumber/cucumber";
import type { MembershipCache } from "../src/auth/membership-cache.ts";
import type { CachedMembership, Principal } from "../src/auth/principal.ts";
import { DynamoBudgetStore } from "../src/budget/budget-store.ts";
import { Decimal } from "../src/budget/decimal.ts";
import type { Organization } from "../src/budget/models.ts";
import { FakeBudgetAlertsPublisher } from "./fakes/fake-budget-alerts.ts";
import { FakeAccountSpendReader, FakeCostExplorerReader } from "./fakes/fake-cost-explorer.ts";
import type { FakePrincipalDirectory } from "./fakes/fake-principal-directory.ts";
import type { CognitoTestKeys } from "./test-jwt.ts";
import { localDynamoClient, ScenarioMessagingTable } from "./messaging-table.ts";
import { ApiClient } from "./api.ts";
import { FakeClock } from "./clock.ts";
import { SequentialIdSource } from "./clock.ts";
import { QueueRecorder } from "./queues.ts";

let scenarioCounter = 0;

/**
 * Per-scenario state shared by every ported feature. Each slice adds its own
 * fields here (or composes a second world area) as its features move over.
 */
export class ChatticusWorld extends World {
	readonly messagingTable: ScenarioMessagingTable;
	readonly store: DynamoBudgetStore;

	readonly now = new Date("2026-08-31T06:00:00Z");
	budgetEnvironment = "development";
	monthlyLimitUsd = Decimal.parse("100");
	readonly costExplorer = new FakeCostExplorerReader();
	readonly accountSpend = new FakeAccountSpendReader();
	readonly budgetAlerts = new FakeBudgetAlertsPublisher();
	customerOrganization: Organization | null = null;

	cognitoTestKeys: CognitoTestKeys | null = null;
	principalDirectory: FakePrincipalDirectory | null = null;
	membershipCache: MembershipCache<CachedMembership> | null = null;
	resolverTenantId = "";
	resolvedPrincipal: Principal | null = null;
	resolverError: Error | null = null;
	browserRouteStatus: number | null = null;

	readonly tenantId: string;
	readonly clock: FakeClock;
	readonly ids: SequentialIdSource;
	readonly queues: QueueRecorder;
	api: ApiClient | null = null;
	scenarioStartTime: number;

	botsById: Map<string, { botId: string; name: string; tenantId: string }> | null = null;
	botsByName: Map<string, { botId: string; name: string; tenantId: string }> | null = null;
	lastHttpResponse: Response | null = null;
	lastChannel: { channelId: string; tenantId: string } | null = null;
	lastTurnId: string | null = null;
	messageError: Error | Response | null = null;
	dataTable: DataTable | null = null;
	environment: string = "local";

	snapshotTmpdir: string | null = null;
	snapshotStore: unknown = null;
	computerHosts: Record<string, unknown> = {};
	lastManifest: unknown = null;

	constructor(options: IWorldOptions) {
		super(options);
		const counter = ++scenarioCounter;
		const random = Math.random().toString(36).substring(2, 8);
		this.tenantId = `t-${counter}-${random}`;
		this.clock = new FakeClock();
		this.ids = new SequentialIdSource();
		this.queues = new QueueRecorder(this.clock);
		this.scenarioStartTime = Date.now();

		this.messagingTable = new ScenarioMessagingTable(localDynamoClient());
		this.store = new DynamoBudgetStore(this.messagingTable.client, this.messagingTable.tableName);
	}
}

setWorldConstructor(ChatticusWorld);
