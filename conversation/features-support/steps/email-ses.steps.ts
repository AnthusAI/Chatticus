import assert from "node:assert/strict";
import { createPrivateKey, createSign, randomUUID, type KeyObject } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataTable, Given, Then, When } from "@cucumber/cucumber";
import { deliverChannelMessage } from "../../src/channels/delivery.ts";
import { RetryableDeliveryError, handleChannelMessageCreated, type ChannelMessageCreatedBusEvent } from "../../src/channels/email/mail-delivery-handler.ts";
import { InboundInFlightError, RawMailMissingError, handleMailReceipt, type SesReceiptEvent } from "../../src/channels/email/mail-ingress-handler.ts";
import { handleSesStatusEvent, type SnsEvent } from "../../src/channels/email/mail-status-handler.ts";
import type { RawMailReader } from "../../src/channels/email/raw-mail-store.ts";
import type { SigningCertificateSource } from "../../src/channels/email/sns-signature.ts";
import { INBOUND_CLAIM_LEASE_SECONDS, dropAutomatedMessages } from "../../src/channels/inbound-admission.ts";
import { tenantIdOfOrganization } from "../bot-board-support.ts";
import { admissionDependenciesFor, channelsScenarioOf, deliveryDependenciesFor, emailTransportFor, requiredChannelsRuntime, suppressionListFor } from "../channels-support.ts";
import { runBotTurn } from "../executor-harness.ts";
import type { ChatticusWorld } from "../world.ts";
import { deliverRaw, rawEmailOfTable } from "./email-inbound.steps.ts";

const BOT_ADDRESS = "researcher@anthus.mail.develop.example.test";
const DEFAULT_TOPIC_ARN = "arn:aws:sns:us-east-1:111122223333:chatticus-development-mail-events";
const DEFAULT_REGION = "us-east-1";
const ARCHIVE_BUCKET = "scenario-raw-mail";

type Verdicts = { spf: string; dkim: string; dmarc: string; spam: string; virus: string };
const PASSING: Verdicts = { spf: "PASS", dkim: "PASS", dmarc: "PASS", spam: "PASS", virus: "PASS" };

class FakeArchive implements RawMailReader {
	readonly objects = new Map<string, Uint8Array>();
	readonly reads: string[] = [];

	async read(key: string): Promise<Uint8Array | null> {
		this.reads.push(key);
		return this.objects.get(key) ?? null;
	}
}

class FakeCertificates implements SigningCertificateSource {
	readonly fetched: string[] = [];
	unavailable = false;
	pem = "";

	async fetch(url: string): Promise<string> {
		this.fetched.push(url);
		if (this.unavailable) throw new Error("The certificate source is unavailable.");
		return this.pem;
	}
}

type Keys = { readonly privateKey: KeyObject; readonly certificatePem: string };

let cachedKeys: { primary: Keys; other: Keys } | null = null;

function generatedKeys(): Keys {
	const directory = mkdtempSync(join(tmpdir(), "sns-test-key-"));
	try {
		const keyFile = join(directory, "key.pem");
		const certificateFile = join(directory, "certificate.pem");
		execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certificateFile, "-subj", "/CN=sns-test", "-days", "2"], { stdio: "ignore" });
		return { privateKey: createPrivateKey(readFileSync(keyFile, "utf8")), certificatePem: readFileSync(certificateFile, "utf8") };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function testKeys(): { primary: Keys; other: Keys } {
	cachedKeys ??= { primary: generatedKeys(), other: generatedKeys() };
	return cachedKeys;
}

type Notification = Record<string, unknown>;

type SesScenario = {
	readonly archive: FakeArchive;
	readonly recipients: Map<string, string[]>;
	readonly verdicts: Map<string, Verdicts>;
	lastResult: { kind: "success" } | { kind: "failure"; error: unknown } | null;
	lastBusEvent: ChannelMessageCreatedBusEvent | null;
	readonly certificates: FakeCertificates;
	topicArn: string;
	region: string;
	lastNotification: Notification | null;
	subscribeFetches: number;
	lastDelivery: { kind: "success" } | { kind: "failure"; error: unknown } | null;
	lastStatus: { kind: "success" } | { kind: "failure"; error: unknown } | null;
};

