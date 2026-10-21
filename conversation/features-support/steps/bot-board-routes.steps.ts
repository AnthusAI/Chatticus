import assert from "node:assert/strict";
import { DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { Given, Then, When } from "@cucumber/cucumber";
import { membershipKey } from "../../src/store/keys.ts";
import { createBot } from "../../src/domain/bots.ts";
import { OrganizationsKernelImpl, type MemberRole } from "../../src/domain/organizations.ts";
import { recordResponse, type RecordedResponse } from "../api.ts";
import { capturedConsoleLines } from "../log-capture-support.ts";
import {
	auditRecordsOf,
	botActor,
	boardProvisionerFor,
	boardScenarioOf,
	currentCardOf,
	FRONT_DOOR_ACCESS_KEY_ID,
	noteRevision,
	rememberCard,
	storedCard,
	tenantIdOfOrganization,
} from "../bot-board-support.ts";
import { bearerFor, wireFrontDoor } from "../front-door.ts";
import { ensureTestOrganization } from "../org-user-client.ts";
import type { ChatticusWorld } from "../world.ts";

const kernel = new OrganizationsKernelImpl();

type RouteBot = { readonly botId: string; readonly tenantId: string; readonly name: string };

type RouteScenario = {
	snapshot: string | null;
	otherBotCard: { bot: RouteBot; id: string; revision: string } | null;
	readonly bots: Map<string, RouteBot>;
	readonly firstTenantOfBot: Map<string, string>;
	response: RecordedResponse | null;
	lastBot: RouteBot | null;
	baseline: number | null;
	conflict: Record<string, any> | null;
	unchanged: { bot: RouteBot; id: string; revision: string } | null;
};

const scenarios = new WeakMap<ChatticusWorld, RouteScenario>();

function routeScenarioOf(world: ChatticusWorld): RouteScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = { bots: new Map(), firstTenantOfBot: new Map(), snapshot: null, otherBotCard: null, response: null, lastBot: null, baseline: null, conflict: null, unchanged: null };
		scenarios.set(world, scenario);
	}
	return scenario;
}

function botIn(world: ChatticusWorld, name: string, organization?: string): RouteBot {
	const routes = routeScenarioOf(world);
	const tenantId = organization === undefined ? routes.firstTenantOfBot.get(name) : tenantIdOfOrganization(organization);
	const bot = tenantId === undefined ? undefined : routes.bots.get(`${tenantId}|${name}`);
	assert.ok(bot, `The scenario has no bot ${name}${organization === undefined ? "" : ` in ${organization}`}`);
	return bot;
}

async function userIdOf(world: ChatticusWorld, email: string): Promise<string> {
	const identity = await world.messagingStore().getIdentityByEmail(email);
	assert.ok(identity, `No identity for ${email}`);
	return identity.userId;
}

function boardPath(bot: RouteBot, rest = ""): string {
	return `/orgs/${bot.tenantId}/bots/${bot.botId}/board${rest}`;
}

type CallOptions = { body?: unknown; headers?: Record<string, string> };

async function call(world: ChatticusWorld, who: string | null, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, options: CallOptions = {}): Promise<RecordedResponse> {
	assert.ok(world.api, "The scenario has no HTTP front door");
	const routes = routeScenarioOf(world);
	routes.baseline ??= boardScenarioOf(world).fake.requests.length;
	const headers = { ...(who === null ? {} : await bearerFor(world, who)), ...(options.headers ?? {}) };
	const init = { headers, ...(options.body === undefined ? {} : { body: options.body }) };
	const api = world.api;
	const response =
		method === "GET" ? await api.get(path, init)
		: method === "POST" ? await api.post(path, init)
		: method === "PUT" ? await api.put(path, init)
		: method === "PATCH" ? await api.patch(path, init)
		: await api.delete(path, init);
	routes.response = await recordResponse(response);
	return routes.response;
}

function responseOf(world: ChatticusWorld): RecordedResponse {
	const response = routeScenarioOf(world).response;
	assert.ok(response, "The scenario made no board request");
	return response;
}

function cardId(world: ChatticusWorld, bot: RouteBot, title: string): string {
	const found = boardScenarioOf(world).fake.cardsOf(bot.tenantId, bot.botId).find((card) => card.title === title);
	assert.ok(found, `The board of ${bot.name} has no card titled ${title}`);
	return found.id as string;
}

function revisionOf(world: ChatticusWorld, bot: RouteBot, id: string): string {
	const stored = boardScenarioOf(world).fake.peek(bot.tenantId, bot.botId, id);
	assert.ok(stored, `No card ${id}`);
	return stored.revision;
}

function remember(world: ChatticusWorld, bot: RouteBot, title: string, id: string): void {
	if (world.botsByName?.get(bot.name)?.botId !== bot.botId) return;
	rememberCard(boardScenarioOf(world), bot.name, title, id, revisionOf(world, bot, id));
}

type RevisionChoice = "current" | "none" | "before";

function revisionHeader(world: ChatticusWorld, bot: RouteBot, id: string, choice: RevisionChoice): Record<string, string> {
	if (choice === "none") return {};
	if (choice === "current") return { "If-Match": revisionOf(world, bot, id) };
	const seen = boardScenarioOf(world).revisionsByCard.get(id) ?? [];
	assert.ok(seen.length >= 2, "The scenario saw only one revision of the card");
	return { "If-Match": seen[seen.length - 2]! };
}

