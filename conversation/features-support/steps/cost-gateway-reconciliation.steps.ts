import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { GetItemCommand } from "@aws-sdk/client-dynamodb";
import { Given, Then, When } from "@cucumber/cucumber";
import { Decimal } from "../../src/budget/decimal.ts";
import { gatewayObservationKey, listGatewayObservations, type StoredGatewayObservation } from "../../src/ledger/gateway-observation.ts";
import { gatewayCostRowIdOf } from "../../src/ledger/reconcile.ts";
import { costIndexPartitionOf } from "../../src/ledger/turn-cost.ts";
import { modelScenarioOf } from "../executor-harness.ts";
import { keepObservation, lastReconciliationOf, reconcileTenantOf } from "../cost-reconciliation-support.ts";
import type { ChatticusWorld } from "../world.ts";
import { turnOf } from "./model-gateway.steps.ts";
import { currentTurnOf } from "./model.steps.ts";

const DEFAULT_OBSERVED_MODEL = "scripted-model";

const tenantOf = (world: ChatticusWorld): string => world.lastChannel?.tenantId ?? "anthus";

function observedTurnId(world: ChatticusWorld): string {
	try {
		return turnOf(world).turnId;
	} catch {
		return currentTurnOf(world);
	}
}

type ObservedCall = {
	readonly response: string;
	readonly model: string;
	readonly input: number;
	readonly output: number;
	readonly estimated: boolean;
	readonly tenantId?: string;
	readonly turnId?: string;
	readonly observedAt?: string;
};

async function observe(world: ChatticusWorld, call: ObservedCall): Promise<void> {
	await keepObservation(world, {
		tenantId: call.tenantId ?? tenantOf(world),
		turnId: call.turnId ?? observedTurnId(world),
		ownerId: "container-owner",
		callId: call.response,
		responseId: call.response,
		requestId: randomUUID(),
		vendor: "openai",
		model: call.model,
		inputTokens: call.input,
		cachedInputTokens: 0,
		outputTokens: call.output,
		reasoningTokens: 0,
		estimated: call.estimated,
		reason: call.estimated ? "estimated_after_interruption" : "recorded",
		observedAt: call.observedAt ?? world.clock.now().toISOString(),
	});
}

Given(
	"the model answers {string} as response {string} using {int} uncached input and {int} output tokens",
	function (this: ChatticusWorld, text: string, responseId: string, input: number, output: number) {
		modelScenarioOf(this).scripted.reply(text, { input, output, responseId });
	},
);

When(
	"the gateway observed response {string} for the turn with {int} input and {int} output tokens",
	async function (this: ChatticusWorld, response: string, input: number, output: number) {
		await observe(this, { response, model: DEFAULT_OBSERVED_MODEL, input, output, estimated: false });
	},
);

When(
	"the gateway observed response {string} of model {string} for the turn with {int} input and {int} output tokens",
	async function (this: ChatticusWorld, response: string, model: string, input: number, output: number) {
		await observe(this, { response, model, input, output, estimated: false });
	},
);

When(
	"the gateway observed an estimate of response {string} for the turn with {int} input and {int} output tokens",
	async function (this: ChatticusWorld, response: string, input: number, output: number) {
		await observe(this, { response, model: DEFAULT_OBSERVED_MODEL, input, output, estimated: true });
	},
);

Given(
	"the gateway observed response {string} for turn {string} of tenant {string} at {word} with {int} input and {int} output tokens",
	async function (this: ChatticusWorld, response: string, turnId: string, tenantId: string, observedAt: string, input: number, output: number) {
		await observe(this, { response, model: "gpt-5-nano", input, output, estimated: false, tenantId, turnId, observedAt });
	},
);

When("the gateway observations of the organization are reconciled", async function (this: ChatticusWorld) {
	await reconcileTenantOf(this, tenantOf(this));
});

When("the gateway observations of the organization are reconciled again", async function (this: ChatticusWorld) {
	await reconcileTenantOf(this, tenantOf(this));
});

async function observationsOfTurn(world: ChatticusWorld): Promise<StoredGatewayObservation[]> {
	const turnId = observedTurnId(world);
	return (await listGatewayObservations(
		{ client: world.messagingTable.client, tableName: world.messagingTable.tableName },
		tenantOf(world),
	)).filter((observation) => observation.turnId === turnId);
}

async function observationOf(world: ChatticusWorld, response: string): Promise<StoredGatewayObservation> {
	const found = (await observationsOfTurn(world)).find((observation) => observation.callId === response);
	assert.ok(found, `The gateway kept no observation of response ${response} for the turn`);
	return found;
}

Then("the gateway kept {int} observation(s) for the turn", async function (this: ChatticusWorld, count: number) {
	assert.equal((await observationsOfTurn(this)).length, count);
});

