import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PutItemCommand } from "@aws-sdk/client-dynamodb";
import { Given, Then } from "@cucumber/cucumber";
import { costTurnIndexKey } from "../../src/ledger/turn-cost.ts";
import { gatewayScenarioOf } from "../model-gateway-support.ts";
import type { ChatticusWorld } from "../world.ts";

Given(
	"organization {string} has spent {float} US dollars on models this month",
	async function (this: ChatticusWorld, tenantId: string, dollars: number) {
		const now = this.clock.now();
		const key = costTurnIndexKey(tenantId, now.toISOString().slice(0, 7), `seeded-${randomUUID()}`);
		await this.messagingTable.client.send(
			new PutItemCommand({
				TableName: this.messagingTable.tableName,
				Item: {
					pk: { S: key.pk },
					sk: { S: key.sk },
					tenant_id: { S: tenantId },
					kind: { S: "turn" },
					status: { S: "completed" },
					source: { S: "session" },
					recorded_at: { S: now.toISOString() },
					by_model: { M: { "gpt-5-nano": { M: { calls: { N: "1" }, cost_usd: { N: dollars.toFixed(2) } } } } },
				},
			}),
		);
	},
);

Given("the clock reaches the first day of the next month", function (this: ChatticusWorld) {
	const now = this.clock.now();
	const nextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
	this.clock.advanceSeconds(Math.ceil((nextMonth - now.getTime()) / 1000) + 1);
});

Given("the organization's model spend cannot be read", function (this: ChatticusWorld) {
	gatewayScenarioOf(this).spendReadFails = true;
});

Then("the gateway error code is {string}", function (this: ChatticusWorld, code: string) {
	const body = JSON.parse(gatewayScenarioOf(this).lastBody) as { error?: { code?: string } };
	assert.equal(body.error?.code, code);
});

Then("the gateway reported the refusal {string}", function (this: ChatticusWorld, reason: string) {
	assert.ok(gatewayScenarioOf(this).logEvents.some((event) => event.event === "refused" && event.reason === reason));
});