async function changeCard(
	world: ChatticusWorld,
	who: string,
	title: string,
	botName: string,
	method: "PATCH" | "POST" | "PUT" | "DELETE",
	suffix: string,
	body: unknown,
	choice: RevisionChoice = "current",
	extraHeaders: Record<string, string> = {},
): Promise<RecordedResponse> {
	const bot = botIn(world, botName);
	const id = cardId(world, bot, title);
	remember(world, bot, title, id);
	routeScenarioOf(world).lastBot = bot;
	const response = await call(world, who, method, boardPath(bot, `/cards/${id}${suffix}`), { ...(body === undefined ? {} : { body }), headers: { ...revisionHeader(world, bot, id, choice), ...extraHeaders } });
	if (response.status === 409 && response.json?.current_card !== undefined) routeScenarioOf(world).conflict = response.json;
	return response;
}

Given("the organization {string} has a bot named {string} with a card titled {string}", async function (this: ChatticusWorld, organization: string, name: string, title: string) {
	const tenantId = tenantIdOfOrganization(organization);
	await ensureTestOrganization(this, tenantId);
	const members = await this.messagingStore().listMemberships(tenantId);
	const owner = members.find((member) => member.role === "owner");
	assert.ok(owner, `${organization} has no owner`);
	const bot = await createBot(tenantId, name, { creatorUserId: owner.userId }, { store: this.messagingStore(), ids: this.ids, boards: boardProvisionerFor(this) ?? null });
	const routes = routeScenarioOf(this);
	routes.bots.set(`${tenantId}|${name}`, { botId: bot.botId, tenantId, name });
	const first = !routes.firstTenantOfBot.has(name);
	if (first) routes.firstTenantOfBot.set(name, tenantId);
	this.botsById ??= new Map();
	this.botsByName ??= new Map();
	if (first) {
		this.botsById.set(bot.botId, bot);
		this.botsByName.set(name, bot);
		this.botCreatorUserIds.set(name, owner.userId);
		boardScenarioOf(this).defaultTenantId = tenantId;
	}
	const scenario = boardScenarioOf(this);
	const created = await scenario.executor.createCard({ organizationId: tenantId, botId: bot.botId }, { kind: "bot", botId: bot.botId }, { title }, { operationKey: `given/${tenantId}/${name}/${title}` });
	assert.ok(created.ok, JSON.stringify(created));
	if (first) rememberCard(scenario, name, title, created.value.issue.id, created.value.revision);
});

Given("the deployment has no board service", async function (this: ChatticusWorld) {
	boardScenarioOf(this).enabled = false;
	assert.ok(this.frontDoorOptions, "The scenario has no front door yet");
	await wireFrontDoor(this, this.frontDoorOptions);
});

Given("the card {string} is moved to the status {string} by the bot", async function (this: ChatticusWorld, title: string, status: string) {
	const bot = botIn(this, "Assistant");
	const id = cardId(this, bot, title);
	const scenario = boardScenarioOf(this);
	const moved = await scenario.executor.updateCard({ organizationId: bot.tenantId, botId: bot.botId }, botActor(this, bot.name), id, { status }, { operationKey: `given-move/${title}/${status}`, revision: revisionOf(this, bot, id) });
	assert.ok(moved.ok, JSON.stringify(moved));
	noteRevision(scenario, id, moved.value.revision);
});

Given("the card {string} has the comment {string} from the bot", async function (this: ChatticusWorld, title: string, text: string) {
	const bot = botIn(this, "Assistant");
	const id = cardId(this, bot, title);
	const scenario = boardScenarioOf(this);
	noteRevision(scenario, id, revisionOf(this, bot, id));
	const commented = await scenario.executor.commentOnCard({ organizationId: bot.tenantId, botId: bot.botId }, botActor(this, bot.name), id, text, { operationKey: `given-comment/${title}/${text}`, revision: revisionOf(this, bot, id) });
	assert.ok(commented.ok, JSON.stringify(commented));
	noteRevision(scenario, id, commented.value.revision);
	remember(this, bot, title, id);
});

When("{string} opens the board of {string} in {string}", async function (this: ChatticusWorld, who: string, botName: string, organization: string) {
	const bot = botIn(this, botName, organization);
	routeScenarioOf(this).lastBot = bot;
	await call(this, who, "GET", boardPath(bot));
});

When("{string} lists the board of {string} in {string}", async function (this: ChatticusWorld, who: string, botName: string, organization: string) {
	const bot = botIn(this, botName, organization);
	routeScenarioOf(this).lastBot = bot;
	await call(this, who, "GET", boardPath(bot, "/cards"));
});

When("{string} lists the board of {string} in {string} with the status {string}", async function (this: ChatticusWorld, who: string, botName: string, organization: string, status: string) {
	const bot = botIn(this, botName, organization);
	await call(this, who, "GET", boardPath(bot, `/cards?status=${encodeURIComponent(status)}`));
});

When("{string} lists the board of {string} in {string} with a limit of {int}", async function (this: ChatticusWorld, who: string, botName: string, organization: string, limit: number) {
	const bot = botIn(this, botName, organization);
	await call(this, who, "GET", boardPath(bot, `/cards?limit=${limit}`));
});

When("an unauthenticated caller lists the board of {string} in {string}", async function (this: ChatticusWorld, botName: string, organization: string) {
	await call(this, null, "GET", boardPath(botIn(this, botName, organization), "/cards"));
});