Then(
	"the gateway comes to keep {int} estimated observation(s) for the turn",
	async function (this: ChatticusWorld, count: number) {
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const estimated = (await observationsOfTurn(this)).filter((observation) => observation.estimated);
			if (estimated.length >= count) {
				assert.equal(estimated.length, count);
				assert.ok(estimated[0]!.inputTokens > 0, "The estimate counted no input");
				assert.ok(estimated[0]!.outputTokens > 0, "The estimate counted none of the output already sent");
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.fail("The abandoned answer was never kept as an observation");
	},
);

Then(
	"the only observation of the turn names the vendor's response id, has {int} input and {int} output tokens and is not an estimate",
	async function (this: ChatticusWorld, input: number, output: number) {
		const observations = await observationsOfTurn(this);
		assert.equal(observations.length, 1);
		const [observation] = observations;
		assert.ok(observation!.responseId !== null && observation!.responseId.startsWith("resp_"), `response id is ${String(observation!.responseId)}`);
		assert.equal(observation!.callId, observation!.responseId);
		assert.equal(observation!.inputTokens, input);
		assert.equal(observation!.outputTokens, output);
		assert.equal(observation!.estimated, false);
	},
);

Then(
	"the observation of response {string} has {int} input and {int} output tokens and is {word}",
	async function (this: ChatticusWorld, response: string, input: number, output: number, kind: string) {
		const observation = await observationOf(this, response);
		assert.equal(observation.inputTokens, input);
		assert.equal(observation.outputTokens, output);
		assert.equal(observation.estimated, kind === "estimated");
	},
);

Then("the observation of response {string} is reconciled as {string}", async function (this: ChatticusWorld, response: string, verdict: string) {
	assert.equal((await observationOf(this, response)).reconciliation, verdict);
});

async function gatewayRowsOf(world: ChatticusWorld) {
	return (await world.store.listVendorLedgerRowsForTenant(tenantOf(world))).filter((row) => row.source === "gateway");
}

Then("the organization holds {int} gateway-sourced cost row(s)", async function (this: ChatticusWorld, count: number) {
	assert.equal((await gatewayRowsOf(this)).length, count);
});

Then(
	"the organization holds {int} gateway-sourced cost row with {int} input and {int} output tokens costing {word} dollars",
	async function (this: ChatticusWorld, count: number, input: number, output: number, costUsd: string) {
		const rows = await gatewayRowsOf(this);
		assert.equal(rows.length, count);
		const [row] = rows;
		assert.ok(row!.costUsd !== null && row!.costUsd.equals(Decimal.parse(costUsd)), `cost is ${String(row!.costUsd)}, expected ${costUsd}`);
		const item = await this.messagingTable.client.send(
			new GetItemCommand({
				TableName: this.messagingTable.tableName,
				Key: { pk: { S: `${tenantOf(this)}#vendor_ledger` }, sk: { S: `turn#${gatewayCostRowIdOf(row!.callId!)}` } },
				ConsistentRead: true,
			}),
		);
		assert.equal(item.Item?.input_tokens?.N, String(input));
		assert.equal(item.Item?.output_tokens?.N, String(output));
		assert.equal(item.Item?.source?.S, "gateway");
	},
);

Then("each gateway-sourced cost row also has a cost index item flagged as a gateway call", async function (this: ChatticusWorld) {
	const rows = await gatewayRowsOf(this);
	assert.ok(rows.length > 0, "There is no gateway-sourced cost row");
	for (const row of rows) {
		const month = row.recordedAt.slice(0, 7);
		const item = await this.messagingTable.client.send(
			new GetItemCommand({
				TableName: this.messagingTable.tableName,
				Key: { pk: { S: costIndexPartitionOf(tenantOf(this), month) }, sk: { S: `gateway#${row.callId}` } },
				ConsistentRead: true,
			}),
		);
		assert.equal(item.Item?.kind?.S, "gateway_call");
		assert.equal(item.Item?.source?.S, "gateway");
		assert.equal(item.Item?.turn_id?.S, observedTurnId(this));
	}
});

Then("the reconciliation found {int} pending observation(s)", function (this: ChatticusWorld, count: number) {
	assert.equal(lastReconciliationOf(this).turns.reduce((total, turn) => total + turn.pending, 0), count);
});

Then("the reconciliation flags the turn", function (this: ChatticusWorld) {
	const turn = lastReconciliationOf(this).turns.find((candidate) => candidate.turnId === observedTurnId(this));
	assert.ok(turn, "The reconciliation did not see the turn");
	assert.equal(turn.flagged, true);
});

Then("the reconciliation does not flag the turn", function (this: ChatticusWorld) {
	const turn = lastReconciliationOf(this).turns.find((candidate) => candidate.turnId === observedTurnId(this));
	assert.ok(turn, "The reconciliation did not see the turn");
	assert.equal(turn.flagged, false);
});

Then("the observation of the turn expires within 35 days", async function (this: ChatticusWorld) {
	const [observation] = await observationsOfTurn(this);
	assert.ok(observation, "There is no observation");
	const key = gatewayObservationKey(observation.tenantId, observation.turnId, observation.callId);
	const item = await this.messagingTable.client.send(
		new GetItemCommand({ TableName: this.messagingTable.tableName, Key: { pk: { S: key.pk }, sk: { S: key.sk } }, ConsistentRead: true }),
	);
	const seconds = Number(item.Item?.expires_at?.N) - Math.floor(Date.parse(observation.observedAt) / 1000);
	assert.equal(seconds, 35 * 24 * 60 * 60);
});
