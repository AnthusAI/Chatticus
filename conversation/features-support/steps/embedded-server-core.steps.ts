import assert from "node:assert/strict";
import { Given, When, Then } from "@cucumber/cucumber";
import type { Principal } from "../../src/auth/principal.ts";
import { createEmbeddedChatApp } from "../../src/http/embedded-chat-app.ts";
import { executorMessageDependencies } from "../front-door.ts";
import type { ChatticusWorld } from "../world.ts";

type EmbeddedChatScenario = {
	channelId: string;
	app: ReturnType<typeof createEmbeddedChatApp>;
	postResponse?: Response;
	readResponse?: Response;
	foreignWriteResponse?: Response;
	foreignReadResponse?: Response;
	committedMessage?: Record<string, unknown>;
};

const scenarioOf = (world: ChatticusWorld): EmbeddedChatScenario => {
	const scenario = world.webFeature.embeddedChat as EmbeddedChatScenario | undefined;
	if (scenario === undefined) throw new Error("The embedded chat server core is not wired for this scenario.");
	return scenario;
};

Given("a host supplies an authenticated editor for a private conversation", async function (this: ChatticusWorld) {
	const channelId = "embedded-private-channel";
	const editorId = "site-person-editor-a";
	const otherEditorId = "site-person-editor-b";
	const store = this.messagingStore();
	await store.putChannel({
		channelId,
		tenantId: this.tenantId,
		kind: "direct",
		name: null,
		participants: [
			{ kind: "human", actorId: editorId },
			{ kind: "bot", actorId: "editorial-assistant" },
		],
		nextSeq: 1,
	});
	const principalFor = (userId: string, tenantId: string): Principal => ({
		kind: "user",
		tenantId,
		userId,
		workerId: null,
		organizationStatus: "enabled",
		role: "member",
	});
	const app = createEmbeddedChatApp({
		clock: this.clock,
		messages: await executorMessageDependencies(this),
		turns: this.turnDependencies(),
		resolvePrincipal: async (request) => {
			const claimedHostEditor = request.headers.get("x-test-host-editor");
			if (claimedHostEditor === "editor-a") return principalFor(editorId, this.tenantId);
			if (claimedHostEditor === "editor-b") return principalFor(otherEditorId, `${this.tenantId}-other`);
			return null;
		},
	});
	this.webFeature.embeddedChat = { channelId, app } satisfies EmbeddedChatScenario;
});

When("the host sends a message through the embedded server API", async function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	scenario.postResponse = await scenario.app.request(`/channels/${scenario.channelId}/messages`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-test-host-editor": "editor-a",
			"idempotency-key": "editor-a-first-message",
		},
		body: JSON.stringify({
			author_kind: "human",
			author_id: "site-person-editor-a",
			body: "Send from the hosted site.",
			addressed_to_bot_id: null,
		}),
	});
	if (scenario.postResponse.ok) {
		const body = await scenario.postResponse.clone().json() as { message: Record<string, unknown> };
		scenario.committedMessage = body.message;
	}
});

Then("Chatticus commits one message for that editor", async function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	assert.equal(scenario.postResponse?.status, 200);
	assert.equal(scenario.committedMessage?.author_id, "site-person-editor-a");
	assert.equal(scenario.committedMessage?.body, "Send from the hosted site.");
});

Then("the same message is returned by the embedded read endpoint", async function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	scenario.readResponse = await scenario.app.request(`/channels/${scenario.channelId}/messages`, {
		headers: { "x-test-host-editor": "editor-a" },
	});
	assert.equal(scenario.readResponse.status, 200);
	const body = await scenario.readResponse.json() as { messages: Array<Record<string, unknown>> };
	assert.equal(body.messages.length, 1);
	assert.equal(body.messages[0]?.message_id, scenario.committedMessage?.message_id);
});

When("the browser claims another editor while sending through the embedded server API", async function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	scenario.foreignWriteResponse = await scenario.app.request(`/channels/${scenario.channelId}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-test-host-editor": "editor-a" },
		body: JSON.stringify({
			author_kind: "human",
			author_id: "site-person-editor-b",
			body: "Impersonate another editor.",
			addressed_to_bot_id: null,
		}),
	});
});

Then("the embedded server refuses the send", function (this: ChatticusWorld) {
	assert.equal(scenarioOf(this).foreignWriteResponse?.status, 403);
});

When("another host editor reads the private conversation", async function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	scenario.foreignReadResponse = await scenario.app.request(`/channels/${scenario.channelId}/messages`, {
		headers: { "x-test-host-editor": "editor-b" },
	});
});

Then("the embedded server refuses the read", function (this: ChatticusWorld) {
	assert.equal(scenarioOf(this).foreignReadResponse?.status, 404);
});