const scenarios = new WeakMap<ChatticusWorld, SesScenario>();

function sesOf(world: ChatticusWorld): SesScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		const certificates = new FakeCertificates();
		certificates.pem = testKeys().primary.certificatePem;
		scenario = {
			archive: new FakeArchive(),
			recipients: new Map(),
			verdicts: new Map(),
			lastResult: null,
			lastBusEvent: null,
			certificates,
			topicArn: DEFAULT_TOPIC_ARN,
			region: DEFAULT_REGION,
			lastNotification: null,
			subscribeFetches: 0,
			lastDelivery: null,
			lastStatus: null,
		};
		scenarios.set(world, scenario);
	}
	return scenario;
}

function crlfText(text: string): string {
	return `${text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n")}\r\n`;
}

Given("the raw mail archive holds the message {string}:", function (this: ChatticusWorld, sesMessageId: string, table: DataTable) {
	const { raw, recipients } = rawEmailOfTable(this, table);
	const scenario = sesOf(this);
	scenario.archive.objects.set(`raw/${sesMessageId}`, Buffer.from(raw, "latin1"));
	scenario.recipients.set(sesMessageId, recipients);
});

Given("the raw mail archive holds the raw message {string}:", function (this: ChatticusWorld, sesMessageId: string, docString: string) {
	const scenario = sesOf(this);
	const raw = crlfText(docString);
	scenario.archive.objects.set(`raw/${sesMessageId}`, Buffer.from(raw, "latin1"));
	scenario.recipients.set(sesMessageId, [BOT_ADDRESS]);
});

Given("SES reports the verdicts of the message {string}:", function (this: ChatticusWorld, sesMessageId: string, table: DataTable) {
	const row = table.rowsHash();
	sesOf(this).verdicts.set(sesMessageId, { spf: row["spf"]!, dkim: row["dkim"]!, dmarc: row["dmarc"]!, spam: row["spam"]!, virus: row["virus"]! });
});

function receiptRecord(world: ChatticusWorld, sesMessageId: string): NonNullable<SesReceiptEvent["Records"]>[number] {
	const scenario = sesOf(world);
	const verdicts = scenario.verdicts.get(sesMessageId) ?? PASSING;
	const verdict = (status: string) => ({ status });
	return {
		ses: {
			mail: { messageId: sesMessageId },
			receipt: {
				timestamp: world.clock.now().toISOString(),
				recipients: scenario.recipients.get(sesMessageId) ?? [BOT_ADDRESS],
				spfVerdict: verdict(verdicts.spf),
				dkimVerdict: verdict(verdicts.dkim),
				dmarcVerdict: verdict(verdicts.dmarc),
				spamVerdict: verdict(verdicts.spam),
				virusVerdict: verdict(verdicts.virus),
			},
		},
	};
}

async function invokeIngress(world: ChatticusWorld, records: NonNullable<SesReceiptEvent["Records"]>): Promise<void> {
	const scenario = sesOf(world);
	const channels = channelsScenarioOf(world);
	const admission = await admissionDependenciesFor(world);
	const transport = admission.runtime.transports.get("email");
	assert.ok(transport, "The runtime has no email transport");
	scenario.archive.reads.length = 0;
	try {
		const outcomes = await handleMailReceipt({ admission: { ...admission, automation: dropAutomatedMessages }, transport, archive: scenario.archive, archiveBucket: ARCHIVE_BUCKET }, { Records: records });
		channels.outcomes.push(...outcomes);
		scenario.lastResult = { kind: "success" };
	} catch (error) {
		scenario.lastResult = { kind: "failure", error };
	}
}

When("SES invokes the ingress function for the message {string}", async function (this: ChatticusWorld, sesMessageId: string) {
	await invokeIngress(this, [receiptRecord(this, sesMessageId)]);
});

When("SES invokes the ingress function for the message {string} again", async function (this: ChatticusWorld, sesMessageId: string) {
	await invokeIngress(this, [receiptRecord(this, sesMessageId)]);
});

When("SES invokes the ingress function for the messages {string} and {string}", async function (this: ChatticusWorld, first: string, second: string) {
	await invokeIngress(this, [receiptRecord(this, first), receiptRecord(this, second)]);
});

