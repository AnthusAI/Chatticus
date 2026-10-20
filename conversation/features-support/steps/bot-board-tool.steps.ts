import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { BOARD_TOOL_ACTIONS, BOARD_TOOL_NAME, runBoardToolCall, type BoardToolArguments } from "../../src/pi/bot-board-tool.ts";
import { modelScenarioOf, runBotTurn } from "../executor-harness.ts";
import {
	actorString,
	botActor,
	boardScenarioOf,
	botNamed,
	cardNamed,
	currentCardOf,
	ensureOrganizationUser,
	noteRevision,
	rememberCard,
	storedCard,
	userActor,
	type BoardToolCallRecord,
} from "../bot-board-support.ts";
import { openChannelWithNamedBot, post } from "./message.steps.ts";
import { currentTurnOf, readTurnEvents } from "./model.steps.ts";
import { createBotWithBoard, giveBotCard } from "./bot-board.steps.ts";
import { memberGet } from "../org-user-client.ts";
import { recordResponse } from "../api.ts";
import type { ChatticusWorld } from "../world.ts";

const HOUSEHOLD_USER = "ryan";
const OWNER_USER = "ryan";

async function callBoardTool(world: ChatticusWorld, botName: string, args: Record<string, unknown>): Promise<BoardToolCallRecord> {
	const bot = botNamed(world, botName);
	const scenario = boardScenarioOf(world);
	await openChannelWithNamedBot(world, bot.tenantId, HOUSEHOLD_USER, botName);
	await post(world, {
		authorKind: "human",
		authorId: HOUSEHOLD_USER,
		body: `Please use the board tool to ${String(args.action)}.`,
		addressedToBotId: bot.botId,
	});
	const requestCountBefore = scenario.fake.requests.length;
	modelScenarioOf(world).scripted.toolCall(BOARD_TOOL_NAME, args).reply("The board tool has answered.");
	assert.equal(await runBotTurn(world, botName), "done");
	const turnId = currentTurnOf(world);
	const events = await readTurnEvents(world, bot.tenantId, turnId);
	const call = events.find((event) => event.kind === "tool.call" && event.tool === BOARD_TOOL_NAME);
	assert.ok(call, "The turn did not call the board tool");
	const result = events.find((event) => event.kind === "tool.result" && event.call_id === call.call_id);
	assert.ok(result, "The board tool call has no result in the turn");
	const text = String(result.output);
	const record: BoardToolCallRecord = {
		text,
		parsed: JSON.parse(text) as Record<string, any>,
		isError: result.is_error === true,
		turnId,
		callId: String(call.call_id),
		tenantId: bot.tenantId,
		botId: bot.botId,
		events,
		requestCountBefore,
	};
	scenario.lastToolCall = record;
	const card = record.parsed.card as { id?: string; revision?: string } | undefined;
	if (card?.id !== undefined && card.revision !== undefined) noteRevision(scenario, card.id, card.revision);
	if (record.parsed.current_card?.id !== undefined) noteRevision(scenario, record.parsed.current_card.id, record.parsed.current_card.revision);
	return record;
}

function lastCall(world: ChatticusWorld): BoardToolCallRecord {
	const call = boardScenarioOf(world).lastToolCall;
	assert.ok(call, "The scenario has made no board tool call");
	return call;
}

function currentCard(world: ChatticusWorld): ReturnType<typeof currentCardOf> {
	return currentCardOf(boardScenarioOf(world));
}

function storedCurrent(world: ChatticusWorld): { issue: Record<string, any>; revision: string; writes: number } {
	return storedCard(world, currentCard(world));
}

function revisionNumber(world: ChatticusWorld, cardId: string, ordinal: number): string {
	const seen = boardScenarioOf(world).revisionsByCard.get(cardId) ?? [];
	const revision = seen[ordinal - 1];
	assert.ok(revision, `The scenario never saw revision ${ordinal} of the card (saw ${seen.length})`);
	return revision;
}

function addressOf(world: ChatticusWorld, botName: string): { organizationId: string; botId: string } {
	const bot = botNamed(world, botName);
	return { organizationId: bot.tenantId, botId: bot.botId };
}

async function ownerChangesTitle(world: ChatticusWorld, title: string, ordinal: number): Promise<void> {
	const scenario = boardScenarioOf(world);
	const card = currentCard(world);
	await ensureOrganizationUser(world, botNamed(world, card.botName).tenantId, OWNER_USER, "owner");
	const seen = scenario.revisionsByCard.get(card.id) ?? [];
	const changed = await scenario.frontDoor.updateCard(addressOf(world, card.botName), userActor(OWNER_USER), card.id, { title }, {
		operationKey: `owner-title/${card.id}/${ordinal}`,
		revision: seen[seen.length - 1]!,
	});
	assert.ok(changed.ok, JSON.stringify(changed));
	noteRevision(scenario, card.id, changed.value.revision);
	assert.equal((scenario.revisionsByCard.get(card.id) ?? []).length, ordinal);
}

