import assert from "node:assert/strict";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { Given, Then, When } from "@cucumber/cucumber";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry } from "@earendil-works/pi-durable";
import { chatticusExtensions } from "../../src/pi/extension.ts";
import { findStorageFailure, OwnershipLost } from "../../src/pi/errors.ts";
import { type OwnerSession, openOwnerSession } from "../../src/pi/session.ts";
import { storageIdFor } from "../../src/storage/storage-support.ts";
import type { ChatticusWorld } from "../world.ts";

type PiScenario = {
	faux: FauxProviderHandle;
	botId: string;
	channelId: string;
	owners: OwnerSession[];
	answers: string[];
	requestTexts: string[];
};

const scenarios = new WeakMap<ChatticusWorld, PiScenario>();

const endpoint = process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5555";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };
const dynamo = new DynamoDBClient({ endpoint, region: "us-east-1", credentials, maxAttempts: 1 });
const s3 = new S3Client({ endpoint, region: "us-east-1", credentials, forcePathStyle: true, maxAttempts: 1 });

const scenarioOf = (world: ChatticusWorld): PiScenario => {
	const scenario = scenarios.get(world);
	assert.ok(scenario, "no bot has been scripted in this scenario");
	return scenario;
};

const openOwner = async (world: ChatticusWorld, botId: string, channelId: string): Promise<void> => {
	const scenario = scenarioOf(world);
	scenario.botId = botId;
	scenario.channelId = channelId;
	const models = createModels();
	models.setProvider(scenario.faux.provider);
	const owner = await openOwnerSession(storageIdFor(world.tenantId, botId, channelId), {
		client: dynamo,
		s3,
		tableName: "Conversations",
		bucket: "PiSessions",
		models,
		extensions: chatticusExtensions({ systemPrompt: () => `You are ${botId}.` }),
		context: BACKGROUND_CONTEXT,
	});
	scenario.owners.push(owner);
};

const sendFrom = async (world: ChatticusWorld, ownerIndex: number, content: string): Promise<string> => {
	const scenario = scenarioOf(world);
	const owner = scenario.owners[ownerIndex];
	assert.ok(owner, `owner ${ownerIndex + 1} is not open`);
	const agent = { model: { provider: scenario.faux.provider.id, modelId: "faux-model" }, thinkingLevel: "off" as const };
	const root = await owner.harness.root(BACKGROUND_CONTEXT, { agent });
	await root.configure(agent, BACKGROUND_CONTEXT);
	const submission = await root.submit({ type: "input", content, requestId: `req-${ownerIndex}-${content}` }, BACKGROUND_CONTEXT);
	const settled = await submission.wait(BACKGROUND_CONTEXT);
	if (settled.type !== "input" || settled.status === "unanswered") throw new Error("the turn was not answered");
	const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer as never), BACKGROUND_CONTEXT);
	const message = entry?.model?.[0];
	assert.equal(message?.role, "assistant");
	const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	scenario.answers.push(text);
	return text;
};

const scripted = (world: ChatticusWorld, replies: string[]): void => {
	const faux = fauxProvider({ models: [{ id: "faux-model" }] });
	const requestTexts: string[] = [];
	faux.setResponses(
		replies.map((reply) => (context) => {
			requestTexts.push(JSON.stringify(context));
			return fauxAssistantMessage(reply);
		}),
	);
	scenarios.set(world, { faux, botId: "", channelId: "", owners: [], answers: [], requestTexts });
};

Given("the bot {string} answers {string} to every message", function (this: ChatticusWorld, _bot: string, reply: string) {
	scripted(this, Array.from({ length: 8 }, () => reply));
});

Given(
	"the bot {string} answers {string} then {string}",
	function (this: ChatticusWorld, _bot: string, first: string, second: string) {
		scripted(this, [first, second]);
	},
);

When(
	"an owner opens the session for bot {string} in channel {string}",
	async function (this: ChatticusWorld, bot: string, channel: string) {
		await openOwner(this, bot, channel);
	},
);

When(
	"a second owner opens the session for bot {string} in channel {string}",
	async function (this: ChatticusWorld, bot: string, channel: string) {
		await openOwner(this, bot, channel);
	},
);

When("the owner sends {string}", async function (this: ChatticusWorld, content: string) {
	await sendFrom(this, 0, content);
});

When("the second owner sends {string}", async function (this: ChatticusWorld, content: string) {
	await sendFrom(this, 1, content);
});

When("the owner yields the session", async function (this: ChatticusWorld) {
	await scenarioOf(this).owners[0]?.close();
});

Then("the owner receives the answer {string}", function (this: ChatticusWorld, expected: string) {
	assert.equal(scenarioOf(this).answers.at(-1), expected);
});

Then("the second owner receives the answer {string}", function (this: ChatticusWorld, expected: string) {
	assert.equal(scenarioOf(this).answers.at(-1), expected);
});

Then("the owner holds ownership number {int}", function (this: ChatticusWorld, expected: number) {
	assert.equal(scenarioOf(this).owners[0]?.fence, expected);
});

Then("the second owner holds ownership number {int}", function (this: ChatticusWorld, expected: number) {
	assert.equal(scenarioOf(this).owners[1]?.fence, expected);
});

Then("the first owner is told it lost ownership when it commits", async function (this: ChatticusWorld) {
	await assert.rejects(
		sendFrom(this, 0, "stale write"),
		(error: unknown) => findStorageFailure(error) instanceof OwnershipLost,
	);
});

Then("the second owner can commit", async function (this: ChatticusWorld) {
	await sendFrom(this, 1, "after takeover");
});

const committedAssistantTexts = async (world: ChatticusWorld): Promise<string[]> => {
	const scenario = scenarioOf(world);
	const observer = scenario.owners.at(-1);
	assert.ok(observer, "no owner is open");
	const agent = { model: { provider: scenario.faux.provider.id, modelId: "faux-model" }, thinkingLevel: "off" as const };
	const root = await observer.harness.root(BACKGROUND_CONTEXT, { agent });
	const page = await root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
	const texts: string[] = [];
	for (const entry of [...page.items].reverse()) {
		for (const message of entry.model ?? []) {
			if (message.role === "assistant") {
				texts.push(message.content.map((part) => (part.type === "text" ? part.text : "")).join(""));
			}
		}
	}
	return texts;
};

Then("the session holds the answers {string} and {string}", async function (this: ChatticusWorld, first: string, second: string) {
	const scenario = scenarioOf(this);
	assert.deepEqual(await committedAssistantTexts(this), [first, second]);
	assert.ok(scenario.requestTexts[1]?.includes(first), "the second owner's model request did not carry the first answer");
});
