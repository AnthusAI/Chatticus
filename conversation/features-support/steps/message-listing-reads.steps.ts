import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { chatticusExtensions } from "../../src/pi/extension.ts";
import { writeAttributedMessage } from "../../src/pi/channel-log.ts";
import { openOwnerSession } from "../../src/pi/session.ts";
import { storageIdFor } from "../../src/storage/storage-support.ts";
import { recordResponse } from "../api.ts";
import { clearListingRequests, denyListingRequests, listingRequests, listingWrites } from "../front-door-listing-probe.ts";
import { memberGet } from "../org-user-client.ts";
import { ensurePiStorage } from "../pi-storage.ts";
import type { ChatticusWorld } from "../world.ts";

type ListingOutcome = { status: number; messages: Array<Record<string, unknown>> } | { failure: Error };

const outcomes = new WeakMap<ChatticusWorld, ListingOutcome>();

function openChannelOf(world: ChatticusWorld): { channelId: string; tenantId: string } {
	assert.ok(world.lastChannel, "No channel has been opened");
	return world.lastChannel;
}

function botNamed(world: ChatticusWorld, name: string): { botId: string; name: string; tenantId: string } {
	const bot = world.botsByName?.get(name);
	assert.ok(bot, `Bot ${name} not found`);
	return bot;
}

Given(
	"bot {string} already holds a session on the channel with message {int} from human {string} saying {string}",
	async function (this: ChatticusWorld, botName: string, seq: number, authorId: string, body: string) {
		const channel = openChannelOf(this);
		const piStorage = await ensurePiStorage(this);
		const models = createModels();
		const owner = await openOwnerSession(storageIdFor(channel.tenantId, botNamed(this, botName).botId, channel.channelId), {
			client: this.messagingTable.client,
			s3: piStorage.s3,
			tableName: piStorage.tableName,
			bucket: piStorage.bucket,
			models,
			extensions: chatticusExtensions({ systemPrompt: () => `You are ${botName}.` }),
			context: BACKGROUND_CONTEXT,
		});
		try {
			const agent = { model: { provider: "faux", modelId: "faux-model" }, thinkingLevel: "off" as const };
			const root = await owner.harness.root(BACKGROUND_CONTEXT, { agent });
			await writeAttributedMessage(root, {
				seq,
				messageId: `m-${seq}`,
				authorKind: "human",
				authorId,
				addressedToBotId: null,
				createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
				body,
			});
		} finally {
			await owner.close();
		}
	},
);

Given("every session store request of the Front Door's message listing is refused as unauthorized", function (this: ChatticusWorld) {
	denyListingRequests(this);
});

When("the human opens the message list of the channel", async function (this: ChatticusWorld) {
	const channel = openChannelOf(this);
	clearListingRequests(this);
	try {
		const response = await recordResponse(await memberGet(this, `/orgs/${channel.tenantId}/channels/${channel.channelId}/messages`));
		outcomes.set(this, { status: response.status, messages: response.json?.messages ?? [] });
	} catch (error) {
		outcomes.set(this, { failure: error as Error });
	}
});

Then("the message list answers with {int} messages", function (this: ChatticusWorld, count: number) {
	const outcome = outcomes.get(this);
	assert.ok(outcome && "status" in outcome, `The message list did not answer: ${JSON.stringify(outcome)}`);
	assert.equal(outcome.status, 200);
	assert.equal(outcome.messages.length, count);
});

Then("the message list includes the body {string}", function (this: ChatticusWorld, body: string) {
	const outcome = outcomes.get(this);
	assert.ok(outcome && "status" in outcome, "The message list did not answer");
	assert.ok(
		outcome.messages.some((message) => message.body === body),
		`No listed message reads ${body}`,
	);
});

Then("the message list sent at least one read request", function (this: ChatticusWorld) {
	assert.ok(listingRequests(this).length > 0, "The listing sent no request at all, so a missing write proves nothing");
});

Then("the message list wrote nothing to the session store or its bucket", function (this: ChatticusWorld) {
	assert.deepEqual(
		listingWrites(this).map((request) => `${request.action} ${request.store}`),
		[],
	);
});

Then("the message list fails with {string}", function (this: ChatticusWorld, name: string) {
	const outcome = outcomes.get(this);
	assert.ok(outcome && "failure" in outcome, `The message list answered instead of failing: ${JSON.stringify(outcome)}`);
	assert.equal(outcome.failure.name, name);
});
