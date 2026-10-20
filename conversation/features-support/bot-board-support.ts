import assert from "node:assert/strict";
import { BotBoardService, type BoardActor } from "../src/board/bot-board-service.ts";
import { createSigV4SignedFetch } from "../src/board/kanbus-board-client.ts";
import { OrganizationsKernelImpl } from "../src/domain/organizations.ts";
import type { MemberRole } from "../src/domain/organizations.ts";
import { ensureTestOrganization } from "./org-user-client.ts";
import { FakeKanbusBoardService } from "./fakes/fake-kanbus-board-service.ts";
import type { ChatticusWorld } from "./world.ts";

/** The access key of the role the front door runs as in scenarios: it provisions and delegates the actor. */
export const FRONT_DOOR_ACCESS_KEY_ID = "scenario-front-door-key";
/** The access key of the role the turn executor runs as in scenarios: it delegates the actor and cannot provision. */
export const EXECUTOR_ACCESS_KEY_ID = "scenario-executor-key";
export const SCENARIO_SECRET = "scenario-secret-value";
const SCENARIO_REGION = "us-east-1";
const SCENARIO_BASE_URL = "https://kanbus.scenario.invalid";

/** What a scenario remembers about the cards it made, so a step can say "the card" the way the feature does. */
export type RememberedCard = { readonly botName: string; readonly title: string; readonly id: string };

/** One call of the board tool in a real turn, as the model saw it. */
export type BoardToolCallRecord = {
	readonly text: string;
	readonly parsed: Record<string, any>;
	readonly isError: boolean;
	readonly turnId: string;
	readonly callId: string;
	readonly tenantId: string;
	readonly botId: string;
	readonly events: Array<Record<string, any>>;
	readonly requestCountBefore: number;
};

/** Everything the board features keep for the length of one scenario. */
export type BoardScenario = {
	enabled: boolean;
	defaultTenantId: string | null;
	readonly fake: FakeKanbusBoardService;
	readonly frontDoor: BotBoardService;
	readonly executor: BotBoardService;
	readonly cardsByKey: Map<string, RememberedCard>;
	readonly revisionsByCard: Map<string, string[]>;
	currentCard: RememberedCard | null;
	lastToolCall: BoardToolCallRecord | null;
	lastResult: { ok: boolean; failure?: { kind: string; message: string; code?: string; currentCard?: any }; value?: any } | null;
	receivedMessage: string | null;
	computerAtStop: unknown;
	pendingOperationKey: string | null;
	writesBeforeRepeat: number | null;
	rememberedCardId: string | null;
};

const scenarios = new WeakMap<ChatticusWorld, BoardScenario>();

/** The board features' state for this scenario, created on first use. */
export function boardScenarioOf(world: ChatticusWorld): BoardScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		const fake = new FakeKanbusBoardService(() => world.clock.now());
		fake.registerPrincipal(FRONT_DOOR_ACCESS_KEY_ID, { secretAccessKey: SCENARIO_SECRET, provision: true, delegateActor: true, tenants: "*" });
		fake.registerPrincipal(EXECUTOR_ACCESS_KEY_ID, { secretAccessKey: SCENARIO_SECRET, provision: false, delegateActor: true, tenants: "*" });
		const memberships = { getMembership: (tenantId: string, userId: string) => world.messagingStore().getMembership(tenantId, userId) };
		const serviceFor = (accessKeyId: string): BotBoardService =>
			new BotBoardService({
				baseUrl: SCENARIO_BASE_URL,
				fetch: createSigV4SignedFetch({
					credentials: async () => ({ accessKeyId, secretAccessKey: SCENARIO_SECRET }),
					region: SCENARIO_REGION,
					fetch: fake.fetch,
				}),
				memberships,
			});
		scenario = {
			enabled: false,
			defaultTenantId: null,
			fake,
			frontDoor: serviceFor(FRONT_DOOR_ACCESS_KEY_ID),
			executor: serviceFor(EXECUTOR_ACCESS_KEY_ID),
			cardsByKey: new Map(),
			revisionsByCard: new Map(),
			currentCard: null,
			lastToolCall: null,
			lastResult: null,
			receivedMessage: null,
			computerAtStop: null,
			pendingOperationKey: null,
			writesBeforeRepeat: null,
			rememberedCardId: null,
		};
		scenarios.set(world, scenario);
	}
	return scenario;
}

