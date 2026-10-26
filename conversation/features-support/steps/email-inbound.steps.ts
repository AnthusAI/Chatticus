import assert from "node:assert/strict";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import { linkExternalIdentity } from "../../src/channels/binding-service.ts";
import { channelCorrelatorTag } from "../../src/channels/channel-correlator.ts";
import { EmailChannelTransport, emailInboundRequest, type InboundMailEnvelope } from "../../src/channels/email/email-transport.ts";
import { listMessages } from "../../src/domain/messages.ts";
import { ingestInbound } from "../../src/channels/inbound-admission.ts";
import type { ChannelTransport, InboundEvent, RawInbound } from "../../src/channels/transport.ts";
import { identityOfPerson, tenantIdOfOrganization } from "../bot-board-support.ts";
import { SCENARIO_CORRELATOR_SECRET, admissionDependenciesFor, emailTransportFor, channelsScenarioOf, requiredChannelsRuntime } from "../channels-support.ts";
import { executorMessageDependencies } from "../front-door.ts";
import type { ChatticusWorld } from "../world.ts";

type Verdicts = { spf: string; dkim: string; dmarc: string; spam: string; virus: string };

const PASSING_VERDICTS: Verdicts = { spf: "PASS", dkim: "PASS", dmarc: "PASS", spam: "PASS", virus: "PASS" };

type EmailScenario = {
	lastElapsedMilliseconds: number;
	verdicts: Verdicts;
	readonly events: InboundEvent[];
	knownTag: string | null;
	fetchCalls: number;
};

const emailScenarios = new WeakMap<ChatticusWorld, EmailScenario>();

function emailScenarioOf(world: ChatticusWorld): EmailScenario {
	let scenario = emailScenarios.get(world);
	if (scenario === undefined) {
		scenario = { lastElapsedMilliseconds: 0, verdicts: PASSING_VERDICTS, events: [], knownTag: null, fetchCalls: 0 };
		emailScenarios.set(world, scenario);
	}
	return scenario;
}

class RecordingEmailTransport extends EmailChannelTransport {
	private readonly recorded: InboundEvent[];

	constructor(options: ConstructorParameters<typeof EmailChannelTransport>[0], recorded: InboundEvent[]) {
		super(options);
		this.recorded = recorded;
	}

	override normalize(verified: Parameters<EmailChannelTransport["normalize"]>[0]): InboundEvent[] {
		const events = super.normalize(verified);
		this.recorded.push(...events);
		return events;
	}
}

const tenantOf = tenantIdOfOrganization;

function addressesIn(text: string): string[] {
	return [...text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g)].map((match) => match[0]);
}

function recipientsOfRaw(raw: string): string[] {
	const headerBlock = raw.split(/\r?\n\r?\n/)[0] ?? "";
	return headerBlock
		.split(/\r?\n/)
		.filter((line) => /^(to|cc|bcc):/i.test(line))
		.flatMap(addressesIn);
}

export async function deliverRaw(world: ChatticusWorld, rawMessage: Uint8Array, recipients: readonly string[]): Promise<void> {
	const scenario = channelsScenarioOf(world);
	const email = emailScenarioOf(world);
	const verdicts = email.verdicts;
	email.verdicts = PASSING_VERDICTS;
	const envelope: InboundMailEnvelope = {
		spfVerdict: verdicts.spf,
		dkimVerdict: verdicts.dkim,
		dmarcVerdict: verdicts.dmarc,
		spamVerdict: verdicts.spam,
		virusVerdict: verdicts.virus,
		envelopeRecipients: recipients,
		providerMessageId: null,
		rawReference: "raw/scenario-message",
	};
	scenario.lastRequest = emailInboundRequest(rawMessage, envelope, world.clock.now());
	await deliverLastEmailRequest(world);
}