When("{string} opens the board of an unknown bot in {string}", async function (this: ChatticusWorld, who: string, organization: string) {
	const tenantId = tenantIdOfOrganization(organization);
	await call(this, who, "GET", `/orgs/${tenantId}/bots/00000000-0000-4000-8000-000000000000/board`);
});

When("{string} opens the board of the {string} bot {string} under the organization {string}", async function (this: ChatticusWorld, who: string, bots: string, botName: string, organization: string) {
	const bot = botIn(this, botName, bots);
	await call(this, who, "GET", `/orgs/${tenantIdOfOrganization(organization)}/bots/${bot.botId}/board`);
});

When("{string} reads the card {string} on the board of {string}", async function (this: ChatticusWorld, who: string, title: string, botName: string) {
	const bot = botIn(this, botName);
	const id = cardId(this, bot, title);
	remember(this, bot, title, id);
	await call(this, who, "GET", boardPath(bot, `/cards/${id}`));
});

When("{string} reads the card {string} on the board of {string} in {string} using its real identifier", async function (this: ChatticusWorld, who: string, title: string, botName: string, organization: string) {
	const bot = botIn(this, botName, organization);
	const id = cardId(this, bot, title);
	routeScenarioOf(this).unchanged = { bot, id, revision: revisionOf(this, bot, id) };
	await call(this, who, "GET", `/orgs/${bot.tenantId}/bots/${bot.botId}/board/cards/${id}`);
});

When("{string} moves that card to the status {string} using its real identifier", async function (this: ChatticusWorld, who: string, status: string) {
	const guarded = routeScenarioOf(this).unchanged;
	assert.ok(guarded, "The scenario read no card by its real identifier");
	await call(this, who, "PATCH", boardPath(guarded.bot, `/cards/${guarded.id}`), { body: { status }, headers: { "If-Match": guarded.revision } });
});

When("{string} moves the card {string} on the board of {string} to the status {string}", async function (this: ChatticusWorld, who: string, title: string, botName: string, status: string) {
	await changeCard(this, who, title, botName, "PATCH", "", { status });
});

When("{string} moves the card {string} on the board of {string} to the status {string} without a revision", async function (this: ChatticusWorld, who: string, title: string, botName: string, status: string) {
	await changeCard(this, who, title, botName, "PATCH", "", { status }, "none");
});

When("{string} moves the card {string} on the board of {string} to the status {string} using the revision the card had before", async function (this: ChatticusWorld, who: string, title: string, botName: string, status: string) {
	await changeCard(this, who, title, botName, "PATCH", "", { status }, "before");
});

When("{string} repeats the move using the current revision from the response", async function (this: ChatticusWorld, who: string) {
	const conflict = routeScenarioOf(this).conflict;
	assert.ok(conflict, "The scenario saw no conflict");
	const bot = routeScenarioOf(this).lastBot!;
	await call(this, who, "PATCH", boardPath(bot, `/cards/${conflict.current_card.issue.id}`), { body: { status: "in_progress" }, headers: { "If-Match": conflict.current_revision } });
});

When("{string} creates a card titled {string} on the board of {string}", async function (this: ChatticusWorld, who: string, title: string, botName: string) {
	const bot = botIn(this, botName);
	routeScenarioOf(this).lastBot = bot;
	const response = await call(this, who, "POST", boardPath(bot, "/cards"), { body: { title } });
	if (response.status === 200) remember(this, bot, title, response.json.issue.id);
});

When("{string} creates a card titled {string} on the board of {string} with the Idempotency-Key {string}", async function (this: ChatticusWorld, who: string, title: string, botName: string, key: string) {
	const bot = botIn(this, botName);
	const response = await call(this, who, "POST", boardPath(bot, "/cards"), { body: { title }, headers: { "Idempotency-Key": key } });
	assert.equal(response.status, 200, response.text);
});

When("{string} creates a card titled {string} on the board of {string} in {string} naming {string} in the request body", async function (this: ChatticusWorld, who: string, title: string, botName: string, organization: string, other: string) {
	const bot = botIn(this, botName, organization);
	const otherBot = botIn(this, botName, other);
	const response = await call(this, who, "POST", boardPath(bot, "/cards"), {
		body: { title, tenant_id: otherBot.tenantId, organization_id: otherBot.tenantId, bot_id: otherBot.botId },
	});
	if (response.status === 200) remember(this, bot, title, response.json.issue.id);
});

When("{string} comments {string} on the card {string} on the board of {string}", async function (this: ChatticusWorld, who: string, text: string, title: string, botName: string) {
	await changeCard(this, who, title, botName, "POST", "/comments", { text });
});

When(
	"{string} edits the card {string} on the board of {string} setting the title {string} and the priority {int} and the label {string}",
	async function (this: ChatticusWorld, who: string, title: string, botName: string, newTitle: string, priority: number, label: string) {
		await changeCard(this, who, title, botName, "PATCH", "", { title: newTitle, priority, labels: [label] });
	},
);

When("{string} tries to complete the card {string} without evidence", async function (this: ChatticusWorld, who: string, title: string) {
	await changeCard(this, who, title, "Assistant", "POST", "/complete", { evidence: "" });
});

When("{string} completes the card {string} with the evidence {string}", async function (this: ChatticusWorld, who: string, title: string, evidence: string) {
	await changeCard(this, who, title, "Assistant", "POST", "/complete", { evidence });
});

