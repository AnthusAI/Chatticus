import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { OrganizationsKernelImpl, type MemberRole } from "../../src/domain/organizations.ts";
import type { RememberedCard } from "../bot-board-support.ts";
import { botActor, boardScenarioOf, botNamed, cardNamed, noteRevision, rememberCard, storedCard, tenantIdOfOrganization, userActor } from "../bot-board-support.ts";
import type { ChatticusWorld } from "../world.ts";

const kernel = new OrganizationsKernelImpl();

type ServiceActor = ReturnType<typeof userActor> | ReturnType<typeof botActor>;

function addressOfBoard(world: ChatticusWorld, botName: string): { organizationId: string; botId: string } {
	const bot = botNamed(world, botName);
	return { organizationId: bot.tenantId, botId: bot.botId };
}

function latestRevision(world: ChatticusWorld, cardId: string): string {
	const seen = boardScenarioOf(world).revisionsByCard.get(cardId) ?? [];
	assert.ok(seen.length > 0, "The scenario has not seen the card yet");
	return seen[seen.length - 1]!;
}

function ownerBoardOf(world: ChatticusWorld, title: string): RememberedCard {
	const card = [...boardScenarioOf(world).cardsByKey.values()].find((candidate) => candidate.title === title);
	assert.ok(card, `The scenario has no card titled ${title}`);
	return card;
}

async function record(world: ChatticusWorld, result: NonNullable<ReturnType<typeof boardScenarioOf>["lastResult"]>): Promise<void> {
	boardScenarioOf(world).lastResult = result;
}

async function changeStatus(world: ChatticusWorld, actor: ServiceActor, title: string, status: string, botName?: string): Promise<void> {
	const scenario = boardScenarioOf(world);
	const card = ownerBoardOf(world, title);
	const service = actor.kind === "bot" ? scenario.executor : scenario.frontDoor;
	const result = await service.updateCard(addressOfBoard(world, botName ?? card.botName), actor, card.id, { status }, {
		operationKey: `change/${title}/${status}/${scenario.fake.requests.length}`,
		revision: latestRevision(world, card.id),
	});
	if (result.ok) noteRevision(scenario, card.id, result.value.revision);
	await record(world, result);
}

When(
	"{string} lists the board of {string} in {string} through the board service",
	async function (this: ChatticusWorld, userId: string, botName: string, _organization: string) {
		await record(this, await boardScenarioOf(this).frontDoor.listCards(addressOfBoard(this, botName), userActor(userId)));
	},
);

Given("{string} has read the board of {string} through the board service", async function (this: ChatticusWorld, userId: string, botName: string) {
	const result = await boardScenarioOf(this).frontDoor.listCards(addressOfBoard(this, botName), userActor(userId));
	assert.ok(result.ok, JSON.stringify(result));
});

When("the bot {string} uses the board service to list its board", async function (this: ChatticusWorld, botName: string) {
	await record(this, await boardScenarioOf(this).executor.listCards(addressOfBoard(this, botName), botActor(this, botName)));
});

Then("the board service lists the card {string}", function (this: ChatticusWorld, title: string) {
	const result = boardScenarioOf(this).lastResult;
	assert.ok(result?.ok, JSON.stringify(result));
	const titles = (result.value.cards as Array<{ issue: { title: string } }>).map((entry) => entry.issue.title);
	assert.ok(titles.includes(title), `Listed: ${titles.join(", ")}`);
});

Then("the board service lists the card {string} for the bot {string}", async function (this: ChatticusWorld, title: string, botName: string) {
	const result = await boardScenarioOf(this).executor.listCards(addressOfBoard(this, botName), botActor(this, botName));
	assert.ok(result.ok, JSON.stringify(result));
	assert.ok(result.value.cards.some((entry) => entry.issue.title === title));
});

When(
	"{string} moves the card {string} to the status {string} through the board service",
	async function (this: ChatticusWorld, userId: string, title: string, status: string) {
		await changeStatus(this, userActor(userId), title, status);
	},
);

When(
	"the bot {string} moves the card {string} to the status {string} through the board service",
	async function (this: ChatticusWorld, botName: string, title: string, status: string) {
		await changeStatus(this, botActor(this, botName), title, status, botName);
	},
);

When(
	"the bot {string} moves the card {string} of the bot {string} to the status {string} through the board service",
	async function (this: ChatticusWorld, botName: string, title: string, ownerBotName: string, status: string) {
		const scenario = boardScenarioOf(this);
		const card = cardNamed(scenario, ownerBotName, title);
		await record(
			this,
			await scenario.executor.updateCard(addressOfBoard(this, ownerBotName), botActor(this, botName), card.id, { status }, {
				operationKey: `cross/${title}`,
				revision: latestRevision(this, card.id),
			}),
		);
	},
);

When(
	"{string} creates a card titled {string} on the board of {string} through the board service",
	async function (this: ChatticusWorld, userId: string, title: string, botName: string) {
		const scenario = boardScenarioOf(this);
		const result = await scenario.frontDoor.createCard(addressOfBoard(this, botName), userActor(userId), { title }, { operationKey: `create/${userId}/${title}` });
		if (result.ok) rememberCard(scenario, botName, title, result.value.issue.id, result.value.revision);
		await record(this, result);
	},
);

