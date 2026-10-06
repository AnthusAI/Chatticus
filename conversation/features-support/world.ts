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
import { DynamoMessagingStore } from "../src/store/dynamo-messaging-store.ts";
import { DynamoTurnControlStore } from "../src/store/turn-store.ts";
import type { TurnDependencies } from "../src/domain/turns.ts";
import { FaultPlan } from "../src/turn/fault-plan.ts";
import { ScriptedUserUnderstanding } from "./fakes/scripted-understanding.ts";
import { FakeBudgetAlertsPublisher } from "./fakes/fake-budget-alerts.ts";
import { FakeAccountSpendReader, FakeCostExplorerReader } from "./fakes/fake-cost-explorer.ts";
import type { CognitoTestKeys } from "./test-jwt.ts";
import { localDynamoClient, ScenarioMessagingTable } from "./messaging-table.ts";
import { ApiClient, type RecordedResponse } from "./api.ts";
import type { StartedAppServer } from "./http-server.ts";
import type { Hono } from "hono";
import { OpenStreamCounter } from "../src/http/routes/turn-stream.ts";
import { FakeClock } from "./clock.ts";
import { ScenarioStreamClock } from "./stream-clock.ts";
import { SequentialIdSource } from "./clock.ts";
import { QueueRecorder } from "./queues.ts";
import type { MembersCliProcessResult } from "./members-cli-process.ts";
import type { ScenarioPiStorage } from "./pi-storage.ts";
import type { SpendCeilingScenarioState } from "./spend-ceiling.ts";
import type { OperatorScenarioState } from "./steps/operator.steps.ts";
import type { IntegrationTestScenarioState } from "./steps/integration-test-auth.steps.ts";

let scenarioCounter = 0;

/**
 * Per-scenario state shared by every ported feature. Each slice adds its own
 * fields here (or composes a second world area) as its features move over.
 */
export class ChatticusWorld extends World {
	readonly messagingTable: ScenarioMessagingTable;
	piStorage: ScenarioPiStorage | null = null;
	readonly store: DynamoBudgetStore;

	readonly now = new Date("2026-08-31T06:00:00Z");
	budgetEnvironment = "development";
	monthlyLimitUsd = Decimal.parse("100");
	readonly costExplorer = new FakeCostExplorerReader();
	readonly accountSpend = new FakeAccountSpendReader();
	readonly budgetAlerts = new FakeBudgetAlertsPublisher();
	customerOrganization: BudgetOrganization | null = null;

	cognitoTestKeys: CognitoTestKeys | null = null;
	membershipCache: MembershipCache<CachedMembership> | null = null;
	resolverTenantId = "";
	resolvedPrincipal: Principal | null = null;
	resolverError: Error | null = null;
	browserRouteStatus: number | null = null;

	readonly tenantId: string;
	readonly clock: FakeClock;
	readonly ids: SequentialIdSource;
	readonly queues: QueueRecorder;
	/** Crash injection shared by the front door, the executor and the probe handler; disarmed unless a scenario arms it. */
	readonly faultPlan = new FaultPlan();
	/** Each time a run job's queue visibility was extended, as the queue would record it. */
	readonly runVisibilityExtensions: Array<{ tenantId: string; turnId: string }> = [];
	api: ApiClient | null = null;
	/** The understand-the-user step the voice route runs, scripted per scenario. */
	readonly scriptedUnderstanding = new ScriptedUserUnderstanding();
	voiceLineResponse: RecordedResponse | null = null;
	voiceLineResponses: RecordedResponse[] = [];
	messageCountBeforeVoiceLine = 0;
	app: Hono | null = null;
	listedTurnEvents: Array<Record<string, any>> = [];
	streamRefusal: Response | null = null;
	readonly streamClock = new ScenarioStreamClock();
	readonly openStreams = new OpenStreamCounter();
	scenarioStartTime: number;

	botsById: Map<string, { botId: string; name: string; tenantId: string }> | null = null;
	botsByName: Map<string, { botId: string; name: string; tenantId: string }> | null = null;
	lastHttpResponse: Response | null = null;
	meResponse: RecordedResponse | null = null;
	createOrganizationResponse: RecordedResponse | null = null;
	inviteResponse: RecordedResponse | null = null;
	createdOrganizationName: string | null = null;
	membersCliResult: MembersCliProcessResult | null = null;
	seededBotId: string | null = null;
	httpServer: StartedAppServer | null = null;
	webApiBase: string | null = null;
	webIdToken: string | null = null;
	membershipUiHarness: Record<string, any> | null = null;
	lastChannel: { channelId: string; tenantId: string } | null = null;
	lastTurnId: string | null = null;
	createdBotIds: string[] = [];
	botCreatorUserIds: Map<string, string> = new Map();
	rememberedTurnIds: Map<string, string> = new Map();
	turnAttempts: Map<string, string> = new Map();
	deliveredTurnJobs: Array<{ tenantId: string; turnId: string }> = [];
	turnOperationErrors: Error[] = [];
	latestTurnResponse: RecordedResponse | null = null;
	testOwnerEmails: Map<string, string> = new Map();
	directChannelPayloads: Array<Record<string, any>> = [];
	namedChannelPayload: Record<string, any> | null = null;
	createBotResponse: RecordedResponse | null = null;
	messageError: Error | Response | null = null;
	postResponses: RecordedResponse[] = [];
	listedMessages: Array<Record<string, any>> | null = null;
	openedChannelIds: string[] = [];
	idempotentChannelIds: string[] = [];
	otherTenantId: string | null = null;
	accessDenial: string | null = null;
	dataTable: DataTable | null = null;
	environment: string = "local";

	// Organization and membership fields
	orgsByName: Map<string, Organization> | null = null;
	identitiesByEmail: Map<string, Identity> | null = null;
	currentIdentity: Identity | null = null;
	lastInvitation: Invitation | null = null;
	lastError: Error | null = null;
	scenarioMessagingStore: MessagingStore | null = null;
	snapshotTmpdir: string | null = null;
	snapshotStore: unknown = null;
	computerHosts: Record<string, unknown> = {};
	lastManifest: unknown = null;

	// Operator and integration-test auth
	operatorScenario: OperatorScenarioState | null = null;
	integrationTestScenario: IntegrationTestScenarioState | null = null;
	spendCeilingScenario: SpendCeilingScenarioState | null = null;
	workerTokens: Map<string, string> = new Map();

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

	createMessagingStore(): MessagingStore {
		return new DynamoMessagingStore(this.messagingTable.client, this.messagingTable.tableName);
	}

	/** The turn control record store over the scenario's Messaging table. */
	turnControlStore(): DynamoTurnControlStore {
		return new DynamoTurnControlStore(this.messagingTable.client, this.messagingTable.tableName);
	}

	/** What the turn functions need, over the scenario's table, clock and identifiers. */
	turnDependencies(): TurnDependencies {
		return { store: this.turnControlStore(), clock: this.clock, ids: this.ids };
	}

	/** The scenario's single messaging store, shared by the HTTP app and direct domain steps. */
	messagingStore(): MessagingStore {
		if (this.scenarioMessagingStore === null) {
			this.scenarioMessagingStore = this.createMessagingStore();
		}
		return this.scenarioMessagingStore;
	}
}

setWorldConstructor(ChatticusWorld);
