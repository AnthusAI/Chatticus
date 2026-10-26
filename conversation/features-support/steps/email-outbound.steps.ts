import assert from "node:assert/strict";
import { DataTable, Given, Then, When } from "@cucumber/cucumber";
import PostalMime, { type Email } from "postal-mime";
import { applyEmailStatusCallback } from "../../src/channels/email/email-status-callback.ts";
import type { EmailChannelTransport } from "../../src/channels/email/email-transport.ts";
import { TransportDeliveryError, type RawInbound } from "../../src/channels/transport.ts";
import { tenantIdOfOrganization } from "../bot-board-support.ts";
import { channelsScenarioOf, emailTransportFor, requiredChannelsRuntime, suppressionListFor } from "../channels-support.ts";
import type { ChatticusWorld } from "../world.ts";
import { deliverRaw, rawEmailOfTable } from "./email-inbound.steps.ts";

const BOT_ADDRESS = "researcher@anthus.mail.develop.example.test";

type OutboundScenario = { transport: EmailChannelTransport | null; lastFailure: TransportDeliveryError | null; lastIdempotencyKey: string; lastPayloadInput: DirectReply | null; directSends: number };
type DirectReply = { recipient: string; subject: string | null; body: string };

const outboundScenarios = new WeakMap<ChatticusWorld, OutboundScenario>();

function outboundScenarioOf(world: ChatticusWorld): OutboundScenario {
	let scenario = outboundScenarios.get(world);
	if (scenario === undefined) {
		scenario = { transport: null, lastFailure: null, lastIdempotencyKey: "", lastPayloadInput: null, directSends: 0 };
		outboundScenarios.set(world, scenario);
	}
	return scenario;
}

const decodedEscapes = (text: string): string => text.replace(/\\r/g, "\r").replace(/\\n/g, "\n");

function lastSend(world: ChatticusWorld): { request: { rawMessage: Uint8Array; destinations: readonly string[]; configurationSetName: string }; messageId: string } {
	const sends = channelsScenarioOf(world).ses.sends;
	const last = sends[sends.length - 1];
	assert.ok(last, "SES sent nothing");
	return last;
}

async function parsedLastSend(world: ChatticusWorld): Promise<Email> {
	return PostalMime.parse(lastSend(world).request.rawMessage);
}

function headerValues(email: Email, name: string): string[] {
	return email.headers.filter((header) => header.key === name.toLowerCase()).map((header) => header.value);
}

Given(
	"outbound email goes through a fake SES client with the configuration set {string} and the web app at {string}",
	function (this: ChatticusWorld, configurationSetName: string, webAppBaseUrl: string) {
		const scenario = channelsScenarioOf(this);
		scenario.configurationSetName = configurationSetName;
		scenario.webAppBaseUrl = webAppBaseUrl;
	},
);

Given("SES will fail the next send as {string}", function (this: ChatticusWorld, kind: string) {
	channelsScenarioOf(this).ses.failNextSend(kind as Parameters<ReturnType<typeof channelsScenarioOf>["ses"]["failNextSend"]>[0]);
});

Then("the fake SES was asked to send {int} mail(s)", function (this: ChatticusWorld, count: number) {
	assert.equal(channelsScenarioOf(this).ses.sends.length, count);
});

Then("the sent mail was addressed to exactly {string}", function (this: ChatticusWorld, address: string) {
	assert.deepEqual(lastSend(this).request.destinations, [address]);
});

Then("the sent mail went out through the configuration set {string}", function (this: ChatticusWorld, name: string) {
	assert.equal(lastSend(this).request.configurationSetName, name);
});

Then("the sent mail has the header {string} of {string}", async function (this: ChatticusWorld, name: string, expected: string) {
	const tag = await knownTag(this);
	assert.deepEqual(headerValues(await parsedLastSend(this), name), [expected.replace("{tag}", tag)]);
});

async function knownTag(world: ChatticusWorld): Promise<string> {
	const reply = (await parsedLastSend(world)).headers.find((header) => header.key === "reply-to")?.value ?? "";
	return /\+([a-z2-7]+)@/.exec(reply)?.[1] ?? "";
}

Then("the sent mail has no {string} header", async function (this: ChatticusWorld, name: string) {
	assert.deepEqual(headerValues(await parsedLastSend(this), name), []);
});

Then("the sent mail has the subject {string}", async function (this: ChatticusWorld, subject: string) {
	assert.equal((await parsedLastSend(this)).subject, subject);
	assert.deepEqual(headerValues(await parsedLastSend(this), "subject").length, 1);
});

