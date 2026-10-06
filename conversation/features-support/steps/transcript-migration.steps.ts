import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	type AttributeValue,
	GetItemCommand,
	PutItemCommand,
	QueryCommand,
	ScanCommand,
	UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { Given, Then, When } from "@cucumber/cucumber";
import type { MigrationDependencies } from "../../src/migration/copy.ts";
import { type MigrationCliResult, runMigrationCli } from "../../src/migration/cli.ts";
import { readMarker, readVerifiedMarker } from "../../src/migration/migration-state.ts";
import { storageIdFor } from "../../src/storage/storage-support.ts";
import { formatIsoDateTime } from "../../src/store/codecs/util.ts";
import { recordResponse } from "../api.ts";
import { modelScenarioOf } from "../executor-harness.ts";
import { wireFrontDoor } from "../front-door.ts";
import { memberGet } from "../org-user-client.ts";
import { ensurePiStorage } from "../pi-storage.ts";
import type { ChatticusWorld } from "../world.ts";

type Item = Record<string, AttributeValue>;

type ExpectedMessage = {
	seq: number;
	message_id: string;
	author_kind: string;
	author_id: string;
	body: string;
	addressed_to_bot_id: string | null;
	created_at: string;
};

type MigrationScenario = {
	tenantId: string;
	oldItems: Item[];
	lastCommand: MigrationCliResult | null;
};

const scenarios = new WeakMap<ChatticusWorld, MigrationScenario>();

const BIN_PATH = fileURLToPath(new URL("../../bin/migrate-transcripts.ts", import.meta.url));
const FIXTURE_DIRECTORY = new URL("../../test/fixtures/python-transcript/", import.meta.url);
const ENVIRONMENT = "development";

const scenarioOf = (world: ChatticusWorld): MigrationScenario => {
	const found = scenarios.get(world);
	assert.ok(found, "the old control plane has not been set up in this scenario");
	return found;
};

const readFixture = (name: string): Item[] => JSON.parse(readFileSync(new URL(name, FIXTURE_DIRECTORY), "utf8")) as Item[];

async function putOldItems(world: ChatticusWorld, items: Item[]): Promise<void> {
	for (const item of items) {
		await world.messagingTable.client.send(new PutItemCommand({ TableName: world.messagingTable.tableName, Item: item }));
		scenarioOf(world).oldItems.push(item);
	}
}

const expectedMessagesOf = (world: ChatticusWorld, channelId: string): ExpectedMessage[] => {
	const partition = `${scenarioOf(world).tenantId}#channel#${channelId}`;
	const latest = new Map<number, Item>();
	for (const item of scenarioOf(world).oldItems) {
		if (item.pk!.S === partition && item.sk!.S!.startsWith("msg#")) latest.set(Number(item.seq!.N), item);
	}
	return [...latest.values()]
		.sort((left, right) => Number(left.seq!.N) - Number(right.seq!.N))
		.map((item) => ({
			seq: Number(item.seq!.N),
			message_id: item.message_id!.S!,
			author_kind: item.author_kind!.S!,
			author_id: item.author_id!.S!,
			body: item.body!.S!,
			addressed_to_bot_id: item.addressed_to_bot_id!.S === "" ? null : item.addressed_to_bot_id!.S!,
			created_at: item.created_at!.S!,
		}));
};

async function migrationDependencies(world: ChatticusWorld): Promise<MigrationDependencies> {
	const piStorage = await ensurePiStorage(world);
	return {
		client: world.messagingTable.client,
		s3: piStorage.s3,
		messagingTableName: world.messagingTable.tableName,
		conversationsTableName: piStorage.tableName,
		bucket: piStorage.bucket,
		clock: world.clock,
	};
}

async function runInProcess(world: ChatticusWorld, line: string): Promise<MigrationCliResult> {
	const dependencies = await migrationDependencies(world);
	const result = await runMigrationCli([...line.split(" "), "--environment", ENVIRONMENT], { build: () => dependencies });
	scenarioOf(world).lastCommand = result;
	return result;
}