When(
	"{string} comments {string} on the card {string} through the board service",
	async function (this: ChatticusWorld, userId: string, text: string, title: string) {
		const scenario = boardScenarioOf(this);
		const card = ownerBoardOf(this, title);
		const result = await scenario.frontDoor.commentOnCard(addressOfBoard(this, card.botName), userActor(userId), card.id, text, {
			operationKey: `comment/${userId}/${text}`,
			revision: latestRevision(this, card.id),
		});
		if (result.ok) noteRevision(scenario, card.id, result.value.revision);
		await record(this, result);
	},
);

When("{string} tries to delete the card {string} through the board service", async function (this: ChatticusWorld, userId: string, title: string) {
	const card = ownerBoardOf(this, title);
	await record(
		this,
		await boardScenarioOf(this).frontDoor.deleteCard(addressOfBoard(this, card.botName), userActor(userId), card.id, {
			operationKey: `delete/${userId}`,
			revision: latestRevision(this, card.id),
		}),
	);
});

When("the bot {string} tries to delete the card {string} through the board service", async function (this: ChatticusWorld, botName: string, title: string) {
	const card = ownerBoardOf(this, title);
	await record(
		this,
		await boardScenarioOf(this).executor.deleteCard(addressOfBoard(this, card.botName), botActor(this, botName), card.id, {
			operationKey: "bot-delete",
			revision: latestRevision(this, card.id),
		}),
	);
});

When("{string} deletes the card {string} expecting a stale revision through the board service", async function (this: ChatticusWorld, userId: string, title: string) {
	const scenario = boardScenarioOf(this);
	const card = ownerBoardOf(this, title);
	await ensureCommented(this, card);
	const seen = scenario.revisionsByCard.get(card.id) ?? [];
	await record(
		this,
		await scenario.frontDoor.deleteCard(addressOfBoard(this, card.botName), userActor(userId), card.id, {
			operationKey: `delete-stale/${userId}`,
			revision: seen[0]!,
		}),
	);
});

async function ensureCommented(world: ChatticusWorld, card: { botName: string; id: string }): Promise<void> {
	const scenario = boardScenarioOf(world);
	const seen = scenario.revisionsByCard.get(card.id) ?? [];
	if (seen.length >= 2) return;
	const commented = await scenario.executor.commentOnCard(addressOfBoard(world, card.botName), botActor(world, card.botName), card.id, "a later note", {
		operationKey: `later-note/${card.id}`,
		revision: seen[seen.length - 1]!,
	});
	assert.ok(commented.ok, JSON.stringify(commented));
	noteRevision(scenario, card.id, commented.value.revision);
}

When("{string} deletes the card {string} through the board service", async function (this: ChatticusWorld, userId: string, title: string) {
	const card = ownerBoardOf(this, title);
	await record(
		this,
		await boardScenarioOf(this).frontDoor.deleteCard(addressOfBoard(this, card.botName), userActor(userId), card.id, {
			operationKey: `delete-final/${userId}`,
			revision: latestRevision(this, card.id),
		}),
	);
});

When(
	"{string} tries to complete the card {string} without evidence through the board service",
	async function (this: ChatticusWorld, userId: string, title: string) {
		const card = ownerBoardOf(this, title);
		await record(
			this,
			await boardScenarioOf(this).frontDoor.completeCard(addressOfBoard(this, card.botName), userActor(userId), card.id, "", {
				operationKey: "complete-nothing",
			}),
		);
	},
);

When(
	"{string} closes the card {string} with the reason {string} through the board service",
	async function (this: ChatticusWorld, userId: string, title: string, reason: string) {
		const scenario = boardScenarioOf(this);
		const card = ownerBoardOf(this, title);
		const result = await scenario.frontDoor.closeCard(addressOfBoard(this, card.botName), userActor(userId), card.id, reason, {
			operationKey: `close/${userId}`,
			revision: latestRevision(this, card.id),
		});
		if (result.ok) noteRevision(scenario, card.id, result.value.revision);
		await record(this, result);
	},
);

When("{string} changes the role of {string} to {word}", async function (this: ChatticusWorld, actingUserId: string, memberId: string, role: string) {
	const bot = botNamed(this, "Assistant");
	await kernel.setMemberRole(bot.tenantId, actingUserId, memberId, role as MemberRole, { store: this.messagingStore() });
});

When("{string} archives the board of {string} through the board service", async function (this: ChatticusWorld, userId: string, botName: string) {
	await record(this, await boardScenarioOf(this).frontDoor.archiveBotBoard(addressOfBoard(this, botName), userActor(userId), "bot-deleted"));
});

Given("{string} archived the board of {string}", async function (this: ChatticusWorld, userId: string, botName: string) {
	const result = await boardScenarioOf(this).frontDoor.archiveBotBoard(addressOfBoard(this, botName), userActor(userId), "bot-deleted");
	assert.ok(result.ok, JSON.stringify(result));
});

