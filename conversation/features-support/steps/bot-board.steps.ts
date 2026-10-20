import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { createBot } from "../../src/domain/bots.ts";
import { setComputerStopped } from "../../src/domain/computers.ts";
import { recordResponse } from "../api.ts";
import {
	botActor,
	boardScenarioOf,
	boardProvisionerFor,
	botNamed,
	currentCardOf,
	ensureOrganizationUser,
	noteRevision,
	rememberCard,
	tenantIdOfOrganization,
	type BoardScenario,
} from "../bot-board-support.ts";
import { wireFrontDoor } from "../front-door.ts";
import { ensureTestOrganization, memberPost } from "../org-user-client.ts";
import type { ChatticusWorld } from "../world.ts";

const CREATING_USER = "ryan";
const storeFailures = new WeakSet<ChatticusWorld>();
const creationAnswers = new WeakMap<ChatticusWorld, Awaited<ReturnType<typeof recordResponse>>>();

/** Create a bot with the scenario's board provisioning, remember it, and make its organization the scenario's default. */
export async function createBotWithBoard(world: ChatticusWorld, tenantId: string, name: string): Promise<{ botId: string; name: string; tenantId: string }> {
	await ensureTestOrganization(world, tenantId);
	const bot = await createBot(
		tenantId,
		name,
		{ creatorUserId: CREATING_USER },
		{ store: world.messagingStore(), ids: world.ids, boards: boardProvisionerFor(world) ?? null },
	);
	world.botsById ??= new Map();
	world.botsByName ??= new Map();
	world.botsById.set(bot.botId, bot);
	world.botsByName.set(name, bot);
	world.botCreatorUserIds.set(name, CREATING_USER);
	boardScenarioOf(world).defaultTenantId = tenantId;
	return bot;
}

/** Give a bot a card the way the bot does, remember it, and return its id. */
export async function giveBotCard(
	world: ChatticusWorld,
	botName: string,
	title: string,
	options: { type?: string; parent?: string; status?: string } = {},
): Promise<string> {
	const scenario = boardScenarioOf(world);
	const bot = botNamed(world, botName);
	const address = { organizationId: bot.tenantId, botId: bot.botId };
	const actor = botActor(world, botName);
	const created = await scenario.executor.createCard(
		address,
		actor,
		{ title, ...(options.type === undefined ? {} : { type: options.type }), ...(options.parent === undefined ? {} : { parent: options.parent }) },
		{ operationKey: `given/${botName}/${title}` },
	);
	assert.ok(created.ok, `Giving ${botName} the card ${title} failed: ${JSON.stringify(created)}`);
	let revision = created.value.revision;
	const status = options.status;
	if (status !== undefined && status !== "open") {
		if (status === "closed") {
			const closed = await scenario.executor.closeCard(address, actor, created.value.issue.id, "closed by the scenario", { operationKey: `given-close/${botName}/${title}`, revision });
			assert.ok(closed.ok, JSON.stringify(closed));
			revision = closed.value.revision;
		} else {
			const moved = await scenario.executor.updateCard(address, actor, created.value.issue.id, { status }, { operationKey: `given-move/${botName}/${title}`, revision });
			assert.ok(moved.ok, JSON.stringify(moved));
			revision = moved.value.revision;
		}
	}
	rememberCard(scenario, botName, title, created.value.issue.id, created.value.revision);
	noteRevision(scenario, created.value.issue.id, revision);
	return created.value.issue.id;
}

Given("the Kanbus board service is configured for this environment", async function (this: ChatticusWorld) {
	boardScenarioOf(this).enabled = true;
	assert.ok(this.frontDoorOptions, "The scenario has no front door yet");
	await wireFrontDoor(this, this.frontDoorOptions);
});

Given("the organization {string} has the bot {string}", async function (this: ChatticusWorld, organization: string, name: string) {
	await createBotWithBoard(this, tenantIdOfOrganization(organization), name);
});

Given(
	"the organization {string} has the bot {string} with a card titled {string}",
	async function (this: ChatticusWorld, organization: string, name: string, title: string) {
		await createBotWithBoard(this, tenantIdOfOrganization(organization), name);
		await giveBotCard(this, name, title);
	},
);

Given(
	"the organization {string} has the owners {string} and {string} and the member {string}",
	async function (this: ChatticusWorld, organization: string, firstOwner: string, secondOwner: string, member: string) {
		const tenantId = tenantIdOfOrganization(organization);
		await ensureOrganizationUser(this, tenantId, firstOwner, "owner");
		await ensureOrganizationUser(this, tenantId, secondOwner, "owner");
		await ensureOrganizationUser(this, tenantId, member, "member");
	},
);

Given("the organization {string} has the owner {string}", async function (this: ChatticusWorld, organization: string, owner: string) {
	await ensureOrganizationUser(this, tenantIdOfOrganization(organization), owner, "owner");
});

Given("the bot {string} belongs to the organization {string}", async function (this: ChatticusWorld, name: string, organization: string) {
	await createBotWithBoard(this, tenantIdOfOrganization(organization), name);
});

Given("the bot {string} has an empty board", function (this: ChatticusWorld, name: string) {
	const bot = botNamed(this, name);
	const fake = boardScenarioOf(this).fake;
	assert.ok(fake.boards.get(`${bot.tenantId}/${bot.botId}`)?.configured, `The board of ${name} was never provisioned`);
	assert.deepEqual(fake.cardsOf(bot.tenantId, bot.botId), []);
});