async function deliverLastEmailRequest(world: ChatticusWorld): Promise<void> {
	const scenario = channelsScenarioOf(world);
	const email = emailScenarioOf(world);
	assert.ok(scenario.lastRequest, "No request has been made");
	const transport: ChannelTransport = emailTransportFor(
		world,
		requiredChannelsRuntime(world).metrics,
		class extends RecordingEmailTransport {
			constructor(options: ConstructorParameters<typeof EmailChannelTransport>[0]) {
				super(options, email.events);
			}
		},
	);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => {
		email.fetchCalls += 1;
		throw new Error("The email adapter must never fetch remote content");
	}) as typeof fetch;
	const startedAt = performance.now();
	try {
		const result = await ingestInbound(await admissionDependenciesFor(world), transport, scenario.lastRequest as RawInbound);
		if (result.kind === "refused") {
			scenario.lastRefusal = result.refusal;
			return;
		}
		scenario.lastRefusal = null;
		scenario.outcomes.push(...result.outcomes);
	} finally {
		email.lastElapsedMilliseconds = performance.now() - startedAt;
		globalThis.fetch = originalFetch;
	}
}

function crlf(text: string): string {
	return `${text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n")}\r\n`;
}

function wrappedIds(list: string): string {
	return list
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id !== "")
		.map((id) => `<${id}>`)
		.join(" ");
}

export function rawEmailOfTable(world: ChatticusWorld, table: DataTable, bodyOverride?: string): { raw: string; recipients: string[] } {
	const row = table.rowsHash();
	const tag = emailScenarioOf(world).knownTag ?? "";
	const withTag = (value: string | undefined): string | undefined => value?.replace("{tag}", tag).replace(/ AT /g, "@");
	const lines: string[] = [];
	const header = (name: string, value: string | undefined): void => {
		if (value !== undefined) lines.push(`${name}: ${value}`);
	};
	header("From", withTag(row["from"]));
	header("To", withTag(row["to"]));
	header("Cc", withTag(row["cc"]));
	header("Reply-To", row["reply-to"]);
	header("Subject", row["subject"]);
	if (row["id"] !== undefined) header("Message-ID", `<${withTag(row["id"])}>`);
	if (row["in-reply-to"] !== undefined) header("In-Reply-To", wrappedIds(row["in-reply-to"]));
	if (row["references"] !== undefined) header("References", wrappedIds(row["references"]));
	header("Date", "Mon, 26 Oct 2026 09:00:00 +0000");
	header("MIME-Version", "1.0");
	header("Content-Type", "text/plain; charset=utf-8");
	for (const extra of (row["headers"] ?? "").split(";;").map((entry) => entry.trim()).filter((entry) => entry !== "")) lines.push(extra);
	const body = bodyOverride ?? (row["body"] ?? "").replace(/\\n/g, "\n");
	const raw = crlf(`${lines.join("\n")}\n\n${body}`);
	const recipients = (row["envelope"] === undefined ? [row["to"], row["cc"], row["bcc"]] : [row["envelope"]]).flatMap((value) => addressesIn(withTag(value) ?? ""));
	return { raw, recipients };
}

Given("the email sender {string} is linked to {string} in {string}", async function (this: ChatticusWorld, sender: string, person: string, organization: string) {
	const tenantId = tenantOf(organization);
	const linked = await linkExternalIdentity(
		{ runtime: requiredChannelsRuntime(this), store: this.messagingStore(), ids: this.ids, clock: this.clock },
		tenantId,
		{ provider: "email", externalId: sender, userId: identityOfPerson(tenantId, person).userId, linkedBy: "scenario" },
	);
	assert.ok(linked.ok, JSON.stringify(linked));
});

Given("the next email carries the verdicts:", function (this: ChatticusWorld, table: DataTable) {
	const row = table.rowsHash();
	emailScenarioOf(this).verdicts = { spf: row["spf"]!, dkim: row["dkim"]!, dmarc: row["dmarc"]!, spam: row["spam"]!, virus: row["virus"]! };
});

When("an email arrives:", async function (this: ChatticusWorld, table: DataTable) {
	const { raw, recipients } = rawEmailOfTable(this, table);
	await deliverRaw(this, Buffer.from(raw, "latin1"), recipients);
});

