import assert from "node:assert/strict";
import { Then } from "@cucumber/cucumber";
import { BOARD_TOOL_NAME } from "../../src/pi/bot-board-tool.ts";
import { TASK_TOOL_NAME } from "../../src/pi/task-tool.ts";
import { modelScenarioOf, runBotTurn } from "../executor-harness.ts";
import { boardScenarioOf, botNamed } from "../bot-board-support.ts";
import { openChannelWithNamedBot, post } from "./message.steps.ts";
import type { ChatticusWorld } from "../world.ts";

async function toolNamesOffered(world: ChatticusWorld, botName: string): Promise<string[]> {
	const bot = botNamed(world, botName);
	await openChannelWithNamedBot(world, bot.tenantId, "ryan", botName);
	await post(world, { authorKind: "human", authorId: "ryan", body: "Hello.", addressedToBotId: bot.botId });
	assert.equal(await runBotTurn(world, botName), "done");
	const requests = modelScenarioOf(world).scripted.requests;
	const context = JSON.parse(requests[requests.length - 1]!) as { messages: Array<{ toolsAdded?: Array<{ name: string }> }> };
	return context.messages.flatMap((message) => (message.toolsAdded ?? []).map((tool) => tool.name));
}

Then("no request was made to a board service", function (this: ChatticusWorld) {
	assert.deepEqual(boardScenarioOf(this).fake.requests, []);
});

Then("the bot {string} is offered the task tool and not the board tool", async function (this: ChatticusWorld, botName: string) {
	const names = await toolNamesOffered(this, botName);
	assert.ok(names.includes(TASK_TOOL_NAME), names.join(", "));
	assert.ok(!names.includes(BOARD_TOOL_NAME), names.join(", "));
});

Then("the bot {string} is offered the task tool and the board tool", async function (this: ChatticusWorld, botName: string) {
	const names = await toolNamesOffered(this, botName);
	assert.ok(names.includes(TASK_TOOL_NAME), names.join(", "));
	assert.ok(names.includes(BOARD_TOOL_NAME), names.join(", "));
});
