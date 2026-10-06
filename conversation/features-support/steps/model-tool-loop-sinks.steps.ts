import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { ensureComputer } from "../../src/domain/computers.ts";
import { grantToPayload } from "../../src/policy/capability-policy.ts";
import type { CapabilityPolicy } from "../../src/policy/capability-policy.ts";
import { recordResponse } from "../api.ts";
import { modelScenarioOf, runBotTurn } from "../executor-harness.ts";
import { memberGet } from "../org-user-client.ts";
import { TURN_PROBE_QUEUE, TURN_RUN_QUEUE } from "../turn-queues.ts";
import { activeTurnOf, memberHeadersFor, putActiveTurnGrant } from "../turn-grant-support.ts";
import type { ChatticusWorld } from "../world.ts";
import { readTurnEvents } from "./model.steps.ts";

const SESSION_SECRET_MARKERS = ["session", "cookie", "token", "password", "secret"];

const BLOCKED_PREFIX = "Tool call blocked:";

type ScriptedToolCall = { readonly tool: string; readonly arguments: Record<string, string>; readonly leadingText: string };

/**
 * What a model that obeys the member's message calls, as the Python capability-aware fake text client chose it: the
 * message names the tool and its arguments in plain words.
 */
function toolCallRequestedBy(message: string): ScriptedToolCall | null {
	const read = /read workspace file (.+)$/i.exec(message);
	if (read !== null) {
		return { tool: "read_workspace", arguments: { path: read[1]!.trim() }, leadingText: "I'll read that workspace file." };
	}
	const write = /write workspace file (.+) containing (.+)$/i.exec(message);
	if (write !== null) {
		return {
			tool: "write_workspace",
			arguments: { path: write[1]!.trim(), content: write[2]!.trim() },
			leadingText: "I'll write that workspace file.",
		};
	}
	const browse = /browse (https?:\/\/\S+)/i.exec(message);
	if (browse !== null) {
		return { tool: "browse", arguments: { url: browse[1]!.trim() }, leadingText: "I'll check that origin." };
	}
	const send = /send (\S+)/i.exec(message);
	if (send !== null) {
		return { tool: "send", arguments: { recipient: send[1]!.trim() }, leadingText: "I'll try to send that message." };
	}
	const runWithCwd = /run command (.+?) using cwd (.+)$/i.exec(message);
	if (runWithCwd !== null) {
		return {
			tool: "run_terminal",
			arguments: { command: runWithCwd[1]!.trim(), cwd: runWithCwd[2]!.trim() },
			leadingText: "I'll run that command on the household computer.",
		};
	}
	return null;
}

function botOf(world: ChatticusWorld, name: string): { botId: string; tenantId: string } {
	const bot = world.botsByName?.get(name);
	assert.ok(bot, `Bot ${name} not found`);
	return bot;
}

/** The human who created the bot, ryan unless a step says otherwise, opens a channel with the bot and posts the message; the scripted model obeys it. */
async function askBot(world: ChatticusWorld, botName: string, message: string): Promise<void> {
	const bot = botOf(world, botName);
	assert.ok(world.api, "The scenario has no HTTP front door.");
	const userId = world.botCreatorUserIds.get(botName) ?? "ryan";
	const headers = await memberHeadersFor(world, bot.tenantId, userId);
	const channel = await recordResponse(
		await world.api.post(`/orgs/${bot.tenantId}/channels`, {
			headers,
			body: { user_id: userId, bot_ids: [bot.botId], kind: "direct", name: null },
		}),
	);
	assert.equal(channel.status, 200, channel.text);
	world.lastChannel = { channelId: channel.json.channel_id, tenantId: bot.tenantId };
	const posted = await recordResponse(
		await world.api.post(`/orgs/${bot.tenantId}/channels/${channel.json.channel_id}/messages`, {
			headers,
			body: { author_kind: "human", author_id: userId, body: message, addressed_to_bot_id: bot.botId },
		}),
	);
	assert.equal(posted.status, 200, posted.text);
	world.lastTurnId = posted.json.turn_id;
	const call = toolCallRequestedBy(message);
	if (call !== null) {
		modelScenarioOf(world).scripted.toolCall(call.tool, call.arguments, call.leadingText).reply("That did not go through.");
	}
	const explicit = (world.capabilityPolicy as CapabilityPolicy | null)?.grant ?? null;
	if (explicit !== null) {
		const replaced = await putActiveTurnGrant(world, headers, grantToPayload(explicit), bot.tenantId);
		assert.equal(replaced.status, 200, replaced.text);
	}
}