async function bumpToRevision(world: ChatticusWorld, ordinal: number): Promise<void> {
	const scenario = boardScenarioOf(world);
	const card = currentCard(world);
	await ensureOrganizationUser(world, botNamed(world, card.botName).tenantId, OWNER_USER, "owner");
	for (;;) {
		const seen = scenario.revisionsByCard.get(card.id) ?? [];
		if (seen.length >= ordinal) return;
		const commented = await scenario.frontDoor.commentOnCard(addressOf(world, card.botName), userActor(OWNER_USER), card.id, `note ${seen.length}`, {
			operationKey: `bump/${card.id}/${seen.length}`,
			revision: seen[seen.length - 1]!,
		});
		assert.ok(commented.ok, JSON.stringify(commented));
		noteRevision(scenario, card.id, commented.value.revision);
	}
}

Given("the bot {string} has a card titled {string}", async function (this: ChatticusWorld, botName: string, title: string) {
	await giveBotCard(this, botName, title);
});

Given("the bot {string} has the cards {string} and {string}", async function (this: ChatticusWorld, botName: string, first: string, second: string) {
	await giveBotCard(this, botName, first);
	await giveBotCard(this, botName, second);
});

Given("the bot {string} in the same organization has the card {string}", async function (this: ChatticusWorld, botName: string, title: string) {
	if (this.botsByName?.get(botName) === undefined) {
		const tenantId = boardScenarioOf(this).defaultTenantId;
		assert.ok(tenantId, "The scenario has no organization yet");
		await createBotWithBoard(this, tenantId, botName);
	}
	await giveBotCard(this, botName, title);
});

Given("the bot {string} in the same organization has a card titled {string}", async function (this: ChatticusWorld, botName: string, title: string) {
	if (this.botsByName?.get(botName) === undefined) {
		const tenantId = boardScenarioOf(this).defaultTenantId;
		assert.ok(tenantId, "The scenario has no organization yet");
		await createBotWithBoard(this, tenantId, botName);
	}
	await giveBotCard(this, botName, title);
});

Given(
	"the bot {string} has a card titled {string} with the status {string}",
	async function (this: ChatticusWorld, botName: string, title: string, status: string) {
		await giveBotCard(this, botName, title, { status });
	},
);

Given(
	"the bot {string} has a card titled {string} that also carries an extra field written by another Kanbus tool",
	async function (this: ChatticusWorld, botName: string, title: string) {
		const id = await giveBotCard(this, botName, title);
		const bot = botNamed(this, botName);
		boardScenarioOf(this).fake.writeFieldBehindTheApi(bot.tenantId, bot.botId, id, "x_other_tool", "original value");
	},
);

Given("the bot {string} has a closed card titled {string}", async function (this: ChatticusWorld, botName: string, title: string) {
	await giveBotCard(this, botName, title, { status: "closed" });
});

Given("the bot {string} has an epic titled {string}", async function (this: ChatticusWorld, botName: string, title: string) {
	await giveBotCard(this, botName, title, { type: "epic" });
});

Given("the bot {string} has the epics {string} and {string}", async function (this: ChatticusWorld, botName: string, first: string, second: string) {
	await giveBotCard(this, botName, first, { type: "epic" });
	await giveBotCard(this, botName, second, { type: "epic" });
});

Given(
	"the bot {string} has a card titled {string} under the epic {string}",
	async function (this: ChatticusWorld, botName: string, title: string, epicTitle: string) {
		await giveBotCard(this, botName, title, { parent: cardNamed(boardScenarioOf(this), botName, epicTitle).id });
	},
);

Given(
	"the bot {string} has a card titled {string} at revision {int}",
	async function (this: ChatticusWorld, botName: string, title: string, ordinal: number) {
		await giveBotCard(this, botName, title);
		await bumpToRevision(this, ordinal);
	},
);

Given(
	"an organization owner changes the title of the card to {string} so that it is at revision {int}",
	async function (this: ChatticusWorld, title: string, ordinal: number) {
		await ownerChangesTitle(this, title, ordinal);
	},
);

Given(
	"the bot {string} creates a card titled {string} with the operation id {string}",
	async function (this: ChatticusWorld, botName: string, title: string, operationKey: string) {
		const scenario = boardScenarioOf(this);
		scenario.pendingOperationKey = operationKey;
		scenario.lastResult = await scenario.executor.createCard(addressOf(this, botName), botActor(this, botName), { title }, { operationKey });
	},
);

Given(
	"the bot {string} moved the card to the status {string} with the operation id {string}",
	async function (this: ChatticusWorld, botName: string, status: string, operationKey: string) {
		const scenario = boardScenarioOf(this);
		const card = currentCard(this);
		const seen = scenario.revisionsByCard.get(card.id) ?? [];
		const moved = await scenario.executor.updateCard(addressOf(this, botName), botActor(this, botName), card.id, { status }, {
			operationKey,
			revision: seen[seen.length - 1]!,
		});
		assert.ok(moved.ok, JSON.stringify(moved));
		noteRevision(scenario, card.id, moved.value.revision);
		scenario.writesBeforeRepeat = storedCurrent(this).writes;
	},
);

Given(
	"the bot {string} runs a turn that creates the card {string} and then the worker is interrupted",
	async function (this: ChatticusWorld, botName: string, title: string) {
		await callBoardTool(this, botName, { action: "create", title });
	},
);

When("the worker retries the same tool call of that turn", async function (this: ChatticusWorld) {
	const scenario = boardScenarioOf(this);
	const first = lastCall(this);
	const retried = await runBoardToolCall(
		{ organizationId: first.tenantId, botId: first.botId, turnId: first.turnId },
		scenario.executor,
		{ action: "create", title: String(first.parsed.card.title) } as BoardToolArguments,
		first.callId,
	);
	const parsed = JSON.parse(retried.text) as Record<string, any>;
	assert.equal(parsed.outcome, "saved", retried.text);
	assert.equal(parsed.card.id, first.parsed.card.id);
});