When("{string} tries to abandon the card {string} without a reason", async function (this: ChatticusWorld, who: string, title: string) {
	await changeCard(this, who, title, "Assistant", "POST", "/abandon", { reason: " " });
});

When("{string} abandons the card {string} with the reason {string}", async function (this: ChatticusWorld, who: string, title: string, reason: string) {
	await changeCard(this, who, title, "Assistant", "POST", "/abandon", { reason });
});

When("{string} reopens the card {string} on the board of {string}", async function (this: ChatticusWorld, who: string, title: string, botName: string) {
	await changeCard(this, who, title, botName, "POST", "/reopen", {});
});

When("{string} puts the card {string} under the card {string} on the board of {string}", async function (this: ChatticusWorld, who: string, title: string, parentTitle: string, botName: string) {
	const parent = cardId(this, botIn(this, botName), parentTitle);
	await changeCard(this, who, title, botName, "PUT", "/parent", { parent });
});

When("{string} takes the card {string} out from under its parent on the board of {string}", async function (this: ChatticusWorld, who: string, title: string, botName: string) {
	await changeCard(this, who, title, botName, "PUT", "/parent", { parent: null });
});

When(
	"{string} records that the card {string} is blocked by the card {string} on the board of {string}",
	async function (this: ChatticusWorld, who: string, title: string, targetTitle: string, botName: string) {
		const target = cardId(this, botIn(this, botName), targetTitle);
		await changeCard(this, who, title, botName, "POST", "/dependencies", { target, type: "blocked-by" });
	},
);

When(
	"{string} removes the dependency of the card {string} on the card {string} on the board of {string}",
	async function (this: ChatticusWorld, who: string, title: string, targetTitle: string, botName: string) {
		const target = cardId(this, botIn(this, botName), targetTitle);
		await changeCard(this, who, title, botName, "DELETE", `/dependencies/${target}`, undefined);
	},
);

When("{string} deletes the card {string} on the board of {string}", async function (this: ChatticusWorld, who: string, title: string, botName: string) {
	await changeCard(this, who, title, botName, "DELETE", "", undefined);
});

When("{string} archives the board of {string} in {string}", async function (this: ChatticusWorld, who: string, botName: string, organization: string) {
	const bot = botIn(this, botName, organization);
	routeScenarioOf(this).lastBot = bot;
	await call(this, who, "POST", boardPath(bot, "/archive"), { body: {} });
});

When("{string} restores the board of {string} in {string}", async function (this: ChatticusWorld, who: string, botName: string, organization: string) {
	const bot = botIn(this, botName, organization);
	await call(this, who, "POST", boardPath(bot, "/restore"), { body: {} });
});

When("{string} changes the role of {string} in {string} to {word}", async function (this: ChatticusWorld, actor: string, member: string, organization: string, role: string) {
	const tenantId = tenantIdOfOrganization(organization);
	await kernel.setMemberRole(tenantId, await userIdOf(this, actor), await userIdOf(this, member), role as MemberRole, { store: this.messagingStore() });
});

Then("the response is ok", function (this: ChatticusWorld) {
	const response = responseOf(this);
	assert.equal(response.status, 200, response.text);
});

Then("the response is forbidden", function (this: ChatticusWorld) {
	const response = responseOf(this);
	assert.equal(response.status, 403, response.text);
	assert.equal(response.json?.code, "forbidden", response.text);
});

Then("the response is not found", function (this: ChatticusWorld) {
	const response = responseOf(this);
	assert.equal(response.status, 404, response.text);
	assert.equal(response.json?.code, "not_found", response.text);
});

Then("the response is not found with the code {string}", function (this: ChatticusWorld, code: string) {
	const response = responseOf(this);
	assert.equal(response.status, 404, response.text);
	assert.equal(response.json?.code, code, response.text);
});

Then("the response is refused as not signed in", function (this: ChatticusWorld) {
	const response = responseOf(this);
	assert.equal(response.status, 403, response.text);
	assert.equal(response.json?.detail, "user credential required");
});

Then("the response is refused as missing evidence", function (this: ChatticusWorld) {
	const response = responseOf(this);
	assert.equal(response.status, 422, response.text);
	assert.equal(response.json?.code, "evidence_required");
});

Then("the response is refused as missing a reason", function (this: ChatticusWorld) {
	const response = responseOf(this);
	assert.equal(response.status, 422, response.text);
	assert.equal(response.json?.code, "reason_required");
});

Then("the response is refused as needing evidence or a reason", function (this: ChatticusWorld) {
	const response = responseOf(this);
	assert.equal(response.status, 422, response.text);
	assert.equal(response.json?.code, "closing_needs_evidence_or_reason");
});

Then("the response asks for the revision", function (this: ChatticusWorld) {
	const response = responseOf(this);
	assert.equal(response.status, 428, response.text);
	assert.equal(response.json?.code, "revision_required");
});

Then("the response is a conflict", function (this: ChatticusWorld) {
	const response = responseOf(this);
	assert.equal(response.status, 409, response.text);
	assert.equal(response.json?.code, "revision_conflict");
});

