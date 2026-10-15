import assert from "node:assert/strict";
import { Then, When } from "@cucumber/cucumber";
import { recordResponse, type RecordedResponse } from "../api.ts";
import type { ChatticusWorld } from "../world.ts";
import { post } from "./message.steps.ts";
import { botNamed } from "./turn.steps.ts";

const sentMessages = new WeakMap<ChatticusWorld, RecordedResponse>();
const healthResponses = new WeakMap<ChatticusWorld, RecordedResponse>();

When(
	"the web UI sends {string} from user {string} of tenant {string} addressed to bot {string}",
	async function (this: ChatticusWorld, body: string, userId: string, tenantId: string, botName: string) {
		sentMessages.set(
			this,
			await post(this, { authorKind: "human", authorId: userId, body, addressedToBotId: botNamed(this, botName).botId, tenantId }),
		);
	},
);

Then("the message is accepted by the thin-turn front door", function (this: ChatticusWorld) {
	const response = sentMessages.get(this);
	assert.ok(response, "The web UI sent no message.");
	assert.equal(response.status, 200, response.text);
});

Then("a turn is started for the message", function (this: ChatticusWorld) {
	const response = sentMessages.get(this);
	assert.ok(response, "The web UI sent no message.");
	assert.equal(typeof response.json.turn_id, "string");
	assert.ok(response.json.turn_id.length > 0);
	assert.equal(this.lastTurnId, response.json.turn_id);
});

When("the web UI requests the health endpoint", async function (this: ChatticusWorld) {
	assert.ok(this.api, "The scenario has no HTTP front door.");
	healthResponses.set(this, await recordResponse(await this.api.get("/health")));
});

Then("the web UI health response is ok", function (this: ChatticusWorld) {
	const response = healthResponses.get(this);
	assert.ok(response, "The web UI requested no health endpoint.");
	assert.equal(response.status, 200, response.text);
	assert.equal(response.json.status, "ok");
	assert.ok(response.json.environment);
});