When("the bot {string} repeats the same creation with the operation id {string}", async function (this: ChatticusWorld, botName: string, operationKey: string) {
	const scenario = boardScenarioOf(this);
	const title = scenario.fake.cardsOf(botNamed(this, botName).tenantId, botNamed(this, botName).botId)[0]?.title;
	assert.ok(title, "No card was stored by the first creation");
	scenario.lastResult = await scenario.executor.createCard(addressOf(this, botName), botActor(this, botName), { title: String(title) }, { operationKey });
});

When(
	"the bot {string} repeats the same move with the operation id {string}",
	async function (this: ChatticusWorld, botName: string, operationKey: string) {
		const card = currentCard(this);
		const first = (boardScenarioOf(this).revisionsByCard.get(card.id) ?? [])[0]!;
		await callBoardTool(this, botName, { action: "update", card_id: card.id, status: "in_progress", revision: first, operation_key: operationKey });
	},
);

When(
	"the bot {string} uses operation id {string} to move the card to the status {string}",
	async function (this: ChatticusWorld, botName: string, operationKey: string, status: string) {
		await callBoardTool(this, botName, { action: "update", card_id: currentCard(this).id, status, operation_key: operationKey });
	},
);

When("the bot {string} uses the board tool to create a card titled {string}", async function (this: ChatticusWorld, botName: string, title: string) {
	const call = await callBoardTool(this, botName, { action: "create", title });
	const card = call.parsed.card as { id?: string; revision?: string } | undefined;
	if (card?.id !== undefined) rememberCard(boardScenarioOf(this), botName, title, card.id, card.revision!);
});

When(
	"the bot {string} uses the board tool to create a card titled {string} with the type {string}",
	async function (this: ChatticusWorld, botName: string, title: string, type: string) {
		await callBoardTool(this, botName, { action: "create", title, type });
	},
);

When("the bot {string} uses the board tool to create a card with an empty title", async function (this: ChatticusWorld, botName: string) {
	await callBoardTool(this, botName, { action: "create", title: "" });
});

When("the bot {string} uses the board tool to read that card", async function (this: ChatticusWorld, botName: string) {
	await callBoardTool(this, botName, { action: "get", card_id: currentCard(this).id });
});

When("the bot {string} uses the board tool to read the card {string}", async function (this: ChatticusWorld, botName: string, cardId: string) {
	await callBoardTool(this, botName, { action: "get", card_id: cardId });
});

When("the bot {string} uses the board tool to read the card of {string}", async function (this: ChatticusWorld, botName: string, otherName: string) {
	const other = [...boardScenarioOf(this).cardsByKey.values()].find((card) => card.botName === otherName);
	assert.ok(other, `${otherName} has no card`);
	await callBoardTool(this, botName, { action: "get", card_id: other.id });
});

When("the bot {string} uses the board tool to list its board", async function (this: ChatticusWorld, botName: string) {
	await callBoardTool(this, botName, { action: "list" });
});

When("the bot {string} uses the board tool to read its board", async function (this: ChatticusWorld, botName: string) {
	await callBoardTool(this, botName, { action: "list" });
});

When("the bot {string} uses the board tool and names the board of {string}", async function (this: ChatticusWorld, botName: string, otherName: string) {
	const other = botNamed(this, otherName);
	await callBoardTool(this, botName, { action: "list", board: other.botId, bot_id: other.botId, organization_id: other.tenantId });
});

When(
	"the bot {string} uses the board tool to move the card to the status {string}",
	async function (this: ChatticusWorld, botName: string, status: string) {
		await callBoardTool(this, botName, { action: "update", card_id: currentCard(this).id, status });
	},
);

When(
	"the bot {string} uses the board tool to move the card to the status {string} expecting revision {int}",
	async function (this: ChatticusWorld, botName: string, status: string, ordinal: number) {
		const card = currentCard(this);
		await callBoardTool(this, botName, { action: "update", card_id: card.id, status, revision: revisionNumber(this, card.id, ordinal) });
	},
);

When(
	"the bot {string} uses the board tool to move the card to the status {string} without naming a revision",
	async function (this: ChatticusWorld, botName: string, status: string) {
		await callBoardTool(this, botName, { action: "update", card_id: currentCard(this).id, status });
	},
);

When(
	"the bot {string} uses the board tool to move the card of {string} to the status {string}",
	async function (this: ChatticusWorld, botName: string, otherName: string, status: string) {
		const other = [...boardScenarioOf(this).cardsByKey.values()].find((card) => card.botName === otherName);
		assert.ok(other, `${otherName} has no card`);
		await callBoardTool(this, botName, { action: "update", card_id: other.id, status });
	},
);

When(
	"the bot {string} uses the board tool to comment {string} on the card",
	async function (this: ChatticusWorld, botName: string, text: string) {
		await callBoardTool(this, botName, { action: "comment", card_id: currentCard(this).id, text });
	},
);