Then("the response carries the current revision and the current card", function (this: ChatticusWorld) {
	const response = responseOf(this);
	const bot = routeScenarioOf(this).lastBot!;
	const card = currentCardOf(boardScenarioOf(this));
	assert.equal(response.json.current_revision, revisionOf(this, bot, card.id));
	assert.equal(response.json.current_card.revision, response.json.current_revision);
	assert.equal(response.json.current_card.issue.id, card.id);
});

Then("the response says the change was not confirmed and may or may not be stored", function (this: ChatticusWorld) {
	const response = responseOf(this);
	assert.equal(response.status, 502, response.text);
	assert.equal(response.json?.kind, "unavailable");
	assert.equal(response.json?.saved, false);
	assert.match(String(response.json?.detail), /may or may not have been stored/);
});

Then("the response flags the listing as possibly behind", function (this: ChatticusWorld) {
	assert.equal(responseOf(this).json?.catalog_pending, true);
});

Then("the response says the board is archived", function (this: ChatticusWorld) {
	const response = responseOf(this);
	assert.equal(response.status, 409, response.text);
	assert.equal(response.json?.code, "board_archived");
});

Then("the response refuses the restore because the board is not archived", function (this: ChatticusWorld) {
	const response = responseOf(this);
	assert.equal(response.status, 409, response.text);
	assert.equal(response.json?.code, "board_not_archived");
});

Then("the response lists the card {string}", function (this: ChatticusWorld, title: string) {
	const titles = (responseOf(this).json.cards as Array<{ issue: { title: string } }>).map((entry) => entry.issue.title);
	assert.ok(titles.includes(title), `Listed: ${titles.join(", ")}`);
});

Then("the response does not list the card {string}", function (this: ChatticusWorld, title: string) {
	const titles = (responseOf(this).json.cards as Array<{ issue: { title: string } }>).map((entry) => entry.issue.title);
	assert.ok(!titles.includes(title), `Listed: ${titles.join(", ")}`);
});

Then("the response lists exactly {int} card", function (this: ChatticusWorld, count: number) {
	assert.equal(responseOf(this).json.cards.length, count);
});

Then("the response names the board as the board of {string}", function (this: ChatticusWorld, botName: string) {
	const bot = routeScenarioOf(this).lastBot;
	assert.equal(bot?.name, botName);
	const json = responseOf(this).json;
	assert.equal(json.bot_id, bot.botId);
	assert.equal(json.tenant_id, bot.tenantId);
	assert.equal(json.bot_name, botName);
});

Then("the response carries the Kanbus default configuration of the board", function (this: ChatticusWorld) {
	const configuration = responseOf(this).json.configuration;
	assert.equal(configuration.project_key, "kanbus");
	assert.deepEqual(configuration.hierarchy, ["initiative", "epic", "task", "sub-task"]);
	assert.equal(configuration.initial_status, "open");
});

Then("the response shows the title, the status, the priority and the comment {string}", function (this: ChatticusWorld, text: string) {
	const issue = responseOf(this).json.issue;
	assert.equal(issue.title, "Pay the electric bill");
	assert.equal(issue.status, "open");
	assert.equal(typeof issue.priority, "number");
	assert.ok((issue.comments as Array<{ text: string }>).some((comment) => comment.text === text), JSON.stringify(issue.comments));
});

Then("the response carries the revision of the card", function (this: ChatticusWorld) {
	const bot = botIn(this, "Assistant");
	assert.equal(responseOf(this).json.revision, revisionOf(this, bot, cardId(this, bot, "Pay the electric bill")));
});

Then("the response carries no card content", function (this: ChatticusWorld) {
	const response = responseOf(this);
	for (const field of ["issue", "cards", "configuration", "current_card"]) assert.equal(response.json?.[field], undefined, response.text);
	assert.ok(!response.text.includes("Pay the electric bill"), response.text);
});

Then("the card {string} is on the board of {string}", function (this: ChatticusWorld, title: string, botName: string) {
	const bot = botIn(this, botName);
	const card = boardScenarioOf(this).fake.cardsOf(bot.tenantId, bot.botId).find((candidate) => candidate.title === title);
	assert.ok(card, `The board of ${botName} has no card titled ${title}`);
	remember(this, bot, title, card.id as string);
});

Then("the board of {string} in {string} has no card titled {string}", function (this: ChatticusWorld, botName: string, organization: string, title: string) {
	const bot = botIn(this, botName, organization);
	assert.ok(!boardScenarioOf(this).fake.cardsOf(bot.tenantId, bot.botId).some((card) => card.title === title));
});

Then("the board of {string} in {string} has exactly {int} card titled {string}", function (this: ChatticusWorld, botName: string, organization: string, count: number, title: string) {
	const bot = botIn(this, botName, organization);
	assert.equal(boardScenarioOf(this).fake.cardsOf(bot.tenantId, bot.botId).filter((card) => card.title === title).length, count);
});

Then("the card {string} records {string} as its creator", async function (this: ChatticusWorld, title: string, email: string) {
	const bot = botIn(this, "Assistant");
	const stored = storedCard(this, { botName: bot.name, title, id: cardId(this, bot, title) });
	assert.equal(stored.issue.creator, `chatticus:user:${await userIdOf(this, email)}`);
});

Then("the card has the comment {string} by {string}", async function (this: ChatticusWorld, text: string, email: string) {
	const comments = storedCard(this, currentCardOf(boardScenarioOf(this))).issue.comments as Array<{ author: string; text: string }>;
	const author = `chatticus:user:${await userIdOf(this, email)}`;
	assert.ok(comments.some((comment) => comment.author === author && comment.text === text), JSON.stringify(comments));
});

