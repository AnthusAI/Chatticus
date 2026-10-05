import { setWorldConstructor, World, type DataTable, type IWorldOptions } from "@cucumber/cucumber";
import type { MembershipCache } from "../src/auth/membership-cache.ts";
import type { CachedMembership, Principal } from "../src/auth/principal.ts";
import { DynamoBudgetStore } from "../src/budget/budget-store.ts";
import { Decimal } from "../src/budget/decimal.ts";
import type { Organization as BudgetOrganization } from "../src/budget/models.ts";
import type { Identity, Organization, Invitation } from "../src/domain/organizations.ts";
import type { OvernightGatedResult } from "../src/policy/overnight.ts";
import type { ApprovedOperation, BoundExecutionResult, OperationProposal } from "../src/policy/approval-binding.ts";
import type { ConnectionProposalResult, ConnectionProposalRoute } from "../src/policy/connections.ts";
import type { PolicyControl } from "../src/policy/policy-control.ts";
import type { MessagingStore } from "../src/store/messaging-store.ts";
import { InMemoryMessagingStore } from "./in-memory-messaging-store.ts";
import { FakeBudgetAlertsPublisher } from "./fakes/fake-budget-alerts.ts";
import { FakeAccountSpendReader, FakeCostExplorerReader } from "./fakes/fake-cost-explorer.ts";
import type { FakePrincipalDirectory } from "./fakes/fake-principal-directory.ts";
import type { CognitoTestKeys } from "./test-jwt.ts";
import { localDynamoClient, ScenarioMessagingTable } from "./messaging-table.ts";
import { ApiClient, type RecordedResponse } from "./api.ts";
import type { StartedAppServer } from "./http-server.ts";
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
	customerOrganization: BudgetOrganization | null = null;

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
	meResponse: RecordedResponse | null = null;
	createOrganizationResponse: RecordedResponse | null = null;
	inviteResponse: RecordedResponse | null = null;
	createdOrganizationName: string | null = null;
	membersCliListing: Organization[] | null = null;
	httpServer: StartedAppServer | null = null;
	webApiBase: string | null = null;
	webIdToken: string | null = null;
	membershipUiHarness: Record<string, any> | null = null;
	lastChannel: { channelId: string; tenantId: string } | null = null;
	lastTurnId: string | null = null;
	testOwnerEmails: Map<string, string> = new Map();
	directChannelPayloads: Array<Record<string, any>> = [];
	namedChannelPayload: Record<string, any> | null = null;
	createBotResponse: RecordedResponse | null = null;
	messageError: Error | Response | null = null;
	dataTable: DataTable | null = null;
	environment: string = "local";

	// Organization and membership fields
	orgsByName: Map<string, Organization> | null = null;
	identitiesByEmail: Map<string, Identity> | null = null;
	currentIdentity: Identity | null = null;
	lastInvitation: Invitation | null = null;
	lastError: Error | null = null;
	inMemoryStore: MessagingStore | null = null;
	snapshotTmpdir: string | null = null;
	snapshotStore: unknown = null;
	computerHosts: Record<string, unknown> = {};
	lastManifest: unknown = null;

	// Policy kernel fields
	capabilityPolicy: unknown = null;
	activeBrowserContext: unknown = null;
	privilegedBrowserContext: unknown = null;
	lastCapabilityRequest: unknown = null;
	pageInjection: string | null = null;
	injectedRequest: unknown = null;
	lastDecision: string | null = null;
	lastOvernight: OvernightGatedResult | null = null;
	gatedReadError: Error | null = null;
	gatedReadResult: unknown = null;
	lastBinding: string | null = null;
	policyTenantId: string | null = null;
	policyTurnId: string | null = null;
	reviewedExclusion: string | null = null;
	recordedCompletionEvidence: string | null = null;
	pageContent: string | null = null;

	// Approvals, rules, connections and overnight gating
	policyControl: PolicyControl | null = null;
	watcherPresent: boolean | null = null;
	sharedChannelsByName: Map<string, { channelId: string; tenantId: string; name: string }> = new Map();
	lastOperationProposal: OperationProposal | null = null;
	lastApprovedOperation: ApprovedOperation | null = null;
	lastBoundExecution: BoundExecutionResult | null = null;
	lastConnectionResult: ConnectionProposalResult | null = null;
	lastConnectionRoute: ConnectionProposalRoute | null = null;

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

	createInMemoryStore(): MessagingStore {
		return new InMemoryMessagingStore();
	}

	/** The scenario's single messaging store, shared by the HTTP app and direct domain steps. */
	messagingStore(): MessagingStore {
		if (this.inMemoryStore === null) {
			this.inMemoryStore = this.createInMemoryStore();
		}
		return this.inMemoryStore;
	}
}

setWorldConstructor(ChatticusWorld);