When(
	"the bot {string} uses the board tool to update the card with the priority {int} and the label {string}",
	async function (this: ChatticusWorld, botName: string, priority: number, label: string) {
		await callBoardTool(this, botName, { action: "update", card_id: currentCard(this).id, priority, labels: [label] });
	},
);

When("the bot {string} uses the board tool to reopen the card", async function (this: ChatticusWorld, botName: string) {
	await callBoardTool(this, botName, { action: "reopen", card_id: currentCard(this).id });
});

When("the bot {string} tries to complete the card without evidence", async function (this: ChatticusWorld, botName: string) {
	await callBoardTool(this, botName, { action: "complete", card_id: currentCard(this).id });
});

When("the bot {string} tries to complete the card with the evidence {string}", async function (this: ChatticusWorld, botName: string, evidence: string) {
	await callBoardTool(this, botName, { action: "complete", card_id: currentCard(this).id, evidence });
});

When("the bot {string} completes the card with the evidence {string}", async function (this: ChatticusWorld, botName: string, evidence: string) {
	await callBoardTool(this, botName, { action: "complete", card_id: currentCard(this).id, evidence });
});

When("the bot {string} closes the card with the reason {string}", async function (this: ChatticusWorld, botName: string, reason: string) {
	await callBoardTool(this, botName, { action: "close", card_id: currentCard(this).id, reason });
});

When("the bot {string} tries to close the card without a reason", async function (this: ChatticusWorld, botName: string) {
	await callBoardTool(this, botName, { action: "close", card_id: currentCard(this).id });
});

When("the bot {string} tries to delete the card through the board service", async function (this: ChatticusWorld, botName: string) {
	const scenario = boardScenarioOf(this);
	const card = currentCard(this);
	const seen = scenario.revisionsByCard.get(card.id) ?? [];
	scenario.lastResult = await scenario.executor.deleteCard(addressOf(this, botName), botActor(this, botName), card.id, {
		operationKey: "bot-delete",
		revision: seen[seen.length - 1]!,
	});
});

When("the bot {string} uses the board tool to move the card under the epic", async function (this: ChatticusWorld, botName: string) {
	const epic = [...boardScenarioOf(this).cardsByKey.values()].find((card) => card.title === "Household finances");
	assert.ok(epic);
	await callBoardTool(this, botName, { action: "set_parent", card_id: currentCard(this).id, parent_id: epic.id });
});

When(
	"the bot {string} uses the board tool to move the card under the epic {string}",
	async function (this: ChatticusWorld, botName: string, epicTitle: string) {
		await callBoardTool(this, botName, {
			action: "set_parent",
			card_id: currentCard(this).id,
			parent_id: cardNamed(boardScenarioOf(this), botName, epicTitle).id,
		});
	},
);

When("the bot {string} uses the board tool to remove the parent of the card", async function (this: ChatticusWorld, botName: string) {
	await callBoardTool(this, botName, { action: "set_parent", card_id: currentCard(this).id });
});

When(
	"the bot {string} uses the board tool to move the card under the card {string}",
	async function (this: ChatticusWorld, botName: string, parentId: string) {
		await callBoardTool(this, botName, { action: "set_parent", card_id: currentCard(this).id, parent_id: parentId });
	},
);

When("the bot {string} uses the board tool to move the card under a card of the same level", async function (this: ChatticusWorld, botName: string) {
	const subject = currentCard(this);
	const sibling = await giveBotCard(this, botName, "A card of the same level");
	boardScenarioOf(this).currentCard = subject;
	await callBoardTool(this, botName, { action: "set_parent", card_id: subject.id, parent_id: sibling });
});

When(
	"the bot {string} uses the board tool to record that {string} depends on {string}",
	async function (this: ChatticusWorld, botName: string, title: string, targetTitle: string) {
		const scenario = boardScenarioOf(this);
		await callBoardTool(this, botName, {
			action: "add_dependency",
			card_id: cardNamed(scenario, botName, title).id,
			depends_on_id: cardNamed(scenario, botName, targetTitle).id,
		});
	},
);

When(
	"the bot {string} uses the board tool to record that the card depends on {string}",
	async function (this: ChatticusWorld, botName: string, targetId: string) {
		await callBoardTool(this, botName, { action: "add_dependency", card_id: currentCard(this).id, depends_on_id: targetId });
	},
);

When("an organization owner deletes the card expecting revision {int}", async function (this: ChatticusWorld, ordinal: number) {
	const scenario = boardScenarioOf(this);
	const card = currentCard(this);
	await ensureOrganizationUser(this, botNamed(this, card.botName).tenantId, OWNER_USER, "owner");
	scenario.lastResult = await scenario.frontDoor.deleteCard(addressOf(this, card.botName), userActor(OWNER_USER), card.id, {
		operationKey: `owner-delete/${ordinal}`,
		revision: revisionNumber(this, card.id, ordinal),
	});
});

When("the bot {string} receives {string}", async function (this: ChatticusWorld, botName: string, message: string) {
	const bot = botNamed(this, botName);
	await openChannelWithNamedBot(this, bot.tenantId, HOUSEHOLD_USER, botName);
	await post(this, { authorKind: "human", authorId: HOUSEHOLD_USER, body: message, addressedToBotId: bot.botId });
	boardScenarioOf(this).receivedMessage = message;
});

