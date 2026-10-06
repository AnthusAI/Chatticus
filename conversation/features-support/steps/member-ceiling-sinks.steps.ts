import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { createBot } from "../../src/domain/bots.ts";
import { TURN_EVENT_TTL_SECONDS } from "../../src/domain/turns.ts";
import { type CapabilityPolicy, grantToPayload } from "../../src/policy/capability-policy.ts";
import { MEMBER_STANDING_DENIAL } from "../../src/policy/sinks.ts";
import { recordResponse } from "../api.ts";
import { modelScenarioOf } from "../executor-harness.ts";
import { bearerFor } from "../front-door.ts";
import { activeTurnOf } from "../turn-grant-support.ts";
import { readTurnEvents } from "./model.steps.ts";
import { toolCallRequestedBy } from "./model-tool-loop-sinks.steps.ts";
import type { ChatticusWorld } from "../world.ts";

const BLOCKED_PREFIX = "Tool call blocked:";

function userIdOf(world: ChatticusWorld, email: string): string {
	const identity = world.identitiesByEmail?.get(email);
	assert.ok(identity, `Unknown member ${JSON.stringify(email)}.`);
	return identity.userId;
}

Given(
	"tenant {string} member {string} has a bot named {string}",
	async function (this: ChatticusWorld, tenantId: string, email: string, name: string) {
		const userId = userIdOf(this, email);
		this.testOwnerEmails.set(tenantId, [...(this.identitiesByEmail?.keys() ?? [])][0]!);
		const bot = await createBot(tenantId, name, { creatorUserId: userId }, { store: this.messagingStore(), ids: this.ids });
		this.botsById?.set(bot.botId, bot);
		this.botsByName?.set(name, bot);
		this.botCreatorUserIds.set(name, userId);
	},
);

When(
	"member {string} asks bot {string} to {string}",
	async function (this: ChatticusWorld, email: string, botName: string, message: string) {
		assert.ok(this.api, "The scenario has no HTTP front door.");
		const bot = this.botsByName?.get(botName);
		assert.ok(bot, `Bot ${botName} not found`);
		const userId = userIdOf(this, email);
		const headers = await bearerFor(this, email);
		const channel = await recordResponse(
			await this.api.post(`/orgs/${bot.tenantId}/channels`, {
				headers,
				body: { user_id: userId, bot_ids: [bot.botId], kind: "direct", name: null },
			}),
		);
		assert.equal(channel.status, 200, channel.text);
		this.lastChannel = { channelId: channel.json.channel_id, tenantId: bot.tenantId };
		const posted = await recordResponse(
			await this.api.post(`/orgs/${bot.tenantId}/channels/${channel.json.channel_id}/messages`, {
				headers,
				body: { author_kind: "human", author_id: userId, body: message, addressed_to_bot_id: bot.botId },
			}),
		);
		assert.equal(posted.status, 200, posted.text);
		this.lastTurnId = posted.json.turn_id;
		const call = toolCallRequestedBy(message);
		assert.ok(call, `The scripted model has no tool call for ${JSON.stringify(message)}.`);
		modelScenarioOf(this).scripted.toolCall(call.tool, call.arguments, call.leadingText).reply("That did not go through.");
		const generous = (this.capabilityPolicy as CapabilityPolicy | null)?.grant ?? null;
		assert.ok(generous, "The scenario named no task grant.");
		const { tenantId, turnId } = activeTurnOf(this);
		await this.turnControlStore().replaceGrant({
			tenantId,
			turnId,
			grant: generous,
			body: JSON.stringify({ actor_user_id: userId, ...grantToPayload(generous) }),
			eventId: this.ids.next(),
			expiresAt: new Date(this.clock.now().getTime() + TURN_EVENT_TTL_SECONDS * 1000),
		});
	},
);

Then("the member authority ceiling denial is recorded for the turn", async function (this: ChatticusWorld) {
	const { tenantId, turnId } = activeTurnOf(this);
	const results = (await readTurnEvents(this, tenantId, turnId)).filter((event) => event.kind === "tool.result");
	assert.ok(results.length > 0, "The journal has no tool result.");
	assert.ok(String(results.at(-1)!.body).includes(`${BLOCKED_PREFIX} ${MEMBER_STANDING_DENIAL}`), String(results.at(-1)!.body));
});