Then("the card has no comments", function (this: ChatticusWorld) {
	assert.deepEqual(storedCard(this, currentCardOf(boardScenarioOf(this))).issue.comments, []);
});

Then("the card is now titled {string} with the priority {int} and the label {string}", function (this: ChatticusWorld, title: string, priority: number, label: string) {
	const { issue } = storedCard(this, currentCardOf(boardScenarioOf(this)));
	assert.equal(issue.title, title);
	assert.equal(issue.priority, priority);
	assert.deepEqual(issue.labels, [label]);
});

Then("the card has a closing comment holding {string}", function (this: ChatticusWorld, text: string) {
	const comments = storedCard(this, currentCardOf(boardScenarioOf(this))).issue.comments as Array<{ text: string }>;
	assert.ok(comments.at(-1)?.text.includes(text), JSON.stringify(comments));
});

Then("the card {string} is under the card {string}", function (this: ChatticusWorld, title: string, parentTitle: string) {
	const bot = botIn(this, "Assistant");
	const { issue } = storedCard(this, { botName: bot.name, title, id: cardId(this, bot, title) });
	assert.equal(issue.parent, cardId(this, bot, parentTitle));
});

Then("the card {string} has no parent", function (this: ChatticusWorld, title: string) {
	const bot = botIn(this, "Assistant");
	assert.equal(storedCard(this, { botName: bot.name, title, id: cardId(this, bot, title) }).issue.parent, null);
});

Then("the card {string} is blocked by the card {string}", function (this: ChatticusWorld, title: string, targetTitle: string) {
	const bot = botIn(this, "Assistant");
	const { issue } = storedCard(this, { botName: bot.name, title, id: cardId(this, bot, title) });
	assert.deepEqual(issue.dependencies, [{ target: cardId(this, bot, targetTitle), type: "blocked-by" }]);
});

Then("the card {string} depends on no card", function (this: ChatticusWorld, title: string) {
	const bot = botIn(this, "Assistant");
	assert.deepEqual(storedCard(this, { botName: bot.name, title, id: cardId(this, bot, title) }).issue.dependencies, []);
});

Then("the card in {string} is unchanged", function (this: ChatticusWorld, _organization: string) {
	const guarded = routeScenarioOf(this).unchanged;
	assert.ok(guarded, "The scenario kept no card to compare");
	assert.equal(revisionOf(this, guarded.bot, guarded.id), guarded.revision);
});

Then("the board store was called by the Chatticus service principal", function (this: ChatticusWorld) {
	const requests = boardScenarioOf(this).fake.requests;
	assert.equal(requests.at(-1)?.accessKeyId, FRONT_DOOR_ACCESS_KEY_ID);
});

Then("the board store was told the actor is {string} followed by the identifier of {string}", async function (this: ChatticusWorld, prefix: string, email: string) {
	const expected = `${prefix}${await userIdOf(this, email)}`;
	const requests = boardScenarioOf(this).fake.requests.filter((request) => request.method === "PATCH");
	assert.ok(requests.some((request) => request.actor === expected), `No change named the actor ${expected}`);
	assert.ok(requests.every((request) => request.actor === expected));
});

Then("the board store was not called", function (this: ChatticusWorld) {
	const baseline = routeScenarioOf(this).baseline;
	assert.ok(baseline !== null, "The scenario made no board request");
	assert.equal(boardScenarioOf(this).fake.requests.length, baseline);
});

Then("the computer of {string} is still stopped", async function (this: ChatticusWorld, organization: string) {
	const atStop = boardScenarioOf(this).computerAtStop as { tenantId: string } | null;
	assert.ok(atStop && atStop.tenantId === tenantIdOfOrganization(organization), "The scenario never stopped that computer");
	assert.deepEqual(await this.messagingStore().getComputer(atStop.tenantId), atStop);
});

Then("the audit log has a record for {string} with the outcome {string} for the board of {string}", async function (this: ChatticusWorld, email: string, outcome: string, botName: string) {
	const bot = botIn(this, botName);
	const userId = await userIdOf(this, email);
	const records = auditRecordsOf(this).filter((record) => record.userId === userId && record.botId === bot.botId && record.outcome === outcome);
	assert.ok(records.length >= 1, `No audit record for ${email}: ${JSON.stringify(auditRecordsOf(this))}`);
});

Then("no audit record contains card text", function (this: ChatticusWorld) {
	const text = JSON.stringify(auditRecordsOf(this));
	assert.ok(auditRecordsOf(this).length > 0);
	for (const fragment of ["Pay the electric bill", "in_progress", "Water the plants"]) assert.ok(!text.includes(fragment), text);
});

When(
	"{string} comments {string} on the card {string} on the board of {string} with the Idempotency-Key {string}",
	async function (this: ChatticusWorld, who: string, text: string, title: string, botName: string, key: string) {
		await changeCard(this, who, title, botName, "POST", "/comments", { text }, "current", { "Idempotency-Key": key });
	},
);

When("{string} creates a card titled {string} on the board of {string} with the status {string}", async function (this: ChatticusWorld, who: string, title: string, botName: string, status: string) {
	const bot = botIn(this, botName);
	const response = await call(this, who, "POST", boardPath(bot, "/cards"), { body: { title, status } });
	if (response.status === 200) remember(this, bot, title, response.json.issue.id);
});