async function runRealCommandLine(world: ChatticusWorld, line: string): Promise<MigrationCliResult> {
	const dependencies = await migrationDependencies(world);
	const child = spawn(process.execPath, [BIN_PATH, ...line.split(" ")], {
		env: {
			...process.env,
			CHATTICUS_MESSAGING_TABLE: dependencies.messagingTableName,
			CHATTICUS_CONVERSATIONS_TABLE: dependencies.conversationsTableName,
			CHATTICUS_PI_SESSIONS_BUCKET: dependencies.bucket,
			AWS_ENDPOINT_URL: process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5555",
			AWS_REGION: "us-east-1",
			AWS_ACCESS_KEY_ID: "test",
			AWS_SECRET_ACCESS_KEY: "test",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", resolve);
	});
	const result = { exitCode: exitCode ?? -1, stdout, stderr };
	scenarioOf(world).lastCommand = result;
	return result;
}

const lastCommand = (world: ChatticusWorld): MigrationCliResult => {
	const result = scenarioOf(world).lastCommand;
	assert.ok(result, "no operator command has been run");
	return result;
};

async function listMessagesOverHttp(world: ChatticusWorld, channelId: string): Promise<Array<Record<string, any>>> {
	const response = await recordResponse(await memberGet(world, `/orgs/${scenarioOf(world).tenantId}/channels/${channelId}/messages`));
	assert.equal(response.status, 200, response.text);
	return response.json.messages;
}

async function readTurnOver(world: ChatticusWorld, path: string): Promise<Record<string, any>> {
	const response = await recordResponse(await memberGet(world, `/orgs/${scenarioOf(world).tenantId}${path}`));
	assert.equal(response.status, 200, response.text);
	return response.json;
}

const botIdNamed = (world: ChatticusWorld, name: string): string => {
	const bot = world.botsByName?.get(name);
	assert.ok(bot, `Bot ${name} not found`);
	return bot.botId;
};

Given(
	"the old control plane left the transcripts of tenant {string} in the messaging table",
	async function (this: ChatticusWorld, tenantId: string) {
		scenarios.set(this, { tenantId, oldItems: [], lastCommand: null });
		await putOldItems(this, readFixture("items.json"));
	},
);

Given("the front door is running with the migration write gate", async function (this: ChatticusWorld) {
	await wireFrontDoor(this, { signupMode: "invitation_only", cognitoVerifier: true, migrationGate: true });
	this.botsById = new Map();
	this.botsByName = new Map();
	for (const [name, botId] of [
		["Ada", "ada"],
		["Bo", "bo"],
	] as const) {
		const bot = { botId, name, tenantId: scenarioOf(this).tenantId };
		this.botsById.set(botId, bot);
		this.botsByName.set(name, bot);
	}
	this.lastChannel = { channelId: "chan-general", tenantId: scenarioOf(this).tenantId };
});

Given("the operator tool is configured for the scenario's stores", async function (this: ChatticusWorld) {
	await ensurePiStorage(this);
});

Given("the clock is at {string}", function (this: ChatticusWorld, moment: string) {
	this.clock.advanceSeconds((Date.parse(moment) - this.clock.now().getTime()) / 1000);
});

When("the operator runs {string} with the real command line tool", async function (this: ChatticusWorld, line: string) {
	await runRealCommandLine(this, line);
});

When("the operator runs {string}", async function (this: ChatticusWorld, line: string) {
	await runInProcess(this, line);
});

Given("the operator has run the copy", async function (this: ChatticusWorld) {
	const result = await runInProcess(this, "copy");
	assert.equal(result.exitCode, 0, `${result.stdout}${result.stderr}`);
});

Given("the operator closes the write gate", async function (this: ChatticusWorld) {
	const result = await runInProcess(this, "gate close");
	assert.equal(result.exitCode, 0, `${result.stdout}${result.stderr}`);
	assert.match(result.stdout, /gate MIGRATING/);
});

Given("the operator opens the write gate", async function (this: ChatticusWorld) {
	const result = await runInProcess(this, "gate open");
	assert.equal(result.exitCode, 0, `${result.stdout}${result.stderr}`);
	assert.match(result.stdout, /gate OPEN/);
});

Given("the old system accepted two more messages after the copy", async function (this: ChatticusWorld) {
	await putOldItems(this, readFixture("delta-items.json"));
});

Given(
	"the old system edited the body of message {int} in channel {string} to {string}",
	async function (this: ChatticusWorld, seq: number, channelId: string, body: string) {
		await this.messagingTable.client.send(
			new UpdateItemCommand({
				TableName: this.messagingTable.tableName,
				Key: {
					pk: { S: `${scenarioOf(this).tenantId}#channel#${channelId}` },
					sk: { S: `msg#${String(seq).padStart(10, "0")}` },
				},
				UpdateExpression: "SET body = :body",
				ConditionExpression: "attribute_exists(pk)",
				ExpressionAttributeValues: { ":body": { S: body } },
			}),
		);
		const edited = scenarioOf(this).oldItems.findLast(
			(item) => item.pk!.S === `${scenarioOf(this).tenantId}#channel#${channelId}` && item.seq?.N === String(seq),
		);
		assert.ok(edited, `the old system has no message ${seq} in ${channelId}`);
		scenarioOf(this).oldItems.push({ ...edited, body: { S: body } });
	},
);

Then("the command succeeds", function (this: ChatticusWorld) {
	const result = lastCommand(this);
	assert.equal(result.exitCode, 0, `${result.stdout}${result.stderr}`);
});

Then("the command fails with exit code {int}", function (this: ChatticusWorld, exitCode: number) {
	const result = lastCommand(this);
	assert.equal(result.exitCode, exitCode, `${result.stdout}${result.stderr}`);
});

Then("the command output includes {string}", function (this: ChatticusWorld, text: string) {
	const result = lastCommand(this);
	assert.ok(result.stdout.includes(text), `${JSON.stringify(text)} is not in:\n${result.stdout}${result.stderr}`);
});

Then("the command error includes {string}", function (this: ChatticusWorld, text: string) {
	const result = lastCommand(this);
	assert.ok(result.stderr.includes(text), `${JSON.stringify(text)} is not in:\n${result.stderr}`);
});

Then("the migration has written no session and no marker", async function (this: ChatticusWorld) {
	const piStorage = await ensurePiStorage(this);
	const sessions = await this.messagingTable.client.send(new ScanCommand({ TableName: piStorage.tableName }));
	assert.deepEqual(sessions.Items ?? [], []);
	const markers = await this.messagingTable.client.send(
		new ScanCommand({
			TableName: this.messagingTable.tableName,
			FilterExpression: "begins_with(pk, :prefix)",
			ExpressionAttributeValues: { ":prefix": { S: "MIGRATED#" } },
		}),
	);
	assert.deepEqual(markers.Items ?? [], []);
});

Then(
	"the message list of channel {string} shows exactly the old messages of that channel",
	async function (this: ChatticusWorld, channelId: string) {
		const expected = expectedMessagesOf(this, channelId);
		assert.ok(expected.length > 0, "the old system holds no messages for that channel");
		const listed = await listMessagesOverHttp(this, channelId);
		assert.deepEqual(
			listed.map((message) => ({
				seq: message.seq,
				message_id: message.message_id,
				author_kind: message.author_kind,
				author_id: message.author_id,
				body: message.body,
				addressed_to_bot_id: message.addressed_to_bot_id,
				created_at: new Date(message.created_at).getTime(),
			})),
			expected.map((message) => ({ ...message, created_at: new Date(message.created_at).getTime() })),
		);
	},
);

Then("the message list of channel {string} shows {int} messages", async function (this: ChatticusWorld, channelId: string, count: number) {
	assert.equal((await listMessagesOverHttp(this, channelId)).length, count);
});

Then("reading the message list of channel {string} still works", async function (this: ChatticusWorld, channelId: string) {
	assert.ok(Array.isArray(await listMessagesOverHttp(this, channelId)));
});

Then(
	"the next sequence number of channel {string} is still {int}",
	async function (this: ChatticusWorld, channelId: string, nextSeq: number) {
		const result = await this.messagingTable.client.send(
			new GetItemCommand({
				TableName: this.messagingTable.tableName,
				Key: { pk: { S: `${scenarioOf(this).tenantId}#channel#${channelId}` }, sk: { S: "meta" } },
				ConsistentRead: true,
			}),
		);
		assert.equal(result.Item?.next_seq?.N, String(nextSeq));
	},
);

Then(
	"the old message items of channel {string} are all still there",
	async function (this: ChatticusWorld, channelId: string) {
		const result = await this.messagingTable.client.send(
			new QueryCommand({
				TableName: this.messagingTable.tableName,
				KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
				ExpressionAttributeValues: {
					":pk": { S: `${scenarioOf(this).tenantId}#channel#${channelId}` },
					":prefix": { S: "msg#" },
				},
				ConsistentRead: true,
			}),
		);
		assert.equal(result.Items?.length, expectedMessagesOf(this, channelId).length);
	},
);

type RequestMessage = { role: string; content: string | Array<{ type: string; text?: string }> };

const textOf = (message: RequestMessage): string =>
	typeof message.content === "string"
		? message.content
		: message.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");

Then(
	"the model's request {int} shows {string} as a(n) {word} message",
	function (this: ChatticusWorld, number: number, text: string, role: string) {
		const raw = modelScenarioOf(this).scripted.requests[number - 1];
		assert.ok(raw, `The model was not asked ${number} times`);
		const messages = (JSON.parse(raw) as { messages: RequestMessage[] }).messages;
		const shown = messages.filter((message) => message.role === role).map(textOf);
		assert.ok(
			shown.some((candidate) => candidate.includes(text)),
			`no ${role} message includes ${JSON.stringify(text)}; ${role} messages were ${JSON.stringify(shown)}`,
		);
	},
);

Then(
	"the Pi fence of bot {string} in channel {string} is {int}",
	async function (this: ChatticusWorld, botId: string, channelId: string, fence: number) {
		const piStorage = await ensurePiStorage(this);
		const result = await this.messagingTable.client.send(
			new GetItemCommand({
				TableName: piStorage.tableName,
				Key: { pk: { S: `PI#${storageIdFor(scenarioOf(this).tenantId, botId, channelId)}` }, sk: { S: "OWNER" } },
				ConsistentRead: true,
			}),
		);
		assert.equal(result.Item?.fence?.N, String(fence));
	},
);

Then(
	"the verified marker of channel {string} records {int} messages up to seq {int} at {string}",
	async function (this: ChatticusWorld, channelId: string, messageCount: number, lastSeq: number, moment: string) {
		const marker = await readVerifiedMarker(
			this.messagingTable.client,
			this.messagingTable.tableName,
			scenarioOf(this).tenantId,
			channelId,
		);
		assert.ok(marker, `no verified marker for channel ${channelId}`);
		assert.deepEqual(
			{ messageCount: marker.messageCount, verifiedThroughSeq: marker.verifiedThroughSeq, verifiedAt: marker.verifiedAt },
			{ messageCount, verifiedThroughSeq: lastSeq, verifiedAt: formatIsoDateTime(new Date(moment)) },
		);
	},
);

Then("channel {string} has no verified marker", async function (this: ChatticusWorld, channelId: string) {
	const marker = await readVerifiedMarker(
		this.messagingTable.client,
		this.messagingTable.tableName,
		scenarioOf(this).tenantId,
		channelId,
	);
	assert.equal(marker, null);
});

Then(
	"the marker of bot {string} in channel {string} records {int} messages up to seq {int} by the {string} pass at {string}",
	async function (
		this: ChatticusWorld,
		botId: string,
		channelId: string,
		messageCount: number,
		lastSeq: number,
		phase: string,
		moment: string,
	) {
		const marker = await readMarker(
			this.messagingTable.client,
			this.messagingTable.tableName,
			scenarioOf(this).tenantId,
			botId,
			channelId,
		);
		assert.ok(marker, `no marker for bot ${botId} in channel ${channelId}`);
		assert.deepEqual(
			{ messageCount: marker.messageCount, lastSeq: marker.lastSeq, phase: marker.phase, updatedAt: marker.updatedAt },
			{ messageCount, lastSeq, phase, updatedAt: formatIsoDateTime(new Date(moment)) },
		);
	},
);

Then(
	"the latest turn of channel {string} is {string} with reason {string}",
	async function (this: ChatticusWorld, channelId: string, status: string, reason: string) {
		const turn = await readTurnOver(this, `/channels/${channelId}/turns/latest`);
		assert.equal(turn.status, status);
		assert.equal(turn.terminal_reason, reason);
	},
);

Then(
	"the latest turn of bot {string} in channel {string} is {string} with reason {string}",
	async function (this: ChatticusWorld, botName: string, channelId: string, status: string, reason: string) {
		const turn = await readTurnOver(this, `/channels/${channelId}/turns/latest?bot_id=${botIdNamed(this, botName)}`);
		assert.equal(turn.status, status);
		assert.equal(turn.terminal_reason, reason);
	},
);

Then(
	"the latest turn of bot {string} in channel {string} is {string}",
	async function (this: ChatticusWorld, botName: string, channelId: string, status: string) {
		const turn = await readTurnOver(this, `/channels/${channelId}/turns/latest?bot_id=${botIdNamed(this, botName)}`);
		assert.equal(turn.status, status);
	},
);

Then("turn {string} is still {string}", async function (this: ChatticusWorld, turnId: string, status: string) {
	assert.equal((await readTurnOver(this, `/turns/${turnId}`)).status, status);
});

Then(
	"the completed turn {string} names the answer with seq {int}",
	async function (this: ChatticusWorld, turnId: string, seq: number) {
		const turn = await this.turnControlStore().getTurn(scenarioOf(this).tenantId, turnId);
		assert.ok(turn, `turn ${turnId} cannot be read`);
		assert.equal(turn.status, "completed");
		assert.equal(turn.messageSeq, seq);
	},
);

Then("the last post is refused with status {int} saying {string}", function (this: ChatticusWorld, status: number, text: string) {
	const response = this.postResponses.at(-1);
	assert.ok(response, "nothing was posted");
	assert.equal(response.status, status, response.text);
	assert.ok(String(response.json?.detail).includes(text), response.text);
});

Then("the last post is accepted", function (this: ChatticusWorld) {
	const response = this.postResponses.at(-1);
	assert.ok(response, "nothing was posted");
	assert.equal(response.status, 200, response.text);
});
