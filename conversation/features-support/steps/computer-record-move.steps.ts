import assert from "node:assert/strict";
import { DeleteItemCommand, GetItemCommand, PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { Given, Then, When } from "@cucumber/cucumber";
import { ensureComputer } from "../../src/domain/computers.ts";
import { moveComputerRecords, type ComputerRecordMove } from "../../src/migration/computer-record.ts";
import type { Computer } from "../../src/store/codecs/computer.ts";
import { computerRecordKey } from "../../src/store/keys.ts";
import type { ChatticusWorld } from "../world.ts";

type MoveScenario = { before: Computer | null; newer: Computer | null; moves: ComputerRecordMove[] };

const scenarios = new WeakMap<ChatticusWorld, MoveScenario>();

function scenarioOf(world: ChatticusWorld): MoveScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = { before: null, newer: null, moves: [] };
		scenarios.set(world, scenario);
	}
	return scenario;
}

const itemAt = async (world: ChatticusWorld, pk: string, sk: string) =>
	(await world.messagingTable.client.send(new GetItemCommand({ TableName: world.messagingTable.tableName, Key: { pk: { S: pk }, sk: { S: sk } }, ConsistentRead: true }))).Item;

Given("the Messaging table holds a computer record of {string} at the old roster key", async function (this: ChatticusWorld, tenantId: string) {
	await ensureComputer(tenantId, { store: this.messagingStore(), ids: this.ids });
	scenarioOf(this).before = await this.messagingStore().getComputer(tenantId);
	const key = computerRecordKey(tenantId);
	const item = await itemAt(this, key.pk, key.sk);
	assert.ok(item, "The code did not write the computer record at the new key.");
	const { client, tableName } = this.messagingTable;
	await client.send(new DeleteItemCommand({ TableName: tableName, Key: { pk: { S: key.pk }, sk: { S: key.sk } } }));
	await client.send(new PutItemCommand({ TableName: tableName, Item: { ...item, pk: { S: `${tenantId}#roster` }, sk: { S: "computer" } } }));
});

Given("the new code has already written a newer computer record of {string}", async function (this: ChatticusWorld, tenantId: string) {
	const scenario = scenarioOf(this);
	assert.ok(scenario.before);
	scenario.newer = { ...scenario.before, tenantId, snapshotGeneration: scenario.before.snapshotGeneration + 5 };
	await this.messagingStore().putComputer(scenario.newer);
});

When("the computer record move runs as a dry run", async function (this: ChatticusWorld) {
	scenarioOf(this).moves = await moveComputerRecords({ client: this.messagingTable.client, messagingTableName: this.messagingTable.tableName }, { execute: false });
});

When("the computer record move runs for real", async function (this: ChatticusWorld) {
	scenarioOf(this).moves = await moveComputerRecords({ client: this.messagingTable.client, messagingTableName: this.messagingTable.tableName }, { execute: true });
});

Then("the organization {string} has no computer record", async function (this: ChatticusWorld, tenantId: string) {
	assert.equal(await this.messagingStore().getComputer(tenantId), null);
});

Then("the move reports {string} for {string}", function (this: ChatticusWorld, outcome: string, tenantId: string) {
	assert.deepEqual(scenarioOf(this).moves, [{ tenantId, outcome }]);
});

Then("the move reports nothing to move", function (this: ChatticusWorld) {
	assert.deepEqual(scenarioOf(this).moves, []);
});

Then("the Messaging table holds the computer record of {string} under the partition {string}", async function (this: ChatticusWorld, tenantId: string, partition: string) {
	const item = await itemAt(this, partition, "meta");
	assert.ok(item, `No item under ${partition}`);
	assert.equal(item["tenant_id"]?.S, tenantId);
});

Then("the Messaging table holds nothing under the sort key {string} in the partition {string}", async function (this: ChatticusWorld, sortKey: string, partition: string) {
	assert.equal(await itemAt(this, partition, sortKey), undefined);
});

Then("the Messaging table still holds the computer record of {string} at the old roster key", async function (this: ChatticusWorld, tenantId: string) {
	assert.ok(await itemAt(this, `${tenantId}#roster`, "computer"));
});

Then("the organization {string} has the computer record it had before the move", async function (this: ChatticusWorld, tenantId: string) {
	assert.deepEqual(await this.messagingStore().getComputer(tenantId), scenarioOf(this).before);
});

Then("the organization {string} has the newer computer record", async function (this: ChatticusWorld, tenantId: string) {
	assert.deepEqual(await this.messagingStore().getComputer(tenantId), scenarioOf(this).newer);
});

Then("the roster of {string} still holds a bot", async function (this: ChatticusWorld, tenantId: string) {
	const response = await this.messagingTable.client.send(
		new QueryCommand({
			TableName: this.messagingTable.tableName,
			KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
			ExpressionAttributeValues: { ":pk": { S: `${tenantId}#roster` }, ":prefix": { S: "bot#" } },
			ConsistentRead: true,
		}),
	);
	assert.ok((response.Items ?? []).length > 0, "The roster holds no bot.");
});
