import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { failTurn } from "../../src/domain/turns.ts";
import { StaleAttemptError } from "../../src/http/errors.ts";
import { claimTurnAttempt } from "../../src/turn/executor.ts";
import { capturedConsoleLines, parsedLogLines } from "../log-capture-support.ts";
import { probeQueueOf, TURN_RUN_QUEUE } from "../turn-queues.ts";
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
	this.queues.take(TURN_RUN_QUEUE, (body) => (body as { turnId: string }).turnId === currentTurnOf(this));
	const claim = await claimTurnAttempt(
		{ turns: this.turnDependencies(), turnProbes: probeQueueOf(this), faults: this.faultPlan, workerLabel: "worker-a" },
		{ tenantId: channel.tenantId, turnId: currentTurnOf(this), botId: bot.botId },
	);
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

Then(
	"exactly one provider_failed log line names the turn with status {string}, code {string} and message {string}",
	function (this: ChatticusWorld, status: string, code: string, message: string) {
		const lines = parsedLogLines(capturedConsoleLines(this)).filter((line) => line.event === "provider_failed");
		assert.equal(lines.length, 1, `Expected one provider_failed line, found ${lines.length}`);
		const fields = lines[0]!.fields;
		assert.equal(fields.get("turn_id"), currentTurnOf(this));
		assert.equal(fields.get("status"), status);
		assert.equal(fields.get("code"), code);
		assert.equal(fields.get("message"), message);
	},
);

Then("no provider_failed log line contains {string}", function (this: ChatticusWorld, text: string) {
	const lines = capturedConsoleLines(this).filter((line) => line.startsWith("provider_failed"));
	assert.ok(lines.length > 0, "No provider_failed line was logged");
	for (const line of lines) assert.ok(!line.includes(text), `A provider_failed line contains ${text}`);
});

Then("every provider_failed log message is at most {int} characters", function (this: ChatticusWorld, limit: number) {
	const lines = parsedLogLines(capturedConsoleLines(this)).filter((line) => line.event === "provider_failed");
	assert.ok(lines.length > 0, "No provider_failed line was logged");
	for (const line of lines) assert.ok((line.fields.get("message") ?? "").length <= limit, "A provider_failed message is too long");
});