Then("the sent mail is plain text reading {string}", async function (this: ChatticusWorld, text: string) {
	const email = await parsedLastSend(this);
	assert.equal(email.text?.trim(), text);
	assert.equal(email.html, undefined);
	assert.ok(headerValues(email, "content-type")[0]?.startsWith("text/plain"));
});

Then("the sent mail has a Message-ID on the domain {string}", async function (this: ChatticusWorld, domain: string) {
	const ids = headerValues(await parsedLastSend(this), "message-id");
	assert.equal(ids.length, 1);
	assert.match(ids[0]!, new RegExp(`^<chatticus\\.[0-9a-f]{20}\\.[0-9a-f]{12}@${domain.replaceAll(".", "\\.")}>$`));
});

Then("the sent mail text has at most {int} characters", async function (this: ChatticusWorld, limit: number) {
	const text = (await parsedLastSend(this)).text ?? "";
	assert.ok(text.length <= limit, `The text has ${text.length} characters`);
});

Then("the sent mail text ends with {string}", async function (this: ChatticusWorld, ending: string) {
	assert.ok(((await parsedLastSend(this)).text ?? "").trimEnd().endsWith(ending));
});

Then("the sent mail text starts with {string}", async function (this: ChatticusWorld, beginning: string) {
	assert.ok(((await parsedLastSend(this)).text ?? "").startsWith(beginning));
});

const DIRECT_MESSAGE = (world: ChatticusWorld, body: string) => ({
	messageId: "direct-message-1",
	channelId: "direct-channel-1",
	tenantId: tenantIdOfOrganization("Anthus Labs"),
	seq: 2,
	body,
	createdAt: world.clock.now(),
});

async function sendDirectly(world: ChatticusWorld, reply: DirectReply, idempotencyKey: string): Promise<void> {
	const scenario = outboundScenarioOf(world);
	const transport = (scenario.transport ??= emailTransportFor(world, requiredChannelsRuntime(world).metrics));
	const binding = { bindingId: "direct-binding-1", tenantId: tenantIdOfOrganization("Anthus Labs"), provider: "email" as const, routeKey: BOT_ADDRESS };
	const payload = transport.render(DIRECT_MESSAGE(world, reply.body), binding, {
		conversationKey: "root-1@mail.example.test",
		recipientExternalId: reply.recipient,
		inReplyToExternalMessageId: "root-1@mail.example.test",
		subject: reply.subject,
	});
	scenario.lastFailure = null;
	scenario.lastIdempotencyKey = idempotencyKey;
	scenario.lastPayloadInput = reply;
	try {
		await transport.deliver(payload, binding, idempotencyKey);
	} catch (error) {
		assert.ok(error instanceof TransportDeliveryError, String(error));
		scenario.lastFailure = error;
	}
}

When("the email transport sends a reply to {string} in a thread whose subject is {string}", async function (this: ChatticusWorld, recipient: string, subject: string) {
	outboundScenarioOf(this).directSends += 1;
	await sendDirectly(this, { recipient: decodedEscapes(recipient), subject: decodedEscapes(subject), body: "Hello." }, `direct-${outboundScenarioOf(this).directSends}`);
});

When("the email transport sends a reply of {int} characters to {string}", async function (this: ChatticusWorld, characters: number, recipient: string) {
	let body = "";
	for (let index = 0; body.length < characters; index += 1) body += `word-${index} `;
	await sendDirectly(this, { recipient, subject: "Long", body: body.slice(0, characters) }, "direct-long");
});

When("the same reply is sent again with the same idempotency key", async function (this: ChatticusWorld) {
	const scenario = outboundScenarioOf(this);
	assert.ok(scenario.lastPayloadInput, "No reply was sent");
	await sendDirectly(this, scenario.lastPayloadInput, scenario.lastIdempotencyKey);
});

Then("the last send failed as {string} with the reason {string}", function (this: ChatticusWorld, failureClass: string, reason: string) {
	const failure = outboundScenarioOf(this).lastFailure;
	assert.ok(failure, "The send did not fail");
	assert.equal(failure.failureClass, failureClass);
	assert.equal(failure.reasonCode, reason);
});