When("bot {string} is asked {string}", async function (this: ChatticusWorld, botName: string, message: string) {
	await askBot(this, botName, message);
});

When(
	"a human asks the bot to run command {string} using cwd {string}",
	async function (this: ChatticusWorld, command: string, cwd: string) {
		await askBot(this, "Researcher", `run command ${command} using cwd ${cwd}`);
	},
);

When(
	"bot {string} runs one capability-aware computerless worker turn",
	async function (this: ChatticusWorld, botName: string) {
		assert.equal(await runBotTurn(this, botName), "done");
	},
);

const stoppedComputers = new WeakSet<ChatticusWorld>();

/**
 * The first mention in a scenario stops the household computer; a later mention checks that the stored computer is
 * still stopped, so nothing in the turn started it.
 */
Given("the household computer is stopped", async function (this: ChatticusWorld) {
	const tenantId = [...(this.botsByName?.values() ?? [])][0]?.tenantId ?? "anthus";
	const store = this.messagingStore();
	if (stoppedComputers.has(this)) {
		const computer = await store.getComputer(tenantId);
		assert.ok(computer, "The tenant has no computer");
		assert.equal(computer.stopped, true, "The computer was started");
		return;
	}
	const computer = await ensureComputer(tenantId, { store, ids: this.ids });
	await store.putComputer({ ...computer, stopped: true });
	stoppedComputers.add(this);
});

type JournaledCall = { readonly call: Record<string, any>; readonly result: Record<string, any> | undefined };

async function journaledCalls(world: ChatticusWorld, toolName: string): Promise<JournaledCall[]> {
	const { tenantId, turnId } = activeTurnOf(world);
	const events = await readTurnEvents(world, tenantId, turnId);
	return events
		.filter((event) => event.kind === "tool.call" && event.body === toolName)
		.map((call) => ({
			call,
			result: events.find((event) => event.kind === "tool.result" && event.action_id === call.action_id),
		}));
}

Then("the turn journal records a denied {word} tool result", async function (this: ChatticusWorld, toolName: string) {
	const calls = await journaledCalls(this, toolName);
	assert.ok(calls.length > 0, `The journal has no ${toolName} tool call: ${JSON.stringify((await readTurnEvents(this, activeTurnOf(this).tenantId, activeTurnOf(this).turnId)).map((event) => [event.kind, event.body]))}`);
	const last = calls.at(-1)!;
	assert.ok(last.result, `The ${toolName} call has no result`);
	assert.ok(String(last.result.body).includes(BLOCKED_PREFIX), `The ${toolName} result is not a denial: ${last.result.body}`);
});

Then("the denied tool result does not leak session secrets", async function (this: ChatticusWorld) {
	const { tenantId, turnId } = activeTurnOf(this);
	const denials = (await readTurnEvents(this, tenantId, turnId)).filter(
		(event) => event.kind === "tool.result" && String(event.body).includes(BLOCKED_PREFIX),
	);
	assert.ok(denials.length > 0, "The journal has no denied tool result");
	const lowered = String(denials.at(-1)!.body).toLowerCase();
	for (const marker of SESSION_SECRET_MARKERS) {
		assert.ok(!lowered.includes(marker), `The denial mentions ${marker}: ${lowered}`);
	}
});

Then("no computer continuation job is queued for the turn", function (this: ChatticusWorld) {
	const computerQueues = this.queues.nonEmptyQueueNames().filter((name) => name !== TURN_RUN_QUEUE && name !== TURN_PROBE_QUEUE);
	assert.deepEqual(computerQueues, [], "Work was queued for the computer");
});

Then("the turn is not waiting on the workspace capability", async function (this: ChatticusWorld) {
	const { tenantId, turnId } = activeTurnOf(this);
	const response = await recordResponse(await memberGet(this, `/orgs/${tenantId}/turns/${turnId}`));
	assert.equal(response.status, 200, response.text);
	assert.equal(response.json.waiting_for, null);
	assert.equal(response.json.pending_computer_tool, null);
});