When("an email arrives with a body of {int} characters:", async function (this: ChatticusWorld, characters: number, table: DataTable) {
	const words = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(Math.ceil(characters / 56) + 1);
	const body = words.slice(0, characters).replace(/(.{70})/g, "$1\n");
	const { raw, recipients } = rawEmailOfTable(this, table, body);
	await deliverRaw(this, Buffer.from(raw, "latin1"), recipients);
});

When("this raw email arrives:", async function (this: ChatticusWorld, docString: string) {
	const raw = crlf(docString);
	await deliverRaw(this, Buffer.from(raw, "latin1"), recipientsOfRaw(raw));
});

When("a raw email of {int} megabytes arrives", async function (this: ChatticusWorld, megabytes: number) {
	const head = Buffer.from(crlf("From: sam.sender@example.test\nTo: researcher@anthus.mail.develop.example.test\nSubject: Huge\nMessage-ID: <huge-1@mail.example.test>\n\n"), "latin1");
	const padding = Buffer.alloc(megabytes * 1024 * 1024, 0x61);
	await deliverRaw(this, Buffer.concat([head, padding]), []);
});

When("an HTML email made of {int} repeats of {string} arrives", async function (this: ChatticusWorld, repeats: number, fragment: string) {
	const head = "From: sam.sender@example.test\nTo: researcher@anthus.mail.develop.example.test\nSubject: Hostile\nMessage-ID: <hostile-1@mail.example.test>\nContent-Type: text/html; charset=utf-8\n\n";
	await deliverRaw(this, Buffer.from(crlf(head + fragment.replaceAll("{space}", " ").repeat(repeats)), "latin1"), ["researcher@anthus.mail.develop.example.test"]);
});

When("a raw email with a subject of {int} encoded words arrives", async function (this: ChatticusWorld, words: number) {
	const subject = "=?UTF-8?B?QQ==?= ".repeat(words);
	const head = `From: sam.sender@example.test\nTo: researcher@anthus.mail.develop.example.test\nSubject: ${subject}\nMessage-ID: <words-1@mail.example.test>\n\nBody\n`;
	await deliverRaw(this, Buffer.from(crlf(head), "latin1"), ["researcher@anthus.mail.develop.example.test"]);
});

Then("the email was processed within {int} seconds", function (this: ChatticusWorld, seconds: number) {
	assert.ok(emailScenarioOf(this).lastElapsedMilliseconds < seconds * 1000, `Took ${Math.round(emailScenarioOf(this).lastElapsedMilliseconds)} ms`);
});

When("the same email request is delivered {int} more times", async function (this: ChatticusWorld, times: number) {
	for (let index = 0; index < times; index += 1) await deliverLastEmailRequest(this);
});

Given("the plus tag of the external channel of {string} in {string} is known", async function (this: ChatticusWorld, person: string, organization: string) {
	const tenantId = tenantOf(organization);
	const channels = await this.messagingStore().listChannels(tenantId, identityOfPerson(tenantId, person).userId);
	const external = channels.filter((channel) => channel.kind === "external");
	assert.equal(external.length, 1, `Expected one external channel for ${person}`);
	emailScenarioOf(this).knownTag = channelCorrelatorTag(SCENARIO_CORRELATOR_SECRET, tenantId, external[0]!.channelId);
});

Then("the email was refused as {string}", function (this: ChatticusWorld, reason: string) {
	const refusal = channelsScenarioOf(this).lastRefusal;
	assert.ok(refusal, "The email was not refused");
	assert.equal(refusal.reason, reason);
	assert.equal(channelsScenarioOf(this).outcomes.length, 0);
});

Then("no remote content was fetched", function (this: ChatticusWorld) {
	assert.equal(emailScenarioOf(this).fetchCalls, 0);
});

function parsedEvent(world: ChatticusWorld): InboundEvent {
	const events = emailScenarioOf(world).events;
	const last = events[events.length - 1];
	assert.ok(last, "No email was parsed");
	return last;
}

Then("the parsed email is from {string} with the display name {string}", function (this: ChatticusWorld, address: string, name: string) {
	assert.equal(parsedEvent(this).sender.externalId, address);
	assert.equal(parsedEvent(this).sender.displayName, name);
});

