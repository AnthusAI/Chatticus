import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { BROWSER_UNAVAILABLE_TEXT, setComputerStopped } from "../../src/domain/computers.ts";
import { actionStoreOf } from "../computer-support.ts";
import { bootDriverFor, hostClientFor, lifecycleOf } from "../host-lifecycle-support.ts";
import { activeTurnOf } from "../turn-grant-support.ts";
import type { ChatticusWorld } from "../world.ts";
import { readTurnEvents } from "./model.steps.ts";

const BROWSERLESS_HOST_WORKER_ID = "garage-mac-1";
const BROWSERLESS_TENANT_ID = "anthus";

async function bootHost(world: ChatticusWorld, withoutBrowser: boolean): Promise<void> {
	const driver = bootDriverFor(world, BROWSERLESS_HOST_WORKER_ID, null, { withoutBrowser });
	const boot = await driver.bootThroughBrowser();
	assert.equal(boot.browserAvailable, !withoutBrowser, JSON.stringify(boot));
	const lifecycle = lifecycleOf(world);
	lifecycle.lastBootedHost = BROWSERLESS_HOST_WORKER_ID;
	lifecycle.readinessOrder = [...driver.readinessOrder];
}

When("the computer host boots on an image without a browser", async function (this: ChatticusWorld) {
	await bootHost(this, true);
});

Given("the computer host has booted on an image without a browser", async function (this: ChatticusWorld) {
	await bootHost(this, true);
});

When("the computer host boots with a browser", async function (this: ChatticusWorld) {
	await bootHost(this, false);
});

Given("the computer is stopped after that host exits", async function (this: ChatticusWorld) {
	await setComputerStopped(BROWSERLESS_TENANT_ID, true, { store: this.messagingStore(), ids: this.ids });
});

Then("the computer reports the browser capability unavailable and not ready", async function (this: ChatticusWorld) {
	const computer = await hostClientFor(this, BROWSERLESS_HOST_WORKER_ID).getComputer();
	assert.equal(computer.browser_ready, false);
	assert.equal(computer.browser_unavailable, true);
});

Then("the computer reports the model and workspace capabilities ready", async function (this: ChatticusWorld) {
	const computer = await hostClientFor(this, BROWSERLESS_HOST_WORKER_ID).getComputer();
	assert.equal(computer.model_ready, true);
	assert.equal(computer.workspace_ready, true);
	assert.deepEqual(lifecycleOf(this).readinessOrder, ["model", "workspace"]);
});

Then("the computer reports the browser capability ready", async function (this: ChatticusWorld) {
	const computer = await hostClientFor(this, BROWSERLESS_HOST_WORKER_ID).getComputer();
	assert.equal(computer.browser_ready, true);
	assert.notEqual(computer.browser_unavailable, true);
});

Then("the browse tool result says the browser capability is not available on this computer", async function (this: ChatticusWorld) {
	const { tenantId, turnId } = activeTurnOf(this);
	const events = await readTurnEvents(this, tenantId, turnId);
	const call = events.find((event) => event.kind === "tool.call" && event.body === "browse");
	assert.ok(call, `The journal has no browse tool call: ${JSON.stringify(events.map((event) => [event.kind, event.body]))}`);
	const result = events.find((event) => event.kind === "tool.result" && event.action_id === call.action_id);
	assert.ok(result, "The browse call has no result");
	assert.equal(String(result.body), BROWSER_UNAVAILABLE_TEXT);
});

Then("no computer action was recorded for the turn", async function (this: ChatticusWorld) {
	const { tenantId, turnId } = activeTurnOf(this);
	assert.deepEqual(await actionStoreOf(this).listForTurn(tenantId, turnId), []);
});