When("{string} restores the board of {string} through the board service", async function (this: ChatticusWorld, userId: string, botName: string) {
	const scenario = boardScenarioOf(this);
	await record(this, await scenario.frontDoor.restoreBotBoard(addressOfBoard(this, botName), userActor(userId), `restore-${scenario.fake.requests.length}`));
});

When("31 days pass and the Kanbus sweeper runs", function (this: ChatticusWorld) {
	this.clock.advanceSeconds(31 * 86_400);
	boardScenarioOf(this).fake.sweep();
});

Then("the board service accepts the change", function (this: ChatticusWorld) {
	const result = boardScenarioOf(this).lastResult;
	assert.ok(result?.ok, JSON.stringify(result));
});

Then("the card {string} has the status {string}", function (this: ChatticusWorld, title: string, status: string) {
	assert.equal(storedCard(this, ownerBoardOf(this, title)).issue.status, status);
});

Then("the card {string} has no comments", function (this: ChatticusWorld, title: string) {
	assert.deepEqual(storedCard(this, ownerBoardOf(this, title)).issue.comments, []);
});

Then("the card {string} records the actor of {string} as its creator", function (this: ChatticusWorld, title: string, userId: string) {
	assert.equal(storedCard(this, ownerBoardOf(this, title)).issue.creator, `chatticus:user:${userId}`);
});

Then(
	"the card {string} has a comment by the actor of {string} with the text {string}",
	function (this: ChatticusWorld, title: string, userId: string, text: string) {
		const comments = storedCard(this, ownerBoardOf(this, title)).issue.comments as Array<{ author: string; text: string }>;
		assert.ok(comments.some((comment) => comment.author === `chatticus:user:${userId}` && comment.text === text), JSON.stringify(comments));
	},
);

Then("the card {string} is still on the board of {string}", function (this: ChatticusWorld, title: string, botName: string) {
	const bot = botNamed(this, botName);
	assert.ok(boardScenarioOf(this).fake.cardsOf(bot.tenantId, bot.botId).some((card) => card.title === title));
});

Then("the card {string} is no longer on the board of {string}", function (this: ChatticusWorld, title: string, botName: string) {
	const bot = botNamed(this, botName);
	assert.ok(!boardScenarioOf(this).fake.cardsOf(bot.tenantId, bot.botId).some((card) => card.title === title));
});

Then("the board service reports a conflict", function (this: ChatticusWorld) {
	const result = boardScenarioOf(this).lastResult;
	assert.ok(result && !result.ok, JSON.stringify(result));
	assert.equal(result.failure?.kind, "conflict");
});

Then("the board service refuses it for missing evidence", function (this: ChatticusWorld) {
	const result = boardScenarioOf(this).lastResult;
	assert.ok(result && !result.ok, JSON.stringify(result));
	assert.equal(result.failure?.kind, "refused");
	assert.equal(result.failure?.code, "evidence_required");
});

Then("the card {string} has a closing comment holding the text {string}", function (this: ChatticusWorld, title: string, text: string) {
	const comments = storedCard(this, ownerBoardOf(this, title)).issue.comments as Array<{ text: string }>;
	assert.ok(comments.at(-1)?.text.includes(text), JSON.stringify(comments));
});

Then("the card {string} records the closing {string}", function (this: ChatticusWorld, title: string, closing: string) {
	assert.equal(storedCard(this, ownerBoardOf(this, title)).issue.custom.closing, closing);
});

Then("the board service reports that the board was not found", function (this: ChatticusWorld) {
	const result = boardScenarioOf(this).lastResult;
	assert.ok(result && !result.ok, JSON.stringify(result));
	assert.equal(result.failure?.kind, "not_found");
});

Then("the board service reports that the board is archived", function (this: ChatticusWorld) {
	const result = boardScenarioOf(this).lastResult;
	assert.ok(result && !result.ok, JSON.stringify(result));
	assert.equal(result.failure?.kind, "archived");
});

Then("the board service refuses the restore because the board is not archived", function (this: ChatticusWorld) {
	const result = boardScenarioOf(this).lastResult;
	assert.ok(result && !result.ok, JSON.stringify(result));
	assert.equal(result.failure?.code, "board_not_archived");
});

Then("the board of {string} is archived with a purge date {int} days later", function (this: ChatticusWorld, botName: string, days: number) {
	const bot = botNamed(this, botName);
	const board = boardScenarioOf(this).fake.boards.get(`${bot.tenantId}/${bot.botId}`);
	assert.ok(board?.archivedAt && board.purgeAfter);
	assert.equal((board.purgeAfter.getTime() - board.archivedAt.getTime()) / 86_400_000, days);
});

Then("the board of {string} is purged by Kanbus", function (this: ChatticusWorld, botName: string) {
	const bot = botNamed(this, botName);
	assert.equal(boardScenarioOf(this).fake.boards.has(`${bot.tenantId}/${bot.botId}`), false);
});

Then("Chatticus made no purge call", function (this: ChatticusWorld) {
	assert.ok(!boardScenarioOf(this).fake.requests.some((request) => request.method === "DELETE" && request.path.endsWith("/api/board")));
});

export { tenantIdOfOrganization };
