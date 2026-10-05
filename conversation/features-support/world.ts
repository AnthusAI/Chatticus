import { setWorldConstructor, World, type IWorldOptions } from "@cucumber/cucumber";
import { DynamoBudgetStore } from "../src/budget/budget-store.ts";
import { Decimal } from "../src/budget/decimal.ts";
import type { Organization } from "../src/budget/models.ts";
import { FakeBudgetAlertsPublisher } from "./fakes/fake-budget-alerts.ts";
import { FakeAccountSpendReader, FakeCostExplorerReader } from "./fakes/fake-cost-explorer.ts";
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

	readonly tenantId: string;
	readonly clock: FakeClock;
	readonly ids: SequentialIdSource;
	readonly queues: QueueRecorder;
	api: ApiClient | null = null;
	scenarioStartTime: number;

	constructor(options: IWorldOptions) {
		super(options);
		const counter = ++scenarioCounter;
		const random = Math.random().toString(36).substring(2, 8);
		this.tenantId = `t-${counter}-${random}`;
		this.clock = new FakeClock();
		this.ids = new SequentialIdSource();
		this.queues = new QueueRecorder();
		this.scenarioStartTime = Date.now();

		this.messagingTable = new ScenarioMessagingTable(localDynamoClient());
		this.store = new DynamoBudgetStore(this.messagingTable.client, this.messagingTable.tableName);
	}
}

setWorldConstructor(ChatticusWorld);
