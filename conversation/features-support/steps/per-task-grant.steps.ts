import assert from "node:assert/strict";
import { Then } from "@cucumber/cucumber";
import { activeTurnOf } from "../turn-grant-support.ts";
import { readTurnEvents } from "./model.steps.ts";
import type { ChatticusWorld } from "../world.ts";

const BLOCKED_PREFIX = "Tool call blocked:";

Then("the turn is not denied for lack of run_terminal on the grant", async function (this: ChatticusWorld) {
	const { tenantId, turnId } = activeTurnOf(this);
	const events = await readTurnEvents(this, tenantId, turnId);
	const calls = events.filter((event) => event.kind === "tool.call" && event.body === "run_terminal");
	assert.ok(calls.length > 0, "The model's run_terminal call never reached the gate.");
	const denials = events.filter(
		(event) =>
			event.kind === "tool.result" &&
			calls.some((call) => call.action_id === event.action_id) &&
			String(event.body).includes(BLOCKED_PREFIX),
	);
	assert.deepEqual(denials, [], "The run_terminal call was denied.");
});
