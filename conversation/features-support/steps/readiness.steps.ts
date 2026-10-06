import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { actionStoreOf } from "../computer-support.ts";
import {
	bringComputerUp,
	STORY_BOT,
	STORY_TENANT,
	STORY_USER,
	startStoryTurn,
	computerScenarioOf,
	diskOf,
	journalNow,
	scenarioTenantId,
	turnPayloadNow,
	workTurn,
} from "../computer-scenario.ts";
import { modelScenarioOf } from "../executor-harness.ts";
import { activeTurnOf, memberHeadersFor, putActiveTurnGrant } from "../turn-grant-support.ts";
import { readChannelMessages } from "./model.steps.ts";
import type { ChatticusWorld } from "../world.ts";

const MAIL_TEXT = "inbox-open";
const MAIL_PATH = "/workspace/mail/inbox.txt";
const PREPARATORY_TEXT = "I have the summary outline ready.";
const BROWSER_ORIGIN = "https://mail.example.com";

Given(
	"a computerless attempt has committed model output and one pending computer tool call",
	async function (this: ChatticusWorld) {
		diskOf(this, STORY_TENANT).set(MAIL_PATH, MAIL_TEXT);
		modelScenarioOf(this)
			.scripted.toolCall("read_workspace", { path: MAIL_PATH }, "I will open household mail.")
			.reply(" Inbox has three unread.");
		await startStoryTurn(this, "what is in the household mail?");
		const state = computerScenarioOf(this);
		state.runQueueConsumerAttached = true;
		assert.equal(await workTurn(this, STORY_BOT), "parked", JSON.stringify(await journalNow(this)));
		const turn = await turnPayloadNow(this);
		assert.ok(turn.pending_computer_tool, "The turn is parked on no computer tool call.");
		state.pendingActionId = turn.pending_computer_tool.action_id;
	},
);

Given(
	"a turn has useful work that needs no computer before a browser step",
	async function (this: ChatticusWorld) {
		modelScenarioOf(this).scripted.toolCall("browse", { url: `${BROWSER_ORIGIN}/inbox` }, PREPARATORY_TEXT).reply("The inbox is open.");
		const turnId = await startStoryTurn(this, "outline the summary, then open the household mail in the browser");
		const headers = await memberHeadersFor(this, STORY_TENANT, STORY_USER);
		const granted = await putActiveTurnGrant(
			this,
			headers,
			{
				tools: ["browse"],
				origins: [BROWSER_ORIGIN],
				recipients: [],
				file_scopes: [],
				egress_classes: ["approved_origin_fetch"],
				ingest_classes: [],
			},
			STORY_TENANT,
		);
		assert.equal(granted.status, 200, granted.text);
		assert.equal(this.lastTurnId, turnId);
	},
);

When("the addressed bot begins the turn", async function (this: ChatticusWorld) {
	assert.equal(await workTurn(this, STORY_BOT), "parked");
});

When("the household computer becomes ready", async function (this: ChatticusWorld) {
	const ran = await bringComputerUp(this, scenarioTenantId(this));
	assert.ok(ran.length > 0, "The ready host found no computer action to run.");
	const state = computerScenarioOf(this);
	if (state.runQueueConsumerAttached) {
		assert.equal(await workTurn(this, state.botName!), "done");
	}
});

When("the turn continues after the browser capability is ready", async function (this: ChatticusWorld) {
	assert.equal(await workTurn(this, computerScenarioOf(this).botName!), "done");
});

Then("one computer-capable attempt executes that exact pending call", async function (this: ChatticusWorld) {
	const state = computerScenarioOf(this);
	const runs = [...state.hosts.values()].flatMap((host) => host.executions);
	assert.equal(runs.length, 1, JSON.stringify(runs));
	assert.equal(runs[0]!.actionId, state.pendingActionId);
	const { tenantId, turnId } = activeTurnOf(this);
	const action = await actionStoreOf(this).get(tenantId, runs[0]!.actionId);
	assert.equal(action?.turnId, turnId);
	assert.equal(action?.status, "done");
});

Then("the tool result is appended to the same turn", async function (this: ChatticusWorld) {
	const { tenantId, turnId } = activeTurnOf(this);
	const action = await actionStoreOf(this).get(tenantId, computerScenarioOf(this).pendingActionId!);
	const results = (await journalNow(this)).filter((event) => event.kind === "tool.result");
	assert.equal(results.length, 1, JSON.stringify(results));
	assert.equal(results[0]!.turn_id, turnId);
	assert.equal(results[0]!.action_id, action?.callId);
	assert.ok(String(results[0]!.body).includes(MAIL_TEXT), String(results[0]!.body));
});

Then("the model continues after the result", async function (this: ChatticusWorld) {
	const events = await journalNow(this);
	const result = events.findIndex((event) => event.kind === "tool.result");
	const later = events.slice(result + 1).filter((event) => event.kind === "turn.token");
	assert.equal(later.map((event) => event.token).join(""), " Inbox has three unread.");
	assert.equal(events.at(-1)!.kind, "turn.completed");
	assert.equal(modelScenarioOf(this).scripted.callCount, 2);
});

Then("no completed tool result is replayed", async function (this: ChatticusWorld) {
	const state = computerScenarioOf(this);
	assert.equal([...state.hosts.values()].flatMap((host) => host.executions).length, 1);
	assert.equal((await journalNow(this)).filter((event) => event.kind === "tool.result").length, 1);
	assert.equal((await journalNow(this)).filter((event) => event.kind === "tool.call").length, 1);
});

Then("it performs the computerless work immediately", async function (this: ChatticusWorld) {
	const events = await journalNow(this);
	const waiting = events.findIndex((event) => event.kind === "turn.waiting");
	const work = events.slice(0, waiting).filter((event) => event.kind === "turn.token");
	assert.equal(work.map((event) => event.token).join(""), PREPARATORY_TEXT);
});

Then("it emits a waiting state naming the computer capability only when blocked", async function (this: ChatticusWorld) {
	const events = await journalNow(this);
	const waiting = events.filter((event) => event.kind === "turn.waiting");
	assert.equal(waiting.length, 1);
	assert.equal(waiting[0]!.body, "browser");
	const firstToken = events.findIndex((event) => event.kind === "turn.token");
	assert.ok(firstToken >= 0 && firstToken < events.findIndex((event) => event.kind === "turn.waiting"));
});

Then("it makes no claim that the browser work is complete", async function (this: ChatticusWorld) {
	const events = await journalNow(this);
	assert.equal(events.some((event) => event.kind === "turn.completed"), false);
	assert.equal((await turnPayloadNow(this)).status, "active");
	assert.deepEqual(
		(await readChannelMessages(this)).filter((message) => message.author_kind === "bot"),
		[],
	);
});

Then("it continues the same turn after the computer becomes ready", async function (this: ChatticusWorld) {
	const { turnId } = activeTurnOf(this);
	const events = await journalNow(this);
	const completed = events.filter((event) => event.kind === "turn.completed");
	assert.equal(completed.length, 1);
	assert.equal(completed[0]!.turn_id, turnId);
	assert.equal(events.filter((event) => event.kind === "attempt.claimed").length, 2);
	assert.ok(events.findIndex((event) => event.kind === "turn.waiting") < events.findIndex((event) => event.kind === "turn.completed"));
});