When("the bot {string} runs one computerless worker turn", async function (this: ChatticusWorld, botName: string) {
	const scenario = boardScenarioOf(this);
	const message = scenario.receivedMessage;
	assert.ok(message, "The bot has received no message");
	const title = /titled (.+)$/.exec(message)?.[1];
	assert.ok(title, `The message names no card title: ${message}`);
	const bot = botNamed(this, botName);
	const requestCountBefore = scenario.fake.requests.length;
	modelScenarioOf(this).scripted.toolCall(BOARD_TOOL_NAME, { action: "create", title }).reply("The board tool has answered.");
	assert.equal(await runBotTurn(this, botName), "done");
	const turnId = currentTurnOf(this);
	const events = await readTurnEvents(this, bot.tenantId, turnId);
	const call = events.find((event) => event.kind === "tool.call" && event.tool === BOARD_TOOL_NAME);
	assert.ok(call, "The turn did not call the board tool");
	const result = events.find((event) => event.kind === "tool.result" && event.call_id === call.call_id);
	assert.ok(result, "The board tool call has no result in the turn");
	const text = String(result.output);
	scenario.lastToolCall = {
		text,
		parsed: JSON.parse(text) as Record<string, any>,
		isError: result.is_error === true,
		turnId,
		callId: String(call.call_id),
		tenantId: bot.tenantId,
		botId: bot.botId,
		events,
		requestCountBefore,
	};
	const card = scenario.lastToolCall.parsed.card as { id?: string; revision?: string } | undefined;
	if (card?.id !== undefined) rememberCard(scenario, botName, title, card.id, card.revision!);
});

Then("the configuration of the board is exactly what Kanbus writes for a new project", async function (this: ChatticusWorld) {
	const scenario = boardScenarioOf(this);
	const write = scenario.fake.requests.filter((request) => request.method === "PUT").at(-1);
	assert.ok(write, "No configuration was written");
	const configPath = write.path;
	const read = await scenario.fake.fetch(`https://kanbus.scenario.invalid${configPath}`, {
		method: "GET",
		headers: { authorization: "AWS4-HMAC-SHA256 Credential=scenario-front-door-key/20260101/us-east-1/execute-api/aws4_request", "x-kanbus-actor": "chatticus:system:scenario" },
	});
	const configuration = (await read.json()) as Record<string, any>;
	assert.equal(configuration.project_key, "kanbus");
	assert.deepEqual(configuration.hierarchy, ["initiative", "epic", "task", "sub-task"]);
	assert.equal(configuration.initial_status, "open");
});

Then("Chatticus supplied no status list", function (this: ChatticusWorld) {
	const scenario = boardScenarioOf(this);
	for (const request of scenario.fake.requests.filter((candidate) => candidate.method === "PUT")) {
		assert.equal(request.bodyText, "", "Chatticus sent a configuration body");
	}
});

Then(
	"the board of {string} accepts the statuses {string}, {string}, {string}, {string} and {string}",
	async function (this: ChatticusWorld, botName: string, first: string, second: string, third: string, fourth: string, fifth: string) {
		const statuses = [first, second, third, fourth, fifth];
		const bot = botNamed(this, botName);
		const scenario = boardScenarioOf(this);
		const read = await scenario.fake.fetch(`https://kanbus.scenario.invalid/${bot.tenantId}/${bot.botId}/api/config`, {
			method: "GET",
			headers: { authorization: "AWS4-HMAC-SHA256 Credential=scenario-executor-key/20260101/us-east-1/execute-api/aws4_request", "x-kanbus-actor": `chatticus:bot:${bot.botId}` },
		});
		const configuration = (await read.json()) as { statuses: Array<{ key: string }> };
		assert.deepEqual(configuration.statuses.map((status) => status.key), statuses);
	},
);

Then("the card is on the board of {string}", function (this: ChatticusWorld, botName: string) {
	const bot = botNamed(this, botName);
	const card = boardScenarioOf(this).lastToolCall?.parsed.card;
	const target = card === undefined ? currentCard(this) : { id: card.id as string };
	const stored = boardScenarioOf(this).fake.peek(bot.tenantId, bot.botId, target.id);
	assert.ok(stored, `The board of ${botName} has no such card`);
	rememberCard(boardScenarioOf(this), botName, String(stored.issue.title), target.id, stored.revision);
});

Then("the card has the status {string}", function (this: ChatticusWorld, status: string) {
	assert.equal(storedCurrent(this).issue.status, status);
});

Then("the card still has the status {string}", function (this: ChatticusWorld, status: string) {
	assert.equal(storedCurrent(this).issue.status, status);
});

Then("the card has a newer updated time", function (this: ChatticusWorld) {
	const { issue } = storedCurrent(this);
	assert.ok(Date.parse(issue.updated_at) > Date.parse(issue.created_at), `${issue.updated_at} is not after ${issue.created_at}`);
});

Then("the card records {string} as its creator", function (this: ChatticusWorld, botName: string) {
	assert.equal(storedCurrent(this).issue.creator, actorString(this, { bot: botName }));
});

Then("the store recorded the actor {string} followed by the identifier of {string}", function (this: ChatticusWorld, prefix: string, name: string) {
	const scenario = boardScenarioOf(this);
	const identifier = this.botsByName?.get(name)?.botId ?? name;
	const expected = `${prefix}${identifier}`;
	const writes = scenario.fake.requests.filter((request) => request.method !== "GET" && request.status >= 200 && request.status < 300);
	assert.ok(writes.some((request) => request.actor === expected), `No successful write named the actor ${expected}`);
});

