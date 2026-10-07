import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import type { TurnExecutionOutcome } from "../../src/turn/types.ts";
import { startBotTurn } from "../executor-harness.ts";
import type { ChatticusWorld } from "../world.ts";
import { currentTurnOf, readTurn } from "./model.steps.ts";

type InvocationResult = { readonly outcome: TurnExecutionOutcome } | { readonly error: Error };

const invocations = new WeakMap<ChatticusWorld, InvocationResult>();

const EVERY_ATTEMPT = 1000;

function invocationOf(world: ChatticusWorld): InvocationResult {
	const result = invocations.get(world);
	assert.ok(result, "No invocation has run");
	return result;
}

Given(
	"the next {int} attempts to mark the turn closing meet a conflicting transaction",
	function (this: ChatticusWorld, attempts: number) {
		this.storeFaults.arm("closing", attempts, "conflict");
	},
);

Given("every attempt to mark the turn closing meets a conflicting transaction", function (this: ChatticusWorld) {
	this.storeFaults.arm("closing", EVERY_ATTEMPT, "conflict");
});

Given(
	"the next {int} attempts to append the completion meet a conflicting transaction",
	function (this: ChatticusWorld, attempts: number) {
		this.storeFaults.arm("completion", attempts, "conflict");
	},
);

Given("every attempt to mark the turn closing fails its condition", function (this: ChatticusWorld) {
	this.storeFaults.arm("closing", EVERY_ATTEMPT, "condition");
});

When("bot {string} runs its turn in one invocation", async function (this: ChatticusWorld, name: string) {
	try {
		invocations.set(this, { outcome: await startBotTurn(this, name) });
	} catch (error) {
		invocations.set(this, { error: error as Error });
	}
});

Then("the invocation finalized the turn", async function (this: ChatticusWorld) {
	const result = invocationOf(this);
	assert.ok("outcome" in result, `The invocation failed: ${"error" in result ? result.error.message : ""}`);
	assert.equal(result.outcome, "done");
	const channel = this.lastChannel;
	assert.ok(channel, "No channel has been opened");
	const response = await readTurn(this, channel.tenantId, currentTurnOf(this));
	assert.equal(response.json.status, "completed");
});

Then("the invocation failed with a transaction conflict", function (this: ChatticusWorld) {
	const result = invocationOf(this);
	assert.ok("error" in result, "The invocation did not fail");
	assert.equal(result.error.name, "TransactionConflictException");
});

Then("the invocation ended with the turn lost", function (this: ChatticusWorld) {
	const result = invocationOf(this);
	assert.ok("outcome" in result, `The invocation failed: ${"error" in result ? result.error.message : ""}`);
	assert.equal(result.outcome, "lost");
});

Then("marking the turn closing was attempted {int} times", function (this: ChatticusWorld, attempts: number) {
	assert.equal(this.storeFaults.attempts("closing"), attempts);
});

Then("appending the completion was attempted {int} times", function (this: ChatticusWorld, attempts: number) {
	assert.equal(this.storeFaults.attempts("completion"), attempts);
});