Given("{string} has archived the board of {string} in {string}", async function (this: ChatticusWorld, who: string, botName: string, organization: string) {
	const bot = botIn(this, botName, organization);
	const response = await call(this, who, "POST", boardPath(bot, "/archive"), { body: {} });
	assert.equal(response.status, 200, response.text);
});

Given("the bot {string} recorded that the card {string} is blocked by the card {string}", async function (this: ChatticusWorld, botName: string, title: string, targetTitle: string) {
	const bot = botIn(this, botName);
	const id = cardId(this, bot, title);
	const scenario = boardScenarioOf(this);
	const done = await scenario.executor.addDependency({ organizationId: bot.tenantId, botId: bot.botId }, botActor(this, bot.name), id, cardId(this, bot, targetTitle), "blocked-by", { operationKey: `given-dependency/${title}`, revision: revisionOf(this, bot, id) });
	assert.ok(done.ok, JSON.stringify(done));
});

Then("the response is refused because a closed card is only reopened", function (this: ChatticusWorld) {
	const response = responseOf(this);
	assert.equal(response.status, 422, response.text);
	assert.equal(response.json?.code, "closed_card_needs_reopen");
});

Then("the response says the board service did not confirm the request", function (this: ChatticusWorld) {
	const response = responseOf(this);
	assert.equal(response.status, 502, response.text);
	assert.equal(response.json?.code, "board_service_unavailable");
	assert.match(String(response.json?.detail), /did not confirm the request/);
});

Then("the board response does not contain {string}", function (this: ChatticusWorld, text: string) {
	assert.ok(!responseOf(this).text.includes(text), responseOf(this).text);
});

Then("the error log holds {string}", function (this: ChatticusWorld, text: string) {
	assert.ok(capturedConsoleLines(this).some((line) => line.startsWith("bot_board_service_failure") && line.includes(text)), capturedConsoleLines(this).join("\n"));
});

Then("the response is refused as too long", function (this: ChatticusWorld) {
	const response = responseOf(this);
	assert.equal(response.status, 422, response.text);
	assert.equal(response.json?.code, "field_too_long");
});

Then("the response is refused as too large", function (this: ChatticusWorld) {
	const response = responseOf(this);
	assert.equal(response.status, 413, response.text);
	assert.equal(response.json?.code, "body_too_large");
});

Then("the board store received no change", function (this: ChatticusWorld) {
	const baseline = routeScenarioOf(this).baseline;
	assert.ok(baseline !== null, "The scenario made no board request");
	const changes = boardScenarioOf(this).fake.requests.slice(baseline).filter((request) => request.method !== "GET");
	assert.deepEqual(changes, []);
});

function expandIdentifier(token: string): string {
	return token === "129 letters" ? "a".repeat(129) : token;
}

When("{string} requests the card path {string} on the board of {string}", async function (this: ChatticusWorld, who: string, token: string, botName: string) {
	const bot = botIn(this, botName);
	await call(this, who, "GET", boardPath(bot, `/cards/${expandIdentifier(token)}`));
});

When("{string} requests the removal of the dependency {string} of a card on the board of {string}", async function (this: ChatticusWorld, who: string, token: string, botName: string) {
	const bot = botIn(this, botName);
	const id = cardId(this, bot, "Pay the electric bill");
	await call(this, who, "DELETE", boardPath(bot, `/cards/${id}/dependencies/${expandIdentifier(token)}`), { headers: { "If-Match": revisionOf(this, bot, id) } });
});

When("{string} requests the board of the bot {string} in {string}", async function (this: ChatticusWorld, who: string, token: string, organization: string) {
	await call(this, who, "GET", `/orgs/${tenantIdOfOrganization(organization)}/bots/${expandIdentifier(token)}/board`);
});

When("{string} reads the card {string} of the bot {string} on the board of {string}", async function (this: ChatticusWorld, who: string, title: string, otherBot: string, botName: string) {
	const other = botIn(this, otherBot);
	const id = cardId(this, other, title);
	routeScenarioOf(this).otherBotCard = { bot: other, id, revision: revisionOf(this, other, id) };
	await call(this, who, "GET", boardPath(botIn(this, botName), `/cards/${id}`));
});

When("{string} moves the card {string} of the bot {string} on the board of {string} to the status {string}", async function (this: ChatticusWorld, who: string, title: string, otherBot: string, botName: string, status: string) {
	const other = botIn(this, otherBot);
	const id = cardId(this, other, title);
	routeScenarioOf(this).otherBotCard = { bot: other, id, revision: revisionOf(this, other, id) };
	await call(this, who, "PATCH", boardPath(botIn(this, botName), `/cards/${id}`), { body: { status }, headers: { "If-Match": revisionOf(this, other, id) } });
});

Then("the card of the bot {string} is unchanged", function (this: ChatticusWorld, otherBot: string) {
	const guarded = routeScenarioOf(this).otherBotCard;
	assert.ok(guarded && guarded.bot.name === otherBot);
	assert.equal(revisionOf(this, guarded.bot, guarded.id), guarded.revision);
});

type RouteRequest = { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; body?: unknown; withRevision?: string };

