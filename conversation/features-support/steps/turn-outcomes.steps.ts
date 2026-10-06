import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { ensureComputer } from "../../src/domain/computers.ts";
import { recordResponse, type RecordedResponse } from "../api.ts";
import { memberGet } from "../org-user-client.ts";
import type { ChatticusWorld } from "../world.ts";
import { readChannelMessages } from "./model.steps.ts";

async function latestTurn(world: ChatticusWorld, tenantId: string): Promise<RecordedResponse> {
	assert.ok(world.lastChannel, "No channel has been opened");
	return recordResponse(await memberGet(world, `/orgs/${tenantId}/channels/${world.lastChannel.channelId}/turns/latest`));
}

When(
	"tenant {string} reads the latest turn on the open channel as failed with reason {string}",
	async function (this: ChatticusWorld, tenantId: string, reason: string) {
		const response = await latestTurn(this, tenantId);
		assert.equal(response.status, 200, response.text);
		assert.equal(response.json.status, "failed");
		assert.equal(response.json.terminal_reason, reason);
		this.latestTurnResponse = response;
	},
);

Then("the latest turn names the message {string} as its prompt", async function (this: ChatticusWorld, body: string) {
	assert.ok(this.latestTurnResponse, "The latest turn has not been read");
	const promptSeq = this.latestTurnResponse.json.prompt_message_seq;
	const prompt = (await readChannelMessages(this)).find((message) => message.seq === promptSeq);
	assert.ok(prompt, `The channel has no message with seq ${promptSeq}`);
	assert.equal(prompt.body, body);
});

Given(
	"tenant {string} user {string} household computer is stopped",
	async function (this: ChatticusWorld, tenantId: string, _userId: string) {
		const store = this.messagingStore();
		const computer = await ensureComputer(tenantId, { store, ids: this.ids });
		await store.putComputer({ ...computer, stopped: true });
	},
);

Then(
	"tenant {string} user {string} household computer remains stopped",
	async function (this: ChatticusWorld, tenantId: string, _userId: string) {
		const computer = await this.messagingStore().getComputer(tenantId);
		assert.ok(computer, "The tenant has no computer");
		assert.equal(computer.stopped, true);
	},
);