When("SES invokes the ingress function with the message id {string}", async function (this: ChatticusWorld, sesMessageId: string) {
	await invokeIngress(this, [receiptRecord(this, sesMessageId)]);
});

Then("the ingress function succeeded", function (this: ChatticusWorld) {
	const result = sesOf(this).lastResult;
	assert.ok(result, "The ingress function was not invoked");
	assert.equal(result.kind, "success", result.kind === "failure" ? String(result.error) : "");
});

Then("the ingress function failed because the message is still in flight", function (this: ChatticusWorld) {
	const result = sesOf(this).lastResult;
	assert.ok(result?.kind === "failure" && result.error instanceof InboundInFlightError, JSON.stringify(result));
});

Then("the ingress function failed because the archive has no object for the message", function (this: ChatticusWorld) {
	const result = sesOf(this).lastResult;
	assert.ok(result?.kind === "failure" && result.error instanceof RawMailMissingError, JSON.stringify(result));
});

Then("nothing was admitted", function (this: ChatticusWorld) {
	assert.deepEqual(channelsScenarioOf(this).outcomes.filter((outcome) => outcome.kind === "admitted"), []);
	assert.equal(channelsScenarioOf(this).counted.filter((metric) => metric.name === "inbound_admitted").length, 0);
});

Then("the ingress function read only the archive key {string}", function (this: ChatticusWorld, key: string) {
	assert.deepEqual(sesOf(this).archive.reads, [key]);
});

Then("the ingress function read nothing from the archive", function (this: ChatticusWorld) {
	assert.deepEqual(sesOf(this).archive.reads, []);
});

Given("an earlier invocation claimed the message {string} from {string} and died", async function (this: ChatticusWorld, messageId: string, sender: string) {
	const runtime = requiredChannelsRuntime(this);
	const tenantId = tenantIdOfOrganization("Anthus Labs");
	const binding = (await runtime.store.listBindings(tenantId)).find((candidate) => candidate.provider === "email");
	assert.ok(binding, "The scenario has no email binding");
	const claim = await runtime.store.claimInbound(tenantId, binding.bindingId, `${sender}|${messageId}`, this.clock.now(), INBOUND_CLAIM_LEASE_SECONDS);
	assert.equal(claim.kind, "claimed");
});

Given("an email from {string} to the bot {string} was answered", async function (this: ChatticusWorld, sender: string, botName: string) {
	const table = new DataTable([
		["from", sender],
		["to", BOT_ADDRESS],
		["subject", "Quarterly plan"],
		["id", "root-1@mail.example.test"],
		["body", "Where do we start?"],
	]);
	const { raw, recipients } = rawEmailOfTable(this, table);
	await deliverRaw(this, Buffer.from(raw, "latin1"), recipients);
	assert.equal(await runBotTurn(this, botName), "done");
});

function publishedBusEvent(world: ChatticusWorld): ChannelMessageCreatedBusEvent {
	const published = channelsScenarioOf(world).published;
	const event = published[published.length - 1];
	assert.ok(event, "No delivery event was published");
	return { source: "chatticus.channels", "detail-type": event.detailType, detail: { ...event.detail } };
}

async function invokeDelivery(world: ChatticusWorld, event: ChannelMessageCreatedBusEvent): Promise<void> {
	const scenario = sesOf(world);
	try {
		await handleChannelMessageCreated(await deliveryDependenciesFor(world), event);
		scenario.lastDelivery = { kind: "success" };
	} catch (error) {
		scenario.lastDelivery = { kind: "failure", error };
	}
}

Given("the reply was sent through SES", async function (this: ChatticusWorld) {
	const event = publishedBusEvent(this);
	await deliverChannelMessage(await deliveryDependenciesFor(this), { tenantId: event.detail!.tenant_id as string, messageId: event.detail!.message_id as string, bindingId: event.detail!.binding_id as string });
	assert.equal(channelsScenarioOf(this).ses.sends.length, 1);
});

When("the event bus delivers the reply event to the delivery function", async function (this: ChatticusWorld) {
	await invokeDelivery(this, publishedBusEvent(this));
});