function routeRequestFor(world: ChatticusWorld, name: string, bot: RouteBot): RouteRequest {
	const pay = (): { id: string } => ({ id: cardId(world, bot, "Pay the electric bill") });
	const lookup = (title: string): string => cardId(world, bot, title);
	switch (name) {
		case "overview": return { method: "GET", path: boardPath(bot) };
		case "list": return { method: "GET", path: boardPath(bot, "/cards") };
		case "get": return { method: "GET", path: boardPath(bot, `/cards/${pay().id}`) };
		case "create": return { method: "POST", path: boardPath(bot, "/cards"), body: { title: "Ask about the late fee again" } };
		case "update": return { method: "PATCH", path: boardPath(bot, `/cards/${pay().id}`), body: { status: "in_progress" }, withRevision: pay().id };
		case "comment": return { method: "POST", path: boardPath(bot, `/cards/${pay().id}/comments`), body: { text: "hello" }, withRevision: pay().id };
		case "complete": return { method: "POST", path: boardPath(bot, `/cards/${pay().id}/complete`), body: { evidence: "done" }, withRevision: pay().id };
		case "abandon": return { method: "POST", path: boardPath(bot, `/cards/${pay().id}/abandon`), body: { reason: "no longer needed" }, withRevision: pay().id };
		case "reopen": return { method: "POST", path: boardPath(bot, `/cards/${pay().id}/reopen`), body: {}, withRevision: pay().id };
		case "parent": return { method: "PUT", path: boardPath(bot, `/cards/${pay().id}/parent`), body: { parent: lookup("Household money") }, withRevision: pay().id };
		case "add dependency": return { method: "POST", path: boardPath(bot, `/cards/${pay().id}/dependencies`), body: { target: lookup("Ask about the late fee"), type: "blocked-by" }, withRevision: pay().id };
		case "remove dependency": return { method: "DELETE", path: boardPath(bot, `/cards/${pay().id}/dependencies/${lookup("Ask about the late fee")}`), withRevision: pay().id };
		case "delete": return { method: "DELETE", path: boardPath(bot, `/cards/${pay().id}`), withRevision: pay().id };
		case "archive": return { method: "POST", path: boardPath(bot, "/archive"), body: {} };
		case "restore": return { method: "POST", path: boardPath(bot, "/restore"), body: {} };
		default: throw new Error(`Unknown route ${name}`);
	}
}

function boardSnapshot(world: ChatticusWorld, bot: RouteBot): string {
	const fake = boardScenarioOf(world).fake;
	const board = fake.boards.get(`${bot.tenantId}/${bot.botId}`);
	return JSON.stringify({ cards: fake.cardsOf(bot.tenantId, bot.botId), archived: board?.archivedAt ?? null, changes: fake.requests.filter((request) => request.method !== "GET").length });
}

When("{string} calls the route {string} on the board of {string}", async function (this: ChatticusWorld, who: string, name: string, botName: string) {
	const bot = botIn(this, botName);
	routeScenarioOf(this).lastBot = bot;
	routeScenarioOf(this).snapshot = boardSnapshot(this, bot);
	const request = routeRequestFor(this, name, bot);
	await call(this, who, request.method, request.path, {
		...(request.body === undefined ? {} : { body: request.body }),
		...(request.withRevision === undefined ? {} : { headers: { "If-Match": revisionOf(this, bot, request.withRevision) } }),
	});
});

Then("nothing changed on the board of {string}", function (this: ChatticusWorld, botName: string) {
	const before = routeScenarioOf(this).snapshot;
	assert.ok(before, "The scenario took no snapshot");
	assert.equal(boardSnapshot(this, botIn(this, botName)), before);
});

const WRITE_BODIES: Readonly<Record<string, { method: "POST" | "PATCH"; suffix: string; body: Record<string, unknown> }>> = {
	create: { method: "POST", suffix: "/cards", body: { title: "t" } },
	update: { method: "PATCH", suffix: "CARD", body: { title: "t" } },
	comment: { method: "POST", suffix: "CARD/comments", body: { text: "t" } },
	complete: { method: "POST", suffix: "CARD/complete", body: { evidence: "t" } },
	abandon: { method: "POST", suffix: "CARD/abandon", body: { reason: "t" } },
};

When("{string} sends the {string} write with the field {string} of {int} characters", async function (this: ChatticusWorld, who: string, write: string, field: string, length: number) {
	const bot = botIn(this, "Assistant");
	const spec = WRITE_BODIES[write];
	assert.ok(spec, `Unknown write ${write}`);
	const body: Record<string, unknown> = { ...spec.body };
	if (field === "label") body["labels"] = ["x".repeat(length)];
	else if (field === "labels") body["labels"] = Array.from({ length }, (_, index) => `l${index}`);
	else if (field === "padding") body["padding"] = "x".repeat(length);
	else body[field] = "x".repeat(length);
	const id = cardId(this, bot, "Pay the electric bill");
	const path = write === "create" ? boardPath(bot, "/cards") : boardPath(bot, `/cards/${id}${spec.suffix.replace("CARD", "")}`);
	await call(this, who, spec.method, path, { body, ...(write === "create" ? {} : { headers: { "If-Match": revisionOf(this, bot, id) } }) });
});

When("the membership of {string} in {string} is deleted from the store", async function (this: ChatticusWorld, email: string, organization: string) {
	const key = membershipKey(tenantIdOfOrganization(organization), await userIdOf(this, email));
	await this.messagingTable.client.send(new DeleteItemCommand({ TableName: this.messagingTable.tableName, Key: { pk: { S: key.pk }, sk: { S: key.sk } } }));
});