Given("the computer of {string} is stopped", async function (this: ChatticusWorld, organization: string) {
	const stopped = await setComputerStopped(tenantIdOfOrganization(organization), true, { store: this.messagingStore(), ids: this.ids });
	assert.equal(stopped.stopped, true);
	boardScenarioOf(this).computerAtStop = stopped;
});

Given("the board store cannot confirm writes", function (this: ChatticusWorld) {
	boardScenarioOf(this).fake.setCannotConfirmWrites(true);
});

Given("the board store is unreachable", function (this: ChatticusWorld) {
	boardScenarioOf(this).fake.setUnreachable(true);
});

Given("the board's index has not caught up", function (this: ChatticusWorld) {
	boardScenarioOf(this).fake.setCatalogLagging(true);
});

Given("the network answer to the next board write is lost", function (this: ChatticusWorld) {
	boardScenarioOf(this).fake.loseAnswerOfNextWrite();
});

When("the bot {string} is created in {string}", async function (this: ChatticusWorld, name: string, organization: string) {
	const tenantId = tenantIdOfOrganization(organization);
	await ensureTestOrganization(this, tenantId);
	const response = await recordResponse(await memberPost(this, `/orgs/${tenantId}/bots`, { name }));
	assert.equal(response.status, 200, response.text);
	const bot = { botId: response.json.bot_id as string, tenantId, name };
	this.botsById ??= new Map();
	this.botsByName ??= new Map();
	this.botsById.set(bot.botId, bot);
	this.botsByName.set(name, bot);
	boardScenarioOf(this).defaultTenantId = tenantId;
});

Given("storing the next bot fails", function (this: ChatticusWorld) {
	storeFailures.add(this);
});

When("a member tries to create the bot {string} in {string}", async function (this: ChatticusWorld, name: string, organization: string) {
	const tenantId = tenantIdOfOrganization(organization);
	await ensureTestOrganization(this, tenantId);
	creationAnswers.set(this, await recordResponse(await memberPost(this, `/orgs/${tenantId}/bots`, { name })));
});

When("the bot {string} is created in {string} and storing it fails", async function (this: ChatticusWorld, name: string, organization: string) {
	const tenantId = tenantIdOfOrganization(organization);
	await ensureTestOrganization(this, tenantId);
	assert.ok(storeFailures.has(this), "The scenario did not arm a storage failure");
	const store = this.messagingStore();
	const failing = new Proxy(store, {
		get(target, property, receiver) {
			if (property === "putBot") return async () => { throw new Error("the bot could not be stored"); };
			return Reflect.get(target, property, receiver);
		},
	});
	await assert.rejects(
		createBot(tenantId, name, { creatorUserId: CREATING_USER }, { store: failing, ids: this.ids, boards: boardProvisionerFor(this) ?? null }),
		/could not be stored/,
	);
});

Then("the creation is answered with 502 saying the board could not be provisioned", function (this: ChatticusWorld) {
	const answer = creationAnswers.get(this);
	assert.ok(answer, "No creation was attempted");
	assert.equal(answer.status, 502, answer.text);
	assert.match(String(answer.json.detail), /could not be provisioned/);
});

Then("the bot {string} was not stored in {string}", async function (this: ChatticusWorld, name: string, organization: string) {
	assert.equal(await this.messagingStore().getBotByName(tenantIdOfOrganization(organization), name), null);
});

Then("the board that was provisioned for it is archived", function (this: ChatticusWorld) {
	const assistant = botNamed(this, "Assistant");
	const archived = [...boardScenarioOf(this).fake.boards.entries()].filter(([, board]) => board.archivedAt !== null);
	assert.equal(archived.length, 1, "Exactly the orphan board should be archived");
	assert.notEqual(archived[0]![0], `${assistant.tenantId}/${assistant.botId}`);
});

Then("the board of {string} was provisioned on behalf of the member who created the bot", async function (this: ChatticusWorld, name: string) {
	const bot = botNamed(this, name);
	const write = boardScenarioOf(this).fake.requests.find((request) => request.method === "PUT" && request.path === `/${bot.tenantId}/${bot.botId}/api/config`);
	assert.ok(write);
	const ownerEmail = await ensureTestOrganization(this, bot.tenantId);
	const owner = await this.messagingStore().getIdentityByEmail(ownerEmail);
	assert.equal(write.actor, `chatticus:user:${owner!.userId}`);
	assert.equal(write.accessKeyId, "scenario-front-door-key");
});

Then("the board of {string} was provisioned by an empty-bodied configuration write", function (this: ChatticusWorld, name: string) {
	const bot = botNamed(this, name);
	const scenario = boardScenarioOf(this);
	const writes = scenario.fake.requests.filter((request) => request.method === "PUT" && request.path === `/${bot.tenantId}/${bot.botId}/api/config`);
	assert.equal(writes.length, 1, `Expected one configuration write for ${name}`);
	assert.equal(writes[0]!.bodyText, "");
	assert.equal(writes[0]!.status, 201);
	assert.match(writes[0]!.operationId ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	assert.match(writes[0]!.actor ?? "", /^chatticus:user:/);
});

export function currentBoardCard(world: ChatticusWorld): ReturnType<typeof currentCardOf> {
	return currentCardOf(boardScenarioOf(world));
}

export type { BoardScenario };
