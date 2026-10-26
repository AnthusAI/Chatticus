import assert from "node:assert/strict";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import type { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import type { GetParameterCommand } from "@aws-sdk/client-ssm";
import type { EventPutter } from "../../src/channels/eventbridge-publisher.ts";
import {
	CHANNELS_CORRELATOR_SECRET_PARAMETER_NAME_VARIABLE,
	CHANNELS_EVENT_BUS_NAME_VARIABLE,
	CHANNELS_KILL_SWITCH_VARIABLE,
	CHANNELS_MAIL_DOMAIN_VARIABLE,
	composeChannelsRuntime,
	composeReplyDeliveryRecorder,
} from "../../src/lambdas/channels-composition.ts";
import { channelsScenarioOf } from "../channels-support.ts";
import { wireFrontDoor } from "../front-door.ts";
import { DEFAULT_OPERATOR_KEY } from "./operator.steps.ts";
import type { ChatticusWorld } from "../world.ts";

const DEPLOYED_SECRET_VALUE = "deployed-correlator-secret";
const DEPLOYED_MAIL_DOMAIN = "mail.develop.example.test";

type RecordedEntry = NonNullable<PutEventsCommand["input"]["Entries"]>[number];

type DeploymentState = {
	environment: Record<string, string>;
	readonly parameters: Map<string, string>;
	readonly requestedParameters: string[];
	readonly busEntries: RecordedEntry[];
	failure: Error | null;
};

const deployments = new WeakMap<ChatticusWorld, DeploymentState>();

function deploymentOf(world: ChatticusWorld): DeploymentState {
	let state = deployments.get(world);
	if (state === undefined) {
		state = { environment: {}, parameters: new Map(), requestedParameters: [], busEntries: [], failure: null };
		deployments.set(world, state);
	}
	return state;
}

function standardEnvironmentOf(state: DeploymentState, parameterName: string): void {
	if (state.environment[CHANNELS_MAIL_DOMAIN_VARIABLE] !== undefined) return;
	state.environment = {
		[CHANNELS_MAIL_DOMAIN_VARIABLE]: DEPLOYED_MAIL_DOMAIN,
		[CHANNELS_CORRELATOR_SECRET_PARAMETER_NAME_VARIABLE]: parameterName,
		[CHANNELS_EVENT_BUS_NAME_VARIABLE]: "default",
	};
}

const SECRET_PARAMETER_NAME = "/chatticus/test/channels/correlator-secret";

function parameterReaderOf(state: DeploymentState) {
	return {
		async send(command: GetParameterCommand) {
			assert.equal(command.input.WithDecryption, true, "A secret parameter is read with decryption");
			const name = command.input.Name ?? "";
			state.requestedParameters.push(name);
			const value = state.parameters.get(name);
			return { Parameter: value === undefined ? undefined : { Value: value } };
		},
	};
}

function busOf(state: DeploymentState): EventPutter {
	return {
		async send(command: PutEventsCommand) {
			state.busEntries.push(...(command.input.Entries ?? []));
			return { FailedEntryCount: 0, Entries: (command.input.Entries ?? []).map(() => ({})) };
		},
	};
}

Given("the deployment's parameter store holds the correlator secret under {string}", function (this: ChatticusWorld, name: string) {
	deploymentOf(this).parameters.set(name, DEPLOYED_SECRET_VALUE);
});

Given("the deployment's parameter store holds no value under {string}", function (this: ChatticusWorld, name: string) {
	deploymentOf(this).parameters.set(name, "");
});

Given("the deployment sets the channel environment:", function (this: ChatticusWorld, table: DataTable) {
	deploymentOf(this).environment = { ...table.rowsHash() };
});

Given("the deployment releases the kill switch", function (this: ChatticusWorld) {
	const state = deploymentOf(this);
	standardEnvironmentOf(state, SECRET_PARAMETER_NAME);
	state.environment[CHANNELS_KILL_SWITCH_VARIABLE] = "released";
});

Given("the deployment sets the kill switch to {string}", function (this: ChatticusWorld, value: string) {
	const state = deploymentOf(this);
	standardEnvironmentOf(state, SECRET_PARAMETER_NAME);
	state.environment[CHANNELS_KILL_SWITCH_VARIABLE] = value;
});

Given("the deployment leaves out the channel variable {string}", function (this: ChatticusWorld, name: string) {
	delete deploymentOf(this).environment[name];
});

When("the deployment composes external channels", async function (this: ChatticusWorld) {
	const state = deploymentOf(this);
	const scenario = channelsScenarioOf(this);
	const clients = { dynamo: this.messagingTable.client, parameters: parameterReaderOf(state), events: busOf(state) };
	try {
		const runtime = await composeChannelsRuntime(state.environment, clients, this.messagingTable.tableName);
		const recorder = composeReplyDeliveryRecorder(state.environment, clients, this.messagingTable.tableName, this.clock);
		scenario.deployment = { runtime, recorder };
		scenario.mailDomain = state.environment[CHANNELS_MAIL_DOMAIN_VARIABLE] ?? scenario.mailDomain;
		state.failure = null;
	} catch (error) {
		state.failure = error instanceof Error ? error : new Error(String(error));
		return;
	}
	assert.ok(this.frontDoorOptions, "The scenario has no front door yet");
	await wireFrontDoor(this, { ...this.frontDoorOptions, operatorKey: DEFAULT_OPERATOR_KEY });
});

Then("external channels do not exist in this deployment", function (this: ChatticusWorld) {
	const deployment = channelsScenarioOf(this).deployment;
	assert.ok(deployment, "The deployment has not composed external channels");
	assert.equal(deployment.runtime, null);
	assert.equal(deployment.recorder, undefined);
});

Then("the deployment read exactly the parameter {string}", function (this: ChatticusWorld, name: string) {
	assert.deepEqual(deploymentOf(this).requestedParameters, [name]);
});

Then("the deployment refused to start with {string}", function (this: ChatticusWorld, message: string) {
	const failure = deploymentOf(this).failure;
	assert.ok(failure, "The deployment composed without a failure");
	assert.ok(failure.message.includes(message), failure.message);
});

Then("the event bus received {int} event(s)", function (this: ChatticusWorld, count: number) {
	assert.equal(deploymentOf(this).busEntries.length, count);
});

function lastBusEntry(world: ChatticusWorld): RecordedEntry {
	const entries = deploymentOf(world).busEntries;
	const entry = entries[entries.length - 1];
	assert.ok(entry, "The event bus received no event");
	return entry;
}

Then("the bus event is a {string} from {string} on the bus {string}", function (this: ChatticusWorld, detailType: string, source: string, bus: string) {
	const entry = lastBusEntry(this);
	assert.equal(entry.DetailType, detailType);
	assert.equal(entry.Source, source);
	assert.equal(entry.EventBusName, bus);
});

Then("the bus event carries only the tenant, message and binding ids", function (this: ChatticusWorld) {
	const detail = JSON.parse(lastBusEntry(this).Detail ?? "{}") as Record<string, unknown>;
	assert.deepEqual(Object.keys(detail).sort(), ["binding_id", "message_id", "tenant_id"]);
	for (const value of Object.values(detail)) assert.equal(typeof value, "string");
});

Then("the bus event does not contain the answer text or the sender", function (this: ChatticusWorld) {
	const detail = lastBusEntry(this).Detail ?? "";
	assert.ok(!detail.includes("The research is done."));
	assert.ok(!detail.includes("sam.sender"));
});