When(
	"the sender answers the last sent mail with the id {string} and the body {string}",
	async function (this: ChatticusWorld, id: string, body: string) {
		const sent = await parsedLastSend(this);
		const sentId = (headerValues(sent, "message-id")[0] ?? "").replace(/^<|>$/g, "");
		const references = (headerValues(sent, "references")[0] ?? "").split(/\s+/).map((value) => value.replace(/^<|>$/g, ""));
		const table = new DataTable([
			["from", "sam.sender@example.test"],
			["to", BOT_ADDRESS],
			["subject", "Re: Quarterly plan"],
			["id", id],
			["in-reply-to", sentId],
			["references", [...references, sentId].join(",")],
			["body", body],
		]);
		const { raw, recipients } = rawEmailOfTable(this, table);
		await deliverRaw(this, Buffer.from(raw, "latin1"), recipients);
	},
);

When("the last sent mail comes back to the bot address without its automation headers", async function (this: ChatticusWorld) {
	const raw = Buffer.from(lastSend(this).request.rawMessage).toString("latin1");
	const stripped = raw
		.split("\r\n")
		.filter((line) => !/^(x-chatticus-origin|x-chatticus-hops|auto-submitted):/i.test(line))
		.join("\r\n");
	await deliverRaw(this, Buffer.from(stripped, "latin1"), [BOT_ADDRESS]);
});

Then("the mail that came back was refused as {string}", function (this: ChatticusWorld, reason: string) {
	const refusal = channelsScenarioOf(this).lastRefusal;
	assert.ok(refusal, "The mail was not refused");
	assert.equal(refusal.reason, reason);
});

async function processNotification(world: ChatticusWorld, body: string): Promise<void> {
	const runtime = requiredChannelsRuntime(world);
	const transport = emailTransportFor(world, runtime.metrics);
	const raw: RawInbound = { provider: "email", headers: {}, body, receivedAt: world.clock.now() };
	await applyEmailStatusCallback({ runtime, clock: world.clock, suppressionList: suppressionListFor(world) }, transport, raw);
}

function notificationBody(world: ChatticusWorld, eventType: string, bounceType: string | null, recipient: string | null): string {
	const event: Record<string, unknown> = { eventType, mail: { messageId: lastSend(world).messageId } };
	const recipients = recipient === null ? [] : [{ emailAddress: recipient }];
	if (eventType === "Bounce") event["bounce"] = { bounceType, bounceSubType: "General", bouncedRecipients: recipients };
	if (eventType === "Complaint") event["complaint"] = { complaintFeedbackType: "abuse", complainedRecipients: recipients };
	return JSON.stringify({ Type: "Notification", Message: JSON.stringify(event) });
}

When("SES reports {string} for the last sent mail", async function (this: ChatticusWorld, eventType: string) {
	await processNotification(this, notificationBody(this, eventType, null, null));
});

When("SES reports {string} for the last sent mail to {string}", async function (this: ChatticusWorld, eventType: string, recipient: string) {
	await processNotification(this, notificationBody(this, eventType, null, recipient));
});

When("SES reports {string} of type {string} for the last sent mail to {string}", async function (this: ChatticusWorld, eventType: string, bounceType: string, recipient: string) {
	await processNotification(this, notificationBody(this, eventType, bounceType, recipient));
});

When("this notification arrives from SNS: {}", async function (this: ChatticusWorld, body: string) {
	await processNotification(this, body);
});

async function emailBindingIdOfBot(world: ChatticusWorld, botName: string, organization: string): Promise<string> {
	const tenantId = tenantIdOfOrganization(organization);
	const bot = world.botsByName?.get(botName);
	assert.ok(bot, `The scenario has no bot ${botName}`);
	const binding = (await requiredChannelsRuntime(world).store.listBindings(tenantId)).find((candidate) => candidate.provider === "email" && candidate.botId === bot.botId);
	assert.ok(binding, `${botName} has no email binding`);
	return binding.bindingId;
}

Then("{string} is suppressed for the email binding of the bot {string} in {string}", async function (this: ChatticusWorld, address: string, botName: string, organization: string) {
	assert.equal(await suppressionListFor(this).isSuppressed(tenantIdOfOrganization(organization), await emailBindingIdOfBot(this, botName, organization), address), true);
});

Then("{string} is not suppressed for the email binding of the bot {string} in {string}", async function (this: ChatticusWorld, address: string, botName: string, organization: string) {
	assert.equal(await suppressionListFor(this).isSuppressed(tenantIdOfOrganization(organization), await emailBindingIdOfBot(this, botName, organization), address), false);
});