When("the event bus delivers the reply event to the delivery function again", async function (this: ChatticusWorld) {
	await invokeDelivery(this, publishedBusEvent(this));
});

When("the event bus delivers an event from {string} of the type {string} with the ids {string}", async function (this: ChatticusWorld, source: string, detailType: string, ids: string) {
	const real = publishedBusEvent(this);
	const detail: Record<string, unknown> = { ...real.detail };
	if (ids === "no message id") delete detail["message_id"];
	if (ids === "a number as tenant") detail["tenant_id"] = 7;
	await invokeDelivery(this, { source, "detail-type": detailType, detail });
});

When("the event bus delivers an announcement of a reply that was never recorded", async function (this: ChatticusWorld) {
	const real = publishedBusEvent(this);
	await invokeDelivery(this, { ...real, detail: { ...real.detail, message_id: "never-recorded" } });
});

Then("the delivery function succeeded", function (this: ChatticusWorld) {
	const result = sesOf(this).lastDelivery;
	assert.ok(result, "The delivery function was not invoked");
	assert.equal(result.kind, "success", result.kind === "failure" ? String(result.error) : "");
});

Then("the delivery function failed so that the platform retries", function (this: ChatticusWorld) {
	const result = sesOf(this).lastDelivery;
	assert.ok(result?.kind === "failure" && result.error instanceof RetryableDeliveryError, JSON.stringify(result));
});

const base64 = (bytes: Buffer): string => bytes.toString("base64");

function canonicalStringOf(notification: Notification): string {
	const lines: string[] = [];
	const add = (name: string, value: unknown): void => void lines.push(`${name}\n${String(value)}\n`);
	add("Message", notification["Message"]);
	add("MessageId", notification["MessageId"]);
	if (notification["Subject"] !== undefined && notification["Subject"] !== null) add("Subject", notification["Subject"]);
	add("Timestamp", notification["Timestamp"]);
	add("TopicArn", notification["TopicArn"]);
	add("Type", notification["Type"]);
	return lines.join("");
}

type SignOptions = {
	version?: string;
	certificateUrl?: string;
	topicArn?: string;
	signer?: "primary" | "other";
	unsigned?: boolean;
	offsetSeconds?: number;
	type?: string;
	subscriptionTopicArn?: string;
	changeMessageAfterwards?: string;
};

function sesEventBody(world: ChatticusWorld, eventType: string, bounceType: string | null, recipient: string | null, unknownMessage: boolean): string {
	const sends = channelsScenarioOf(world).ses.sends;
	const providerMessageId = unknownMessage ? "ses-message-unknown" : (sends[sends.length - 1]?.messageId ?? "");
	assert.ok(providerMessageId !== "", "SES sent nothing");
	const event: Record<string, unknown> = { eventType, mail: { messageId: providerMessageId } };
	const recipients = recipient === null ? [] : [{ emailAddress: recipient }];
	if (eventType === "Bounce") event["bounce"] = { bounceType, bounceSubType: "General", bouncedRecipients: recipients };
	if (eventType === "Complaint") event["complaint"] = { complaintFeedbackType: "abuse", complainedRecipients: recipients };
	return JSON.stringify(event);
}

function notificationOf(world: ChatticusWorld, message: string, options: SignOptions): { record: SnsEvent["Records"] } {
	const scenario = sesOf(world);
	const keys = testKeys();
	const version = options.version ?? "2";
	const certificateUrl = options.certificateUrl ?? `https://sns.${scenario.region}.amazonaws.com/SimpleNotificationService-test.pem`;
	const stamped = new Date(world.clock.now().getTime() + (options.offsetSeconds ?? 0) * 1000);
	const notification: Notification = {
		Type: options.type ?? "Notification",
		MessageId: randomUUID(),
		TopicArn: options.topicArn ?? scenario.topicArn,
		Subject: null,
		Message: message,
		Timestamp: stamped.toISOString(),
	};
	if (options.unsigned !== true) {
		const signer = createSign(version === "1" ? "RSA-SHA1" : "RSA-SHA256").update(canonicalStringOf(notification), "utf8");
		notification["Signature"] = base64(signer.sign((options.signer === "other" ? keys.other : keys.primary).privateKey));
	}
	notification["SignatureVersion"] = version;
	notification["SigningCertUrl"] = certificateUrl;
	if (options.changeMessageAfterwards !== undefined) notification["Message"] = options.changeMessageAfterwards;
	scenario.lastNotification = notification;
	return {
		record: [
			{
				EventSource: "aws:sns",
				EventSubscriptionArn: `${options.subscriptionTopicArn ?? options.topicArn ?? scenario.topicArn}:subscription-1`,
				Sns: notification,
			},
		],
	};
}