Then("the board tool reports the card as saved", function (this: ChatticusWorld) {
	const parsed = lastCall(this).parsed;
	assert.equal(parsed.outcome, "saved", lastCall(this).text);
	assert.equal(parsed.saved, true);
});

Then("no computer was summoned for the board tool", async function (this: ChatticusWorld) {
	const scenario = boardScenarioOf(this);
	const atStop = scenario.computerAtStop as { tenantId: string } | null;
	assert.ok(atStop, "The scenario never stopped the computer");
	const computer = await this.messagingStore().getComputer(atStop.tenantId);
	assert.deepEqual(computer, atStop);
	const turn = await recordResponse(await memberGet(this, `/orgs/${atStop.tenantId}/turns/${lastCall(this).turnId}`));
	assert.equal(turn.status, 200, turn.text);
	assert.equal(turn.json.status, "completed");
	assert.equal(turn.json.waiting_for ?? null, null);
});

Then("the card has an id made of the board's project key, a dash and a version 4 identifier", function (this: ChatticusWorld) {
	assert.match(storedCurrent(this).issue.id, /^kanbus-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

Then("the card has a title, a description, a type, a status, a priority, an assignee and a creator", function (this: ChatticusWorld) {
	const { issue } = storedCurrent(this);
	for (const field of ["title", "description", "type", "status", "priority", "assignee", "creator"]) assert.ok(field in issue, `The card has no ${field}`);
	assert.equal(typeof issue.priority, "number");
});

Then("the card has a created time and an updated time in UTC with milliseconds", function (this: ChatticusWorld) {
	const { issue } = storedCurrent(this);
	assert.match(issue.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	assert.match(issue.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

Then("the card has no closing time", function (this: ChatticusWorld) {
	assert.equal(storedCurrent(this).issue.closed_at, null);
});

Then("the card has empty labels, dependencies and comments", function (this: ChatticusWorld) {
	const { issue } = storedCurrent(this);
	assert.deepEqual(issue.labels, []);
	assert.deepEqual(issue.dependencies, []);
	assert.deepEqual(issue.comments, []);
});

Then("the board tool returns the card with its title, status, priority, comments and revision", function (this: ChatticusWorld) {
	const { parsed } = lastCall(this);
	assert.equal(parsed.outcome, "ok");
	for (const field of ["title", "status", "priority", "comments", "revision"]) assert.ok(field in parsed.card, `The card has no ${field}`);
	assert.equal(parsed.card.title, currentCard(this).title);
});

Then("the board tool lists {string} and {string}", function (this: ChatticusWorld, first: string, second: string) {
	const titles = (lastCall(this).parsed.cards as Array<{ title: string }>).map((card) => card.title);
	assert.ok(titles.includes(first) && titles.includes(second), `Listed: ${titles.join(", ")}`);
});

Then("the board tool lists {string}", function (this: ChatticusWorld, title: string) {
	const titles = (lastCall(this).parsed.cards as Array<{ title: string }>).map((card) => card.title);
	assert.ok(titles.includes(title), `Listed: ${titles.join(", ")}`);
});

Then("the board tool does not list {string}", function (this: ChatticusWorld, title: string) {
	const titles = (lastCall(this).parsed.cards as Array<{ title: string }>).map((card) => card.title);
	assert.ok(!titles.includes(title), `Listed: ${titles.join(", ")}`);
});

Then("the card has one comment by {string} with the text {string}", function (this: ChatticusWorld, botName: string, text: string) {
	const { issue } = storedCurrent(this);
	assert.equal(issue.comments.length, 1);
	assert.equal(issue.comments[0].author, actorString(this, { bot: botName }));
	assert.equal(issue.comments[0].text, text);
});

Then("the comment has an identifier and a created time", function (this: ChatticusWorld) {
	const [comment] = storedCurrent(this).issue.comments;
	assert.match(comment.id, /^[0-9a-f-]{36}$/);
	assert.match(comment.created_at, /^\d{4}-\d{2}-\d{2}T/);
});

Then("the card has the priority {int}", function (this: ChatticusWorld, priority: number) {
	assert.equal(storedCurrent(this).issue.priority, priority);
});

Then("the card has the label {string}", function (this: ChatticusWorld, label: string) {
	assert.ok((storedCurrent(this).issue.labels as string[]).includes(label));
});

Then("the extra field is still on the card with its original value", function (this: ChatticusWorld) {
	assert.equal(storedCurrent(this).issue.x_other_tool, "original value");
});

Then("completing the card is refused for missing evidence", function (this: ChatticusWorld) {
	const { parsed } = lastCall(this);
	assert.equal(parsed.outcome, "refused", lastCall(this).text);
	assert.equal(parsed.code, "evidence_required");
	assert.equal(parsed.saved, false);
});

Then("closing the card is refused for missing reason", function (this: ChatticusWorld) {
	const { parsed } = lastCall(this);
	assert.equal(parsed.outcome, "refused", lastCall(this).text);
	assert.equal(parsed.code, "reason_required");
});

Then("the card has a closing time", function (this: ChatticusWorld) {
	assert.match(String(storedCurrent(this).issue.closed_at), /^\d{4}-\d{2}-\d{2}T/);
});

Then("the card has a closing comment holding the evidence {string}", function (this: ChatticusWorld, evidence: string) {
	const comments = storedCurrent(this).issue.comments as Array<{ text: string }>;
	assert.ok(comments.at(-1)?.text.includes(evidence), JSON.stringify(comments));
});

Then("the card has a closing comment holding the reason {string}", function (this: ChatticusWorld, reason: string) {
	const comments = storedCurrent(this).issue.comments as Array<{ text: string }>;
	assert.ok(comments.at(-1)?.text.includes(reason), JSON.stringify(comments));
});

Then("the card records the closing {string}", function (this: ChatticusWorld, closing: string) {
	assert.equal(storedCurrent(this).issue.custom.closing, closing);
});

Then("the move is refused because a closed card needs evidence or a reason", function (this: ChatticusWorld) {
	const { parsed } = lastCall(this);
	assert.equal(parsed.outcome, "refused", lastCall(this).text);
	assert.equal(parsed.code, "closing_needs_evidence_or_reason");
});

Then("the card is not closed", function (this: ChatticusWorld) {
	const { issue } = storedCurrent(this);
	assert.notEqual(issue.status, "closed");
	assert.equal(issue.closed_at, null);
});

Then("the board tool has no delete action", function () {
	assert.ok(!(BOARD_TOOL_ACTIONS as readonly string[]).includes("delete"));
});

Then("the board service refuses it as forbidden", function (this: ChatticusWorld) {
	const result = boardScenarioOf(this).lastResult;
	assert.ok(result && !result.ok, JSON.stringify(result));
	assert.equal(result.failure?.kind, "forbidden");
});

Then("the card is still on the board", function (this: ChatticusWorld) {
	assert.ok(storedCurrent(this));
});

Then("the board tool reports a validation failure naming the {word}", function (this: ChatticusWorld, field: string) {
	const { parsed } = lastCall(this);
	assert.equal(parsed.outcome, "validation_failed", lastCall(this).text);
	assert.ok(String(parsed.message).toLowerCase().includes(field), parsed.message);
});

Then("the board tool reports a validation failure naming the parent hierarchy", function (this: ChatticusWorld) {
	const { parsed } = lastCall(this);
	assert.equal(parsed.outcome, "validation_failed", lastCall(this).text);
	assert.equal(parsed.code, "hierarchy_violation");
});

Then("the board of {string} has no card titled {string}", function (this: ChatticusWorld, botName: string, title: string) {
	const bot = botNamed(this, botName);
	assert.ok(!boardScenarioOf(this).fake.cardsOf(bot.tenantId, bot.botId).some((card) => card.title === title));
});

Then("the board tool reports that the card was not found", function (this: ChatticusWorld) {
	const { parsed } = lastCall(this);
	assert.equal(parsed.outcome, "not_found", lastCall(this).text);
});

Then("no card content is returned", function (this: ChatticusWorld) {
	const { parsed } = lastCall(this);
	assert.equal(parsed.card, undefined);
	assert.equal(parsed.cards, undefined);
	assert.ok(!lastCall(this).text.includes("Pay the electric bill"));
});

Then("the card has the epic as its parent", function (this: ChatticusWorld) {
	const epic = [...boardScenarioOf(this).cardsByKey.values()].find((card) => card.title === "Household finances");
	assert.equal(storedCurrent(this).issue.parent, epic?.id);
});

Then("the card has the epic {string} as its parent", function (this: ChatticusWorld, epicTitle: string) {
	assert.equal(storedCurrent(this).issue.parent, cardNamed(boardScenarioOf(this), currentCard(this).botName, epicTitle).id);
});

Then("the card has no parent", function (this: ChatticusWorld) {
	assert.equal(storedCurrent(this).issue.parent, null);
});

Then("the card {string} lists a dependency on {string}", function (this: ChatticusWorld, title: string, targetTitle: string) {
	const scenario = boardScenarioOf(this);
	const botName = currentCard(this).botName;
	const dependencies = storedCard(this, cardNamed(scenario, botName, title)).issue.dependencies as Array<{ target: string }>;
	assert.ok(dependencies.some((entry) => entry.target === cardNamed(scenario, botName, targetTitle).id), JSON.stringify(dependencies));
});

Then("the board tool reports a conflict", function (this: ChatticusWorld) {
	assert.equal(lastCall(this).parsed.outcome, "conflict", lastCall(this).text);
});

Then("the conflict names the current revision {int}", function (this: ChatticusWorld, ordinal: number) {
	assert.equal(lastCall(this).parsed.current_revision, revisionNumber(this, currentCard(this).id, ordinal));
});

Then("the card keeps the title {string} and the status {string}", function (this: ChatticusWorld, title: string, status: string) {
	const { issue } = storedCurrent(this);
	assert.equal(issue.title, title);
	assert.equal(issue.status, status);
});

Then("the card keeps the title {string}", function (this: ChatticusWorld, title: string) {
	assert.equal(storedCurrent(this).issue.title, title);
});

Then("the board tool reads the card and applies the change to the revision it read", function (this: ChatticusWorld) {
	const call = lastCall(this);
	const requests = boardScenarioOf(this).fake.requests.slice(call.requestCountBefore);
	const read = requests.findIndex((request) => request.method === "GET" && /\/issues\/[^/]+$/.test(request.path));
	const write = requests.findIndex((request) => request.method === "PATCH");
	assert.ok(read >= 0 && write > read, "The board tool did not read the card before it wrote");
	assert.equal(requests[write]!.status, 200);
	assert.match(requests[write]!.ifMatch ?? "", /^revision-\d+$/);
});

Then("the deletion is a conflict", function (this: ChatticusWorld) {
	const result = boardScenarioOf(this).lastResult;
	assert.ok(result && !result.ok, JSON.stringify(result));
	assert.equal(result.failure?.kind, "conflict");
});

Then("the card is no longer on the board", function (this: ChatticusWorld) {
	const card = currentCard(this);
	const bot = botNamed(this, card.botName);
	assert.equal(boardScenarioOf(this).fake.peek(bot.tenantId, bot.botId, card.id), null);
});

Then("the board of {string} has exactly one card titled {string}", function (this: ChatticusWorld, botName: string, title: string) {
	const bot = botNamed(this, botName);
	const matching = boardScenarioOf(this).fake.cardsOf(bot.tenantId, bot.botId).filter((card) => card.title === title);
	assert.equal(matching.length, 1);
});

Then("the repeated call returns the card the first call stored", function (this: ChatticusWorld) {
	const scenario = boardScenarioOf(this);
	const result = scenario.lastResult;
	assert.ok(result?.ok, JSON.stringify(result));
	const stored = scenario.fake.cardsOf(botNamed(this, "Assistant").tenantId, botNamed(this, "Assistant").botId);
	assert.equal(stored.length, 1);
	assert.equal(result.value.issue.id, stored[0]!.id);
});

Then("the card was written once", function (this: ChatticusWorld) {
	assert.equal(storedCurrent(this).writes, boardScenarioOf(this).writesBeforeRepeat);
});

Then("the board tool reports that the operation id was used for a different change", function (this: ChatticusWorld) {
	assert.equal(lastCall(this).parsed.outcome, "operation_conflict", lastCall(this).text);
});

Then("the board tool says the card is saved only after the cloud store confirmed the record", function (this: ChatticusWorld) {
	const { parsed } = lastCall(this);
	assert.equal(parsed.saved, true);
	const stored = boardScenarioOf(this).fake.peek(lastCall(this).tenantId, lastCall(this).botId, parsed.card.id);
	assert.ok(stored, "The store has no such record");
	assert.equal(parsed.card.revision, stored.revision);
});

Then("the transcript does not say the card is saved before that confirmation", function (this: ChatticusWorld) {
	const events = lastCall(this).events;
	const resultIndex = events.findIndex((event) => event.kind === "tool.result");
	assert.ok(resultIndex >= 0);
	for (const event of events.slice(0, resultIndex)) {
		assert.ok(!JSON.stringify(event).toLowerCase().includes("saved"), `Before the store answered: ${JSON.stringify(event)}`);
	}
});

Then("the board tool reports that the card was not saved", function (this: ChatticusWorld) {
	const { parsed } = lastCall(this);
	assert.equal(parsed.outcome, "not_saved", lastCall(this).text);
	assert.equal(parsed.saved, false);
});

Then("the board tool says the change may be retried with the same operation id", function (this: ChatticusWorld) {
	const { parsed } = lastCall(this);
	assert.ok(typeof parsed.operation_key === "string" && parsed.operation_key !== "");
	assert.match(String(parsed.message), /operation_key/);
});

Then("no board tool result in the turn says the card was saved", function (this: ChatticusWorld) {
	for (const event of lastCall(this).events.filter((candidate) => candidate.kind === "tool.result")) {
		assert.ok(!String(event.output).includes('"saved":true'), String(event.output));
	}
});

Then("the turn finishes", function (this: ChatticusWorld) {
	assert.equal(modelScenarioOf(this).outcomes.at(-1), "done");
});

Then("the board tool says the card is saved and that the listing may be behind", function (this: ChatticusWorld) {
	const { parsed } = lastCall(this);
	assert.equal(parsed.outcome, "saved", lastCall(this).text);
	assert.equal(parsed.listing_may_be_behind, true);
	assert.match(String(parsed.message), /listing of the board may be behind/);
});

Then("reading that card by its id returns the saved card", async function (this: ChatticusWorld) {
	const first = lastCall(this).parsed.card;
	const bot = botNamed(this, "Assistant");
	await callBoardTool(this, "Assistant", { action: "get", card_id: first.id });
	assert.equal(lastCall(this).parsed.card.title, first.title);
	assert.ok(boardScenarioOf(this).fake.peek(bot.tenantId, bot.botId, first.id));
});

Then("the card of {string} is unchanged", function (this: ChatticusWorld, botName: string) {
	const card = [...boardScenarioOf(this).cardsByKey.values()].find((candidate) => candidate.botName === botName);
	assert.ok(card);
	assert.equal(storedCard(this, card).issue.status, "open");
});

Then("the board tool uses the board of {string} and never the named one", function (this: ChatticusWorld, botName: string) {
	const call = lastCall(this);
	const own = botNamed(this, botName);
	assert.equal(call.parsed.outcome, "ok", call.text);
	const requests = boardScenarioOf(this).fake.requests.slice(call.requestCountBefore);
	assert.ok(requests.length > 0);
	for (const request of requests) assert.ok(request.path.startsWith(`/${own.tenantId}/${own.botId}/api/`), request.path);
});
