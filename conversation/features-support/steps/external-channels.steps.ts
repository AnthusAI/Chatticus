import assert from "node:assert/strict";
import { DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import { createChannelBinding, linkExternalIdentity } from "../../src/channels/binding-service.ts";
import { ingestInbound, type AdmissionOutcome } from "../../src/channels/inbound-admission.ts";
import { deliverChannelMessage, processStatusCallback, sweepStaleDeliveries } from "../../src/channels/delivery.ts";
import type { DeliveryRecord } from "../../src/channels/records.ts";
import { TransportDeliveryError, type AutomationHints, type DeliveryFailureClass } from "../../src/channels/transport.ts";
import { OrganizationsKernelImpl } from "../../src/domain/organizations.ts";
import { membershipKey } from "../../src/store/keys.ts";
import { recordResponse, type RecordedResponse } from "../api.ts";
import { identityOfPerson, tenantIdOfOrganization } from "../bot-board-support.ts";
import {
	admissionDependenciesFor,
	channelsScenarioOf,
	deliveryDependenciesFor,
	messagingItemCount,
	requiredChannelsRuntime,
} from "../channels-support.ts";
import { runBotTurn, modelScenarioOf } from "../executor-harness.ts";
import { bearerFor, wireFrontDoor } from "../front-door.ts";
import { DEFAULT_OPERATOR_KEY } from "./operator.steps.ts";
import type { ChatticusWorld } from "../world.ts";

const kernel = new OrganizationsKernelImpl();

type Method = "GET" | "POST" | "PUT" | "PATCH";

async function rewire(world: ChatticusWorld): Promise<void> {
	assert.ok(world.frontDoorOptions, "The scenario has no front door yet");
	await wireFrontDoor(world, { ...world.frontDoorOptions, operatorKey: DEFAULT_OPERATOR_KEY });
}

async function call(world: ChatticusWorld, who: string, method: Method, path: string, body?: unknown): Promise<RecordedResponse> {
	assert.ok(world.api, "The scenario has no HTTP front door");
	const init = { headers: await bearerFor(world, who), ...(body === undefined ? {} : { body }) };
	const api = world.api;
	const response =
		method === "GET" ? await api.get(path, init) : method === "POST" ? await api.post(path, init) : method === "PUT" ? await api.put(path, init) : await api.patch(path, init);
	const recorded = await recordResponse(response);
	channelsScenarioOf(world).response = recorded;
	return recorded;
}

function responseOf(world: ChatticusWorld): RecordedResponse {
	const response = channelsScenarioOf(world).response;
	assert.ok(response, "The scenario made no channel request");
	return response;
}

const tenantOf = tenantIdOfOrganization;
const userIdOf = (tenantId: string, person: string): string => identityOfPerson(tenantId, person).userId;
const FIRST_OWNER = "ryan@example.com";

function botIdOf(world: ChatticusWorld, botName: string): string {
	const bot = world.botsByName?.get(botName);
	assert.ok(bot, `The scenario has no bot ${botName}`);
	return bot.botId;
}

async function bindingOfBot(world: ChatticusWorld, who: string, botName: string, organization: string): Promise<Record<string, any>> {
	const listing = await call(world, who, "GET", `/orgs/${tenantOf(organization)}/channel-bindings`);
	assert.equal(listing.status, 200, listing.text);
	const found = (listing.json.bindings as Array<Record<string, any>>).find((binding) => binding.bot_id === botIdOf(world, botName));
	assert.ok(found, `${organization} has no binding for ${botName}`);
	return found;
}

async function bindingOfRoute(world: ChatticusWorld, organization: string, routeKey: string): Promise<{ bindingId: string; botId: string }> {
	const runtime = requiredChannelsRuntime(world);
	const bindings = await runtime.store.listBindings(tenantOf(organization));
	const found = bindings.find((binding) => binding.routeKey === routeKey.toLowerCase());
	assert.ok(found, `${organization} has no binding with the route key ${routeKey}`);
	return { bindingId: found.bindingId, botId: found.botId };
}

Given("external channels are configured for this environment with the mail domain {string}", async function (this: ChatticusWorld, mailDomain: string) {
	const scenario = channelsScenarioOf(this);
	scenario.configured = true;
	scenario.mailDomain = mailDomain;
	await rewire(this);
});

Given("external channels are not configured for this environment", async function (this: ChatticusWorld) {
	channelsScenarioOf(this).configured = false;
	await rewire(this);
});

Given("the environment kill switch for external channels is engaged", async function (this: ChatticusWorld) {
	channelsScenarioOf(this).killSwitchEngaged = true;
	await rewire(this);
});

Given("external channels are switched {word} for the organization {string}", async function (this: ChatticusWorld, position: string, organization: string) {
	assert.ok(position === "on" || position === "off", position);
	await requiredChannelsRuntime(this).store.setExternalChannelsEnabled(tenantOf(organization), position === "on");
});

Given("the organization {string} is suspended by the operator", async function (this: ChatticusWorld, organization: string) {
	await kernel.suspendOrganization(tenantOf(organization), { store: this.messagingStore() });
});

When("the operator switches external channels {word} for the organization {string}", async function (this: ChatticusWorld, position: string, organization: string) {
	assert.ok(this.api);
	const action = position === "on" ? "enable" : "disable";
	const scenario = channelsScenarioOf(this);
	scenario.operatorResponse = await recordResponse(
		await this.api.post(`/operator/orgs/${tenantOf(organization)}/external-channels/${action}`, { headers: { Authorization: `Bearer ${DEFAULT_OPERATOR_KEY}` } }),
	);
});

Then("the operator request is accepted", function (this: ChatticusWorld) {
	const response = channelsScenarioOf(this).operatorResponse;
	assert.ok(response);
	assert.equal(response.status, 200, response.text);
});

When("{string} chooses the mail handle {string} for {string}", async function (this: ChatticusWorld, who: string, handle: string, organization: string) {
	await call(this, who, "PUT", `/orgs/${tenantOf(organization)}/mail-handle`, { mail_handle: handle });
});

Given("{string} has chosen the mail handle {string} for {string}", async function (this: ChatticusWorld, who: string, handle: string, organization: string) {
	const response = await call(this, who, "PUT", `/orgs/${tenantOf(organization)}/mail-handle`, { mail_handle: handle });
	assert.equal(response.status, 200, response.text);
});

When("{string} creates an email binding for the bot {string} in {string}", async function (this: ChatticusWorld, who: string, botName: string, organization: string) {
	await call(this, who, "POST", `/orgs/${tenantOf(organization)}/channel-bindings`, { provider: "email", bot_id: botIdOf(this, botName) });
});

Given("{string} has created an email binding for the bot {string} in {string}", async function (this: ChatticusWorld, who: string, botName: string, organization: string) {
	const response = await call(this, who, "POST", `/orgs/${tenantOf(organization)}/channel-bindings`, { provider: "email", bot_id: botIdOf(this, botName) });
	assert.equal(response.status, 200, response.text);
});

When(
	"{string} creates a fake binding for the bot {string} in {string} with the route key {string}",
	async function (this: ChatticusWorld, who: string, botName: string, organization: string, routeKey: string) {
		await call(this, who, "POST", `/orgs/${tenantOf(organization)}/channel-bindings`, { provider: "fake", bot_id: botIdOf(this, botName), route_key: routeKey });
	},
);

Given(
	"{string} has created a fake binding for the bot {string} in {string} with the route key {string}",
	async function (this: ChatticusWorld, who: string, botName: string, organization: string, routeKey: string) {
		const response = await call(this, who, "POST", `/orgs/${tenantOf(organization)}/channel-bindings`, { provider: "fake", bot_id: botIdOf(this, botName), route_key: routeKey });
		assert.equal(response.status, 200, response.text);
	},
);

When("{string} lists the channel bindings of {string}", async function (this: ChatticusWorld, who: string, organization: string) {
	await call(this, who, "GET", `/orgs/${tenantOf(organization)}/channel-bindings`);
});

Given("{string} has read the channel bindings of {string}", async function (this: ChatticusWorld, who: string, organization: string) {
	const response = await call(this, who, "GET", `/orgs/${tenantOf(organization)}/channel-bindings`);
	assert.equal(response.status, 200, response.text);
});

When("{string} reads the binding of the bot {string} in {string}", async function (this: ChatticusWorld, who: string, botName: string, organization: string) {
	const binding = await bindingOfBot(this, FIRST_OWNER, botName, organization);
	await call(this, who, "GET", `/orgs/${tenantOf(organization)}/channel-bindings/${binding.binding_id}`);
});

When("{string} disables the binding of the bot {string} in {string}", async function (this: ChatticusWorld, who: string, botName: string, organization: string) {
	const binding = await bindingOfBot(this, FIRST_OWNER, botName, organization);
	await call(this, who, "PATCH", `/orgs/${tenantOf(organization)}/channel-bindings/${binding.binding_id}`, { enabled: false });
});

Given("the owner {string} disables the fake route {string} of {string}", async function (this: ChatticusWorld, who: string, routeKey: string, organization: string) {
	const { bindingId } = await bindingOfRoute(this, organization, routeKey);
	const response = await call(this, who, "PATCH", `/orgs/${tenantOf(organization)}/channel-bindings/${bindingId}`, { enabled: false });
	assert.equal(response.status, 200, response.text);
});

Given("{string} removes {string} from {string}", async function (this: ChatticusWorld, _who: string, member: string, organization: string) {
	const tenantId = tenantOf(organization);
	const key = membershipKey(tenantId, userIdOf(tenantId, member));
	await this.messagingTable.client.send(new DeleteItemCommand({ TableName: this.messagingTable.tableName, Key: { pk: { S: key.pk }, sk: { S: key.sk } } }));
});

Then("the channel request is accepted", function (this: ChatticusWorld) {
	const response = responseOf(this);
	assert.equal(response.status, 200, response.text);
});

Then("the channel request is answered as not found", function (this: ChatticusWorld) {
	const response = responseOf(this);
	assert.equal(response.status, 404, response.text);
	assert.equal(response.json?.code, "not_found", response.text);
});

Then("the channel request is refused as forbidden", function (this: ChatticusWorld) {
	const response = responseOf(this);
	assert.equal(response.status, 403, response.text);
	assert.equal(response.json?.code, "forbidden", response.text);
});

Then("the channel request is refused with the status {int} and the code {string}", function (this: ChatticusWorld, status: number, code: string) {
	const response = responseOf(this);
	assert.equal(response.status, status, response.text);
	assert.equal(response.json?.code, code, response.text);
});

Then("the binding address is {string}", function (this: ChatticusWorld, address: string) {
	assert.equal(responseOf(this).json?.address, address);
});

Then("the binding is enabled", function (this: ChatticusWorld) {
	assert.equal(responseOf(this).json?.enabled, true);
});

Then("the binding is disabled", function (this: ChatticusWorld) {
	assert.equal(responseOf(this).json?.enabled, false);
});

Then("the listed bindings number {int}", function (this: ChatticusWorld, count: number) {
	assert.equal(responseOf(this).json?.bindings?.length, count);
});

Given("the fake route {string} of {string} is bound to the bot {string}", async function (this: ChatticusWorld, routeKey: string, organization: string, botName: string) {
	const created = await createChannelBinding(
		{ runtime: requiredChannelsRuntime(this), store: this.messagingStore(), ids: this.ids, clock: this.clock },
		tenantOf(organization),
		{ provider: "fake", botId: botIdOf(this, botName), routeKey, createdBy: "scenario" },
	);
	assert.ok(created.ok, JSON.stringify(created));
});

Given("the fake sender {string} is linked to {string} in {string}", async function (this: ChatticusWorld, sender: string, person: string, organization: string) {
	const tenantId = tenantOf(organization);
	const linked = await linkExternalIdentity(
		{ runtime: requiredChannelsRuntime(this), store: this.messagingStore(), ids: this.ids, clock: this.clock },
		tenantId,
		{ provider: "fake", externalId: sender, userId: userIdOf(tenantId, person), linkedBy: "scenario" },
	);
	assert.ok(linked.ok, JSON.stringify(linked));
});

When("{string} links the fake sender {string} to {string} in {string}", async function (this: ChatticusWorld, who: string, sender: string, person: string, organization: string) {
	const tenantId = tenantOf(organization);
	await call(this, who, "PUT", `/orgs/${tenantId}/external-identities`, { provider: "fake", external_id: sender, user_id: userIdOf(tenantId, person) });
});

Given("the fake transport carries pair conversations", function (this: ChatticusWorld) {
	channelsScenarioOf(this).fake.useGranularity("pair");
});

const AUTOMATION_HINTS: Readonly<Record<string, Partial<AutomationHints>>> = {
	own_origin: { ownOrigin: true },
	auto_submitted: { autoSubmitted: true },
	bounce_report: { bounceReport: true },
};

function inboundInputOf(table: DataTable) {
	const row = table.rowsHash();
	const list = (value: string | undefined): string[] => (value === undefined || value.trim() === "" ? [] : value.split(",").map((entry) => entry.trim()));
	return {
		bindingRouteKey: row["to"]!,
		externalMessageId: row["id"]!,
		senderExternalId: row["from"]!,
		...(row["conversation"] === undefined ? {} : { conversationKey: row["conversation"] }),
		...(row["subject"] === undefined ? {} : { subject: row["subject"] }),
		...(row["text"] === undefined ? {} : { text: row["text"] }),
		referencedExternalMessageIds: list(row["references"]),
		cc: list(row["cc"]),
		...(row["automated"] === undefined ? {} : { automationHints: AUTOMATION_HINTS[row["automated"]] }),
	};
}

async function deliverRequest(world: ChatticusWorld, signature?: string, table?: DataTable): Promise<void> {
	const scenario = channelsScenarioOf(world);
	if (table !== undefined) {
		scenario.lastRequest = scenario.fake.inboundRequest([inboundInputOf(table)], world.clock.now(), signature);
	}
	assert.ok(scenario.lastRequest, "No request has been made");
	const result = await ingestInbound(await admissionDependenciesFor(world), scenario.fake, scenario.lastRequest);
	if (result.kind === "refused") {
		scenario.lastRefusal = result.refusal;
		return;
	}
	scenario.lastRefusal = null;
	scenario.outcomes.push(...result.outcomes);
}

When("a message arrives over the fake transport:", async function (this: ChatticusWorld, table: DataTable) {
	await deliverRequest(this, undefined, table);
});

When("a fake request with a bad signature arrives:", async function (this: ChatticusWorld, table: DataTable) {
	await deliverRequest(this, "forged", table);
});

When("the same fake request is delivered {int} more times", async function (this: ChatticusWorld, times: number) {
	for (let index = 0; index < times; index += 1) await deliverRequest(this);
});

function lastOutcome(world: ChatticusWorld): AdmissionOutcome {
	const outcomes = channelsScenarioOf(world).outcomes;
	const last = outcomes[outcomes.length - 1];
	assert.ok(last, "No message has arrived");
	return last;
}

Then("the message was admitted", function (this: ChatticusWorld) {
	assert.equal(lastOutcome(this).kind, "admitted", JSON.stringify(lastOutcome(this)));
});

Then("the message was dropped as {string}", function (this: ChatticusWorld, reason: string) {
	assert.deepEqual(lastOutcome(this), { kind: "dropped", reason });
});

Then("the message was admitted as a duplicate of the first one", function (this: ChatticusWorld) {
	const outcomes = channelsScenarioOf(this).outcomes;
	const first = outcomes[0];
	const last = lastOutcome(this);
	assert.ok(outcomes.length > 1 && first?.kind === "admitted" && last.kind === "admitted", JSON.stringify(outcomes));
	assert.equal(first.duplicate, false);
	assert.equal(last.duplicate, true);
	assert.equal(last.messageId, first.messageId);
	assert.equal(last.channelId, first.channelId);
});

Then("the fake request was refused", function (this: ChatticusWorld) {
	assert.ok(channelsScenarioOf(this).lastRefusal, "The request was not refused");
	assert.equal(channelsScenarioOf(this).outcomes.length, 0);
});

Then("both messages joined the same turn", function (this: ChatticusWorld) {
	const admitted = channelsScenarioOf(this).outcomes.filter((outcome) => outcome.kind === "admitted");
	assert.equal(admitted.length, 2);
	const [first, second] = admitted as Array<Extract<AdmissionOutcome, { kind: "admitted" }>>;
	assert.ok(first!.turnId !== null);
	assert.equal(first!.turnId, second!.turnId);
});

Then("the bot {string} has {int} turn(s) queued", function (this: ChatticusWorld, botName: string, count: number) {
	const botId = botIdOf(this, botName);
	const queued = this.queues.pending("turn-runs").filter((job) => (job.body as { botId: string }).botId === botId);
	assert.equal(queued.length, count);
});

Given("the Messaging table is counted", async function (this: ChatticusWorld) {
	channelsScenarioOf(this).countedItems = await messagingItemCount(this);
});

Then("the Messaging table holds the same items as when it was counted", async function (this: ChatticusWorld) {
	assert.equal(await messagingItemCount(this), channelsScenarioOf(this).countedItems);
});

Then("the counter {string} was counted {int} time(s)", function (this: ChatticusWorld, name: string, times: number) {
	assert.equal(channelsScenarioOf(this).counted.filter((metric) => metric.name === name).length, times);
});

type ChannelRow = { channel_id: string; kind: string; name: string | null; participants: Array<{ kind: string; actor_id: string }> };

async function channelsOf(world: ChatticusWorld, person: string, organization: string): Promise<ChannelRow[]> {
	const tenantId = tenantOf(organization);
	const response = await call(world, person, "GET", `/orgs/${tenantId}/users/${userIdOf(tenantId, person)}/channels`);
	assert.equal(response.status, 200, response.text);
	return response.json.channels as ChannelRow[];
}

async function messagesOf(world: ChatticusWorld, person: string, tenantId: string, channelId: string): Promise<Array<Record<string, any>>> {
	const response = await call(world, person, "GET", `/orgs/${tenantId}/channels/${channelId}/messages`);
	assert.equal(response.status, 200, response.text);
	return response.json.messages;
}

Then("{string} has {int} channel(s) of kind {string} in {string}", async function (this: ChatticusWorld, person: string, count: number, kind: string, organization: string) {
	const matching = (await channelsOf(this, person, organization)).filter((channel) => channel.kind === kind);
	assert.equal(matching.length, count);
	if (matching[0] !== undefined) channelsScenarioOf(this).focusChannel = { channelId: matching[0].channel_id, tenantId: tenantOf(organization), person };
});

async function externalChannelOf(world: ChatticusWorld, person: string, organization: string): Promise<ChannelRow> {
	const found = (await channelsOf(world, person, organization)).filter((channel) => channel.kind === "external");
	assert.equal(found.length, 1, `Expected one external channel for ${person}`);
	channelsScenarioOf(world).focusChannel = { channelId: found[0]!.channel_id, tenantId: tenantOf(organization), person };
	return found[0]!;
}

Then("the external channel of {string} in {string} is named {string}", async function (this: ChatticusWorld, person: string, organization: string, name: string) {
	assert.equal((await externalChannelOf(this, person, organization)).name, name);
});

function focus(world: ChatticusWorld): { channelId: string; tenantId: string; person: string } {
	const channel = channelsScenarioOf(world).focusChannel;
	assert.ok(channel, "No channel is in focus");
	return channel;
}

Then("that channel has {int} message(s)", async function (this: ChatticusWorld, count: number) {
	const channel = focus(this);
	assert.equal((await messagesOf(this, channel.person, channel.tenantId, channel.channelId)).length, count);
});

Given("{string} has a direct channel with the bot {string} in {string}", async function (this: ChatticusWorld, person: string, botName: string, organization: string) {
	const tenantId = tenantOf(organization);
	const response = await call(this, person, "POST", `/orgs/${tenantId}/channels`, { user_id: userIdOf(tenantId, person), bot_ids: [botIdOf(this, botName)], kind: "direct", name: null });
	assert.equal(response.status, 200, response.text);
	channelsScenarioOf(this).focusChannel = { channelId: response.json.channel_id, tenantId, person };
});

async function postAs(world: ChatticusWorld, person: string, channel: { channelId: string; tenantId: string }, text: string, botName: string): Promise<void> {
	const response = await call(world, person, "POST", `/orgs/${channel.tenantId}/channels/${channel.channelId}/messages`, {
		author_kind: "human",
		author_id: userIdOf(channel.tenantId, person),
		body: text,
		addressed_to_bot_id: botIdOf(world, botName),
	});
	assert.equal(response.status, 200, response.text);
}

When("{string} posts {string} on that channel addressed to the bot {string}", async function (this: ChatticusWorld, person: string, text: string, botName: string) {
	await postAs(this, person, focus(this), text, botName);
});

When("{string} posts {string} on the external channel addressed to the bot {string}", async function (this: ChatticusWorld, person: string, text: string, botName: string) {
	const channel = await externalChannelOf(this, person, "Anthus Labs");
	await postAs(this, person, { channelId: channel.channel_id, tenantId: tenantOf("Anthus Labs") }, text, botName);
});

Then(
	"the messages of the direct channel of {string} with the bot {string} in {string} show no origin",
	async function (this: ChatticusWorld, person: string, botName: string, organization: string) {
		const tenantId = tenantOf(organization);
		const direct = (await channelsOf(this, person, organization)).find(
			(channel) => channel.kind === "direct" && channel.participants.some((participant) => participant.actor_id === botIdOf(this, botName)),
		);
		assert.ok(direct);
		const messages = await messagesOf(this, person, tenantId, direct.channel_id);
		assert.ok(messages.length > 0);
		for (const message of messages) assert.equal(message.origin, undefined);
	},
);

Then(
	"the messages of the external channel of {string} in {string} show the origin provider {string} and external message {string}",
	async function (this: ChatticusWorld, person: string, organization: string, provider: string, externalId: string) {
		const channel = await externalChannelOf(this, person, organization);
		const messages = await messagesOf(this, person, tenantOf(organization), channel.channel_id);
		const origin = messages[0]?.origin;
		assert.ok(origin, "The message shows no origin");
		assert.equal(origin.provider, provider);
		assert.equal(origin.external_message_id, externalId);
	},
);

Then("{string} is refused when reading the external channel of {string} in {string}", async function (this: ChatticusWorld, reader: string, owner: string, organization: string) {
	const channel = await externalChannelOf(this, owner, organization);
	const response = await call(this, reader, "GET", `/orgs/${tenantOf(organization)}/channels/${channel.channel_id}/messages`);
	assert.equal(response.status, 403, response.text);
});

Then(
	"the message {string} on the external channel of {string} in {string} shows no origin",
	async function (this: ChatticusWorld, text: string, person: string, organization: string) {
		const channel = await externalChannelOf(this, person, organization);
		const messages = await messagesOf(this, person, tenantOf(organization), channel.channel_id);
		const found = messages.find((message) => message.body === text);
		assert.ok(found, `No message with the text ${text}`);
		assert.equal(found.origin, undefined);
	},
);

Then("{string} is refused as a non-member when reading the external channel of {string} in {string}", async function (this: ChatticusWorld, reader: string, owner: string, organization: string) {
	const channel = await externalChannelOf(this, owner, organization);
	const response = await call(this, reader, "GET", `/orgs/${tenantOf(organization)}/channels/${channel.channel_id}/messages`);
	assert.equal(response.status, 403, response.text);
	assert.match(response.json.detail, /is not a member of organization/);
});

Then(
	"the external channel of {string} in {string} has the message {string} written by {string}",
	async function (this: ChatticusWorld, person: string, organization: string, text: string, author: string) {
		const channel = await externalChannelOf(this, person, organization);
		const tenantId = tenantOf(organization);
		const messages = await messagesOf(this, person, tenantId, channel.channel_id);
		const found = messages.find((message) => message.body === text);
		assert.ok(found, `No message with the text ${text}`);
		assert.equal(found.author_kind, "human");
		assert.equal(found.author_id, userIdOf(tenantId, author));
	},
);

Then(
	"the external channel of {string} in {string} has only the bot {string} as a bot participant",
	async function (this: ChatticusWorld, person: string, organization: string, botName: string) {
		const channel = await externalChannelOf(this, person, organization);
		const botIds = channel.participants.filter((participant) => participant.kind === "bot").map((participant) => participant.actor_id);
		assert.deepEqual(botIds, [botIdOf(this, botName)]);
	},
);

Then(
	"the external channel of {string} in {string} has the bots {string} and {string} as participants",
	async function (this: ChatticusWorld, person: string, organization: string, first: string, second: string) {
		const channel = await externalChannelOf(this, person, organization);
		const botIds = channel.participants.filter((participant) => participant.kind === "bot").map((participant) => participant.actor_id);
		assert.deepEqual(botIds.sort(), [botIdOf(this, first), botIdOf(this, second)].sort());
	},
);

Given("the model will answer {string}", function (this: ChatticusWorld, answer: string) {
	modelScenarioOf(this).scripted.reply(answer);
});

When("the bot {string} completes its turn", async function (this: ChatticusWorld, botName: string) {
	assert.equal(await runBotTurn(this, botName), "done");
});

async function latestPublishedDelivery(world: ChatticusWorld): Promise<DeliveryRecord> {
	const published = channelsScenarioOf(world).published;
	const event = published[published.length - 1];
	assert.ok(event, "No delivery event was published");
	const delivery = await requiredChannelsRuntime(world).store.getDelivery(event.detail.tenant_id, event.detail.message_id, event.detail.binding_id);
	assert.ok(delivery, "The event names no delivery");
	return delivery;
}

When("the delivery handler runs for the reply", async function (this: ChatticusWorld) {
	const published = channelsScenarioOf(this).published;
	const event = published[published.length - 1];
	assert.ok(event, "No delivery event was published");
	await deliverChannelMessage(await deliveryDependenciesFor(this), { tenantId: event.detail.tenant_id, messageId: event.detail.message_id, bindingId: event.detail.binding_id });
});

Then("the fake provider sent {int} message(s)", function (this: ChatticusWorld, count: number) {
	assert.equal(channelsScenarioOf(this).fake.sends.length, count);
});

Then("the fake provider was asked to send {int} time(s)", function (this: ChatticusWorld, count: number) {
	assert.equal(channelsScenarioOf(this).fake.deliverCalls, count);
});

Then(
	"the fake provider sent {string} to {string} in the conversation {string} in reply to {string}",
	function (this: ChatticusWorld, text: string, recipient: string, conversation: string, inReplyTo: string) {
		const sends = channelsScenarioOf(this).fake.sends;
		const last = sends[sends.length - 1];
		assert.ok(last, "The fake provider sent nothing");
		assert.equal(last.payload.text, text);
		assert.equal(last.payload.recipientExternalId, recipient);
		assert.equal(last.payload.conversationKey, conversation);
		assert.equal(last.payload.inReplyToExternalMessageId, inReplyTo);
	},
);

Then("the delivery of the reply is {string}", async function (this: ChatticusWorld, state: string) {
	assert.equal((await latestPublishedDelivery(this)).state, state);
});

Then("the delivery of the reply is {string} with the reason {string}", async function (this: ChatticusWorld, state: string, reason: string) {
	const delivery = await latestPublishedDelivery(this);
	assert.equal(delivery.state, state);
	assert.equal(delivery.reasonCode, reason);
});

async function everyDelivery(world: ChatticusWorld): Promise<DeliveryRecord[]> {
	const store = requiredChannelsRuntime(world).store;
	const deliveries: DeliveryRecord[] = [];
	for (const binding of await store.listBindings("anthus-labs")) deliveries.push(...(await store.listDeliveries("anthus-labs", binding.bindingId)));
	return deliveries;
}

Then("no delivery was recorded", async function (this: ChatticusWorld) {
	assert.deepEqual(await everyDelivery(this), []);
	assert.deepEqual(channelsScenarioOf(this).published, []);
});

Then("{int} delivery was recorded", async function (this: ChatticusWorld, count: number) {
	assert.equal((await everyDelivery(this)).length, count);
});

Then("exactly {int} channel event was published", function (this: ChatticusWorld, count: number) {
	assert.equal(channelsScenarioOf(this).published.length, count);
});

Then("the channel event carries only the tenant, message and binding ids", function (this: ChatticusWorld) {
	const event = channelsScenarioOf(this).published[0]!;
	assert.equal(event.detailType, "channel.message.created");
	assert.deepEqual(Object.keys(event.detail).sort(), ["binding_id", "message_id", "tenant_id"]);
});

Then("the channel event does not contain the answer text or the sender", function (this: ChatticusWorld) {
	const text = JSON.stringify(channelsScenarioOf(this).published[0]);
	assert.ok(!text.includes("research"), text);
	assert.ok(!text.includes("sam-phone"), text);
	assert.ok(!text.includes("sam@"), text);
});

function failure(failureClass: string, reason: string): TransportDeliveryError {
	return new TransportDeliveryError(failureClass as DeliveryFailureClass, reason);
}

Given("the fake provider fails its next delivery as {word} {string}", function (this: ChatticusWorld, failureClass: string, reason: string) {
	channelsScenarioOf(this).fake.failNextDeliveries(1, failure(failureClass, reason));
});

Given("the fake provider fails its next {int} deliveries as {word} {string}", function (this: ChatticusWorld, count: number, failureClass: string, reason: string) {
	channelsScenarioOf(this).fake.failNextDeliveries(count, failure(failureClass, reason));
});

When("the clock moves forward {int} minutes", function (this: ChatticusWorld, minutes: number) {
	this.clock.advanceSeconds(minutes * 60);
});

When("the sweeper runs", async function (this: ChatticusWorld) {
	await sweepStaleDeliveries(await deliveryDependenciesFor(this));
});

When("{int} sweeps find the delivery stale", async function (this: ChatticusWorld, sweeps: number) {
	for (let index = 0; index < sweeps; index += 1) {
		this.clock.advanceSeconds(4 * 60);
		await sweepStaleDeliveries(await deliveryDependenciesFor(this));
	}
});

When("{string} reads the deliveries of the fake route {string} of {string}", async function (this: ChatticusWorld, who: string, routeKey: string, organization: string) {
	const { bindingId } = await bindingOfRoute(this, organization, routeKey);
	channelsScenarioOf(this).deliveriesResponse = await call(this, who, "GET", `/orgs/${tenantOf(organization)}/channel-bindings/${bindingId}/deliveries`);
});

Then("the listed delivery is {string} with the reason {string} and no message text", function (this: ChatticusWorld, state: string, reason: string) {
	const response = channelsScenarioOf(this).deliveriesResponse;
	assert.ok(response);
	assert.equal(response.status, 200, response.text);
	assert.equal(response.json.deliveries.length, 1);
	assert.equal(response.json.deliveries[0].state, state);
	assert.equal(response.json.deliveries[0].reason_code, reason);
	assert.ok(!response.text.includes("The research is done."), response.text);
});

When("the fake provider reports the reply as {string}", async function (this: ChatticusWorld, status: string) {
	const delivery = await latestPublishedDelivery(this);
	assert.ok(delivery.providerMessageId, "The reply was never sent");
	const scenario = channelsScenarioOf(this);
	await processStatusCallback(
		{ runtime: requiredChannelsRuntime(this), clock: this.clock },
		scenario.fake,
		scenario.fake.statusRequest([{ providerMessageId: delivery.providerMessageId, status: status as "delivered" }], this.clock.now()),
	);
});

When("the fake provider reports an unknown message as {string}", async function (this: ChatticusWorld, status: string) {
	const scenario = channelsScenarioOf(this);
	await processStatusCallback(
		{ runtime: requiredChannelsRuntime(this), clock: this.clock },
		scenario.fake,
		scenario.fake.statusRequest([{ providerMessageId: "never-sent", status: status as "complained" }], this.clock.now()),
	);
});