async function invokeStatus(world: ChatticusWorld, records: SnsEvent["Records"]): Promise<void> {
	const scenario = sesOf(world);
	const runtime = requiredChannelsRuntime(world);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => {
		scenario.subscribeFetches += 1;
		throw new Error("The status function must never fetch an address a notification names");
	}) as typeof fetch;
	try {
		await handleSesStatusEvent(
			{
				runtime,
				clock: world.clock,
				transport: emailTransportFor(world, runtime.metrics),
				suppressionList: suppressionListFor(world),
				certificates: scenario.certificates,
				expectedTopicArn: scenario.topicArn,
				region: scenario.region,
			},
			{ Records: records },
		);
		scenario.lastStatus = { kind: "success" };
	} catch (error) {
		scenario.lastStatus = { kind: "failure", error };
	} finally {
		globalThis.fetch = originalFetch;
	}
}

async function signedAndDelivered(world: ChatticusWorld, message: string, options: SignOptions = {}): Promise<void> {
	await invokeStatus(world, notificationOf(world, message, options).record);
}

Given("SNS signs with a generated test key pair for the topic {string} in {string}", function (this: ChatticusWorld, topicArn: string, region: string) {
	const scenario = sesOf(this);
	scenario.topicArn = topicArn;
	scenario.region = region;
	scenario.certificates.pem = testKeys().primary.certificatePem;
});

When("SNS delivers a signed SES {string} event for the last sent mail", async function (this: ChatticusWorld, eventType: string) {
	await signedAndDelivered(this, sesEventBody(this, eventType, null, null, false));
});

When("SNS delivers a signed SES {string} event for the last sent mail with signature version {string}", async function (this: ChatticusWorld, eventType: string, version: string) {
	await signedAndDelivered(this, sesEventBody(this, eventType, null, null, false), { version });
});

When("SNS delivers a signed SES {string} of type {string} event for the last sent mail to {string}", async function (this: ChatticusWorld, eventType: string, bounceType: string, recipient: string) {
	await signedAndDelivered(this, sesEventBody(this, eventType, bounceType, recipient, false));
});

When("SNS delivers a signed SES {string} event for the last sent mail to {string}", async function (this: ChatticusWorld, eventType: string, recipient: string) {
	await signedAndDelivered(this, sesEventBody(this, eventType, null, recipient, false));
});

When("SNS delivers the same notification again", async function (this: ChatticusWorld) {
	const notification = sesOf(this).lastNotification;
	assert.ok(notification, "No notification was delivered");
	await invokeStatus(this, [{ EventSource: "aws:sns", EventSubscriptionArn: `${sesOf(this).topicArn}:subscription-1`, Sns: notification }]);
});

When(
	"SNS delivers a signed SES {string} of type {string} event for the last sent mail to {string} whose certificate is at {string}",
	async function (this: ChatticusWorld, eventType: string, bounceType: string, recipient: string, certificateUrl: string) {
		await signedAndDelivered(this, sesEventBody(this, eventType, bounceType, recipient, false), { certificateUrl });
	},
);

When(
	"SNS delivers a signed SES {string} of type {string} event for the last sent mail to {string} from the topic {string}",
	async function (this: ChatticusWorld, eventType: string, bounceType: string, recipient: string, topicArn: string) {
		await signedAndDelivered(this, sesEventBody(this, eventType, bounceType, recipient, false), { topicArn });
	},
);

When("SNS delivers a signed SES {string} event for the last sent mail with the subscription of another topic", async function (this: ChatticusWorld, eventType: string) {
	await signedAndDelivered(this, sesEventBody(this, eventType, null, null, false), { subscriptionTopicArn: "arn:aws:sns:us-east-1:111122223333:some-other-topic" });
});