/** The front door's board service when the scenario configured one, for the front door to provision with. */
export function boardProvisionerFor(world: ChatticusWorld): BotBoardService | undefined {
	const scenario = scenarios.get(world);
	return scenario?.enabled === true ? scenario.frontDoor : undefined;
}

/** The turn executor's board service when the scenario configured one. */
export function executorBoardServiceFor(world: ChatticusWorld): BotBoardService | undefined {
	const scenario = scenarios.get(world);
	return scenario?.enabled === true ? scenario.executor : undefined;
}

/** The tenant id the scenarios give an organization by its name. */
export function tenantIdOfOrganization(name: string): string {
	return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** The bot a scenario created by its name. */
export function botNamed(world: ChatticusWorld, name: string): { botId: string; name: string; tenantId: string } {
	const bot = world.botsByName?.get(name);
	assert.ok(bot, `Bot ${name} not found`);
	return bot;
}

const kernel = new OrganizationsKernelImpl();

/** Make `userId` a member of the organization with `role`, seeding the organization when it does not exist yet. */
export async function ensureOrganizationUser(world: ChatticusWorld, tenantId: string, userId: string, role: MemberRole): Promise<void> {
	await ensureTestOrganization(world, tenantId);
	const store = world.messagingStore();
	const email = `${userId}@${tenantId}.test`;
	if ((await store.getIdentityByEmail(email)) === null) {
		await store.putIdentity({ userId, email, createdAt: world.clock.now() });
	}
	const existing = await store.getMembership(tenantId, userId);
	if (existing === null) {
		await store.putMembership({ tenantId, userId, role, joinedAt: world.clock.now() });
	} else if (existing.role !== role) {
		await kernel.adminSetMemberRole(tenantId, userId, role, { store });
	}
}

/** The actor for a person named in a feature: the user id is the person's first name. */
export function userActor(userId: string): BoardActor {
	return { kind: "user", userId };
}

/** The actor for a bot named in a feature. */
export function botActor(world: ChatticusWorld, botName: string): BoardActor {
	return { kind: "bot", botId: botNamed(world, botName).botId };
}

/** Remember a card the scenario made or read and the revision it was last seen at. */
export function rememberCard(scenario: BoardScenario, botName: string, title: string, id: string, revision: string): RememberedCard {
	const card = { botName, title, id };
	scenario.cardsByKey.set(`${botName}/${title}`, card);
	scenario.currentCard = card;
	noteRevision(scenario, id, revision);
	return card;
}

/** Note a revision the scenario saw for a card; the same revision is not noted twice. */
export function noteRevision(scenario: BoardScenario, id: string, revision: string): void {
	const seen = scenario.revisionsByCard.get(id) ?? [];
	if (seen[seen.length - 1] !== revision) seen.push(revision);
	scenario.revisionsByCard.set(id, seen);
}

/** The card a feature names by bot and title. */
export function cardNamed(scenario: BoardScenario, botName: string, title: string): RememberedCard {
	const card = scenario.cardsByKey.get(`${botName}/${title}`);
	assert.ok(card, `The scenario has no card ${title} of ${botName}`);
	return card;
}

/** The card a step means by "the card". */
export function currentCardOf(scenario: BoardScenario): RememberedCard {
	assert.ok(scenario.currentCard, "The scenario has no current card yet");
	return scenario.currentCard;
}

/** The card as the fake board service stores it. */
export function storedCard(world: ChatticusWorld, card: RememberedCard): { issue: Record<string, any>; revision: string; writes: number } {
	const bot = botNamed(world, card.botName);
	const stored = boardScenarioOf(world).fake.peek(bot.tenantId, bot.botId, card.id);
	assert.ok(stored, `The board store has no card ${card.title} of ${card.botName}`);
	return stored;
}

/** The actor string the store records for a person or bot. */
export function actorString(world: ChatticusWorld, who: { bot?: string; user?: string }): string {
	if (who.bot !== undefined) return `chatticus:bot:${botNamed(world, who.bot).botId}`;
	return `chatticus:user:${who.user}`;
}
