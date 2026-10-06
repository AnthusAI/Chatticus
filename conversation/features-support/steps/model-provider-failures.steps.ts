import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { claimTurn, failTurn } from "../../src/domain/turns.ts";
import { StaleAttemptError } from "../../src/http/errors.ts";
import type { ChatticusWorld } from "../world.ts";
import { post } from "./message.steps.ts";
import { currentTurnOf, readTurn } from "./model.steps.ts";

Given("a worker owns an active turn", async function (this: ChatticusWorld) {
	const channel = this.lastChannel;
	assert.ok(channel, "No channel has been opened");
	const bot = this.botsByName?.get("Assistant");
	assert.ok(bot, "Bot Assistant not found");
	const response = await post(this, {
		authorKind: "human",
		authorId: "ryan",
		body: "hello",
		addressedToBotId: bot.botId,
		tenantId: channel.tenantId,
	});
	assert.equal(response.status, 200, response.text);
	const claim = await claimTurn(this.turnDependencies(), channel.tenantId, currentTurnOf(this), this.ids.next(), "worker-a");
	assert.ok(claim, "The worker could not claim the turn");
	this.turnAttempts.set("owner", claim.attemptId);
});

When("a worker reports the turn failed with a fence it does not hold", async function (this: ChatticusWorld) {
	const channel = this.lastChannel;
	assert.ok(channel, "No channel has been opened");
	const stranger = this.ids.next();
	assert.notEqual(stranger, this.turnAttempts.get("owner"));
	try {
		await failTurn(this.turnDependencies(), channel.tenantId, currentTurnOf(this), stranger, "The stranger says it failed.");
		this.lastError = null;
	} catch (error) {
		assert.ok(error instanceof Error);
		this.lastError = error;
	}
});

Then("the failure report is rejected as stale", function (this: ChatticusWorld) {
	assert.ok(this.lastError instanceof StaleAttemptError, String(this.lastError));
});

Then("the turn is still active", async function (this: ChatticusWorld) {
	const channel = this.lastChannel;
	assert.ok(channel, "No channel has been opened");
	const response = await readTurn(this, channel.tenantId, currentTurnOf(this));
	assert.equal(response.status, 200, response.text);
	assert.equal(response.json.status, "active");
	assert.equal(response.json.terminal_reason, null);
});