When("SNS delivers a signed SES {string} event for the last sent mail whose message is changed afterwards to a {string}", async function (this: ChatticusWorld, eventType: string, changedTo: string) {
	await signedAndDelivered(this, sesEventBody(this, eventType, null, null, false), { changeMessageAfterwards: sesEventBody(this, changedTo, "Permanent", "sam.sender@example.test", false) });
});

When(
	"SNS delivers a signed SES {string} of type {string} event for the last sent mail to {string} signed by another key",
	async function (this: ChatticusWorld, eventType: string, bounceType: string, recipient: string) {
		await signedAndDelivered(this, sesEventBody(this, eventType, bounceType, recipient, false), { signer: "other" });
	},
);

When("SNS delivers an unsigned SES {string} of type {string} event for the last sent mail to {string}", async function (this: ChatticusWorld, eventType: string, bounceType: string, recipient: string) {
	await signedAndDelivered(this, sesEventBody(this, eventType, bounceType, recipient, false), { unsigned: true });
});

When("SNS delivers a signed SES {string} event for the last sent mail stamped {int} {word} {word} now", async function (this: ChatticusWorld, eventType: string, amount: number, unit: string, direction: string) {
	const seconds = amount * (unit.startsWith("hour") ? 3600 : 60) * (direction === "before" ? -1 : 1);
	await signedAndDelivered(this, sesEventBody(this, eventType, null, null, false), { offsetSeconds: seconds });
});

When("SNS delivers a signed subscription confirmation for the configured topic", async function (this: ChatticusWorld) {
	await signedAndDelivered(this, "You have chosen to subscribe to the topic.", { type: "SubscriptionConfirmation" });
});

When(
	"SNS delivers a signed SES {string} of type {string} event for an unknown message to {string}",
	async function (this: ChatticusWorld, eventType: string, bounceType: string, recipient: string) {
		await signedAndDelivered(this, sesEventBody(this, eventType, bounceType, recipient, true));
	},
);

Given("the certificate source is unavailable", function (this: ChatticusWorld) {
	sesOf(this).certificates.unavailable = true;
});

When("the certificate source recovers", function (this: ChatticusWorld) {
	sesOf(this).certificates.unavailable = false;
});

Then("the status function succeeded", function (this: ChatticusWorld) {
	const result = sesOf(this).lastStatus;
	assert.ok(result, "The status function was not invoked");
	assert.equal(result.kind, "success", result.kind === "failure" ? String(result.error) : "");
});

Then("the status function failed so that the platform retries", function (this: ChatticusWorld) {
	const result = sesOf(this).lastStatus;
	assert.ok(result?.kind === "failure", "The status function did not fail");
});

Then("the notification was rejected as {string}", function (this: ChatticusWorld, reason: string) {
	const rejections = channelsScenarioOf(this).counted.filter((metric) => metric.name === "status_event_rejected");
	assert.equal(rejections.length, 1, JSON.stringify(rejections));
	assert.equal(rejections[0]!.dimensions["reason"], reason);
});

Then("no certificate was fetched", function (this: ChatticusWorld) {
	assert.deepEqual(sesOf(this).certificates.fetched, []);
});

Then("nothing was fetched from the subscribe address", function (this: ChatticusWorld) {
	assert.equal(sesOf(this).subscribeFetches, 0);
	assert.deepEqual(sesOf(this).certificates.fetched, []);
});

Given("{string} was suppressed after a bounce for the email binding of the bot {string} in {string}", async function (this: ChatticusWorld, address: string, botName: string, organization: string) {
	const tenantId = tenantIdOfOrganization(organization);
	const bot = this.botsByName?.get(botName);
	assert.ok(bot, `The scenario has no bot ${botName}`);
	const binding = (await requiredChannelsRuntime(this).store.listBindings(tenantId)).find((candidate) => candidate.provider === "email" && candidate.botId === bot.botId);
	assert.ok(binding, `${botName} has no email binding`);
	await suppressionListFor(this).suppress({ tenantId, bindingId: binding.bindingId, address, reason: "bounce_permanent_general", suppressedAt: this.clock.now() });
});
