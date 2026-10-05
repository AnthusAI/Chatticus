import { setWorldConstructor, World, type DataTable, type IWorldOptions } from "@cucumber/cucumber";
import type { MembershipCache } from "../src/auth/membership-cache.ts";
import type { CachedMembership, Principal } from "../src/auth/principal.ts";
import { DynamoBudgetStore } from "../src/budget/budget-store.ts";
import { Decimal } from "../src/budget/decimal.ts";
import type { Organization as BudgetOrganization } from "../src/budget/models.ts";
import type { Identity, Organization, Invitation } from "../src/domain/organizations.ts";
import type { MessagingStore } from "../src/store/messaging-store.ts";
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
	lastChannel: { channelId: string; tenantId: string } | null = null;
	lastTurnId: string | null = null;
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
		const identities = new Map<string, Identity>();
		const organizations = new Map<string, Organization>();
		const memberships = new Map<string, Map<string, any>>();
		const invitations = new Map<string, Invitation>();

		return {
			async getIdentityByEmail(email: string): Promise<Identity | null> {
				return identities.get(email) ?? null;
			},
			async putIdentity(identity: Identity): Promise<void> {
				identities.set(identity.email, identity);
			},
			async getOrganization(tenantId: string): Promise<Organization | null> {
				return organizations.get(tenantId) ?? null;
			},
			async putOrganization(organization: Organization): Promise<void> {
				organizations.set(organization.tenantId, organization);
			},
			async getMembership(tenantId: string, userId: string): Promise<any> {
				const tenantMemberships = memberships.get(tenantId);
				return tenantMemberships?.get(userId) ?? null;
			},
			async putMembership(membership: any): Promise<void> {
				if (!memberships.has(membership.tenantId)) {
					memberships.set(membership.tenantId, new Map());
				}
				memberships.get(membership.tenantId)!.set(membership.userId, membership);
			},
			async listMemberships(tenantId: string): Promise<any[]> {
				const tenantMemberships = memberships.get(tenantId);
				return tenantMemberships ? Array.from(tenantMemberships.values()) : [];
			},
			async getInvitation(invitationId: string): Promise<Invitation | null> {
				return invitations.get(invitationId) ?? null;
			},
			async putInvitation(invitation: Invitation): Promise<void> {
				invitations.set(invitation.invitationId, invitation);
			},
			async listOrganizationsForUser(userId: string): Promise<Organization[]> {
				const result: Organization[] = [];
				for (const org of organizations.values()) {
					const membership = memberships.get(org.tenantId)?.get(userId);
					if (membership) {
						result.push(org);
					}
				}
				return result;
			},
		};
	}
}

setWorldConstructor(ChatticusWorld);