Then("the parsed email is from {string} with no display name", function (this: ChatticusWorld, address: string) {
	assert.equal(parsedEvent(this).sender.externalId, address);
	assert.equal(parsedEvent(this).sender.displayName, null);
});

Then("the parsed email is addressed to {string}", function (this: ChatticusWorld, address: string) {
	assert.equal(parsedEvent(this).bindingRouteKey, address);
});

Then("the parsed email has the subject {string} and the message id {string}", function (this: ChatticusWorld, subject: string, messageId: string) {
	assert.equal(parsedEvent(this).subject, subject);
	assert.equal(parsedEvent(this).externalMessageId, messageId);
});

Then("the parsed email has the conversation key {string} and references nothing", function (this: ChatticusWorld, key: string) {
	assert.equal(parsedEvent(this).conversationKey, key);
	assert.deepEqual(parsedEvent(this).referencedExternalMessageIds, []);
});

Then("the parsed email has the conversation key {string}", function (this: ChatticusWorld, key: string) {
	assert.equal(parsedEvent(this).conversationKey, key);
});

Then("the parsed email references, nearest first, {string}", function (this: ChatticusWorld, list: string) {
	assert.deepEqual(parsedEvent(this).referencedExternalMessageIds, list.split(","));
});

Then("the parsed email says the sender was proven by {string}", function (this: ChatticusWorld, assertion: string) {
	assert.equal(parsedEvent(this).sender.assertion, assertion);
});

Then(
	"the parsed email lists the attachment {string} of type {string} with {int} bytes and no storage key",
	function (this: ChatticusWorld, fileName: string, contentType: string, sizeBytes: number) {
		assert.deepEqual(parsedEvent(this).attachments, [{ storageKey: null, fileName, contentType, sizeBytes }]);
	},
);

Then("the parsed email carries the automation hint {string}", function (this: ChatticusWorld, hint: string) {
	const hints = parsedEvent(this).automationHints as unknown as Record<string, boolean>;
	assert.equal(hints[hint], true, JSON.stringify(hints));
});

async function latestExternalMessageText(world: ChatticusWorld, person: string, organization: string): Promise<string> {
	const tenantId = tenantOf(organization);
	const store = world.messagingStore();
	const dependencies = await executorMessageDependencies(world);
	const channels = (await store.listChannels(tenantId, identityOfPerson(tenantId, person).userId)).filter((channel) => channel.kind === "external");
	assert.ok(channels.length > 0, `${person} has no external channel`);
	let latest: { body: string; createdAt: number } | null = null;
	for (const channel of channels) {
		const messages = await listMessages(dependencies, { tenantId, channelId: channel.channelId, afterSeq: 0 });
		const last = messages[messages.length - 1];
		if (last !== undefined && (latest === null || last.createdAt.getTime() >= latest.createdAt)) latest = { body: last.body, createdAt: last.createdAt.getTime() };
	}
	assert.ok(latest, `${person} has no message`);
	return latest.body;
}

Then("the latest message on the external channel of {string} in {string} reads {string}", async function (this: ChatticusWorld, person: string, organization: string, text: string) {
	assert.equal(await latestExternalMessageText(this, person, organization), text);
});

Then("the latest message on the external channel of {string} in {string} contains {string}", async function (this: ChatticusWorld, person: string, organization: string, text: string) {
	assert.ok((await latestExternalMessageText(this, person, organization)).includes(text), `The message does not contain ${text}`);
});

Then("the latest message on the external channel of {string} in {string} does not contain {string}", async function (this: ChatticusWorld, person: string, organization: string, text: string) {
	assert.ok(!(await latestExternalMessageText(this, person, organization)).includes(text), `The message contains ${text}`);
});

Then(
	"the latest message on the external channel of {string} in {string} has at most {int} characters and ends with {string}",
	async function (this: ChatticusWorld, person: string, organization: string, limit: number, ending: string) {
		const text = await latestExternalMessageText(this, person, organization);
		assert.ok(text.length <= limit, `The message has ${text.length} characters`);
		assert.ok(text.endsWith(ending), text.slice(-120));
	},
);
