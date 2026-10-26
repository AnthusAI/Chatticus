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
	ChannelsRuntimeHolder,
	composeChannelsRuntime,
	replyDeliveryRecorderOrNothing,
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
	readonly frontDoorLogs: string[];
	readonly executorLogs: string[];
	parameterFailure: string | null;
	busRefuses: boolean;
};

const deployments = new WeakMap<ChatticusWorld, DeploymentState>();

function deploymentOf(world: ChatticusWorld): DeploymentState {
	let state = deployments.get(world);
	if (state === undefined) {
		state = { environment: {}, parameters: new Map(), requestedParameters: [], busEntries: [], frontDoorLogs: [], executorLogs: [], parameterFailure: null, busRefuses: false };
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
			if (state.parameterFailure !== null) throw Object.assign(new Error("Rate exceeded"), { name: state.parameterFailure });
			const value = state.parameters.get(name);
			return { Parameter: value === undefined ? undefined : { Value: value } };
		},
	};
}

function busOf(state: DeploymentState): EventPutter {
	return {
		async send(command: PutEventsCommand) {
			const entries = command.input.Entries ?? [];
			if (state.busRefuses) return { FailedEntryCount: entries.length, Entries: entries.map(() => ({ ErrorCode: "InternalFailure" })) };
			state.busEntries.push(...entries);
			return { FailedEntryCount: 0, Entries: entries.map(() => ({})) };
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

Given("the deployment is broken by {string}", function (this: ChatticusWorld, breakage: string) {
	const state = deploymentOf(this);
	if (breakage === "an invalid kill switch value") state.environment[CHANNELS_KILL_SWITCH_VARIABLE] = "maybe";
	else if (breakage === "an empty secret parameter") state.parameters.set(SECRET_PARAMETER_NAME, "");
	else if (breakage === "a missing secret parameter name") delete state.environment[CHANNELS_CORRELATOR_SECRET_PARAMETER_NAME_VARIABLE];
	else if (breakage === "a missing event bus name") delete state.environment[CHANNELS_EVENT_BUS_NAME_VARIABLE];
	else assert.fail(`Unknown breakage ${breakage}`);
});

Given("the parameter store fails its reads", function (this: ChatticusWorld) {
	deploymentOf(this).parameterFailure = "ThrottlingException";
});

When("the parameter store recovers", function (this: ChatticusWorld) {
	deploymentOf(this).parameterFailure = null;
});

Given("the event bus refuses every event", function (this: ChatticusWorld) {
	deploymentOf(this).busRefuses = true;
});

When("the clock moves forward {int} seconds", function (this: ChatticusWorld, seconds: number) {
	this.clock.advanceSeconds(seconds);
});

When("the deployment composes external channels", async function (this: ChatticusWorld) {
	const state = deploymentOf(this);
	const scenario = channelsScenarioOf(this);
	const clients = { dynamo: this.messagingTable.client, parameters: parameterReaderOf(state), events: busOf(state) };
	const tableName = this.messagingTable.tableName;
	const holder = new ChannelsRuntimeHolder(
		() => composeChannelsRuntime(state.environment, clients, tableName, () => undefined),
		this.clock,
		(line) => void state.frontDoorLogs.push(line),
	);
	await holder.source();
	const recorder = replyDeliveryRecorderOrNothing(state.environment, clients, tableName, this.clock, (line) => void state.executorLogs.push(line));
	scenario.deployment = { holder, recorder };
	scenario.mailDomain = state.environment[CHANNELS_MAIL_DOMAIN_VARIABLE] ?? scenario.mailDomain;
	assert.ok(this.frontDoorOptions, "The scenario has no front door yet");
	await wireFrontDoor(this, { ...this.frontDoorOptions, operatorKey: DEFAULT_OPERATOR_KEY });
});

function compositionErrorsIn(lines: readonly string[]): string[] {
	return lines.filter((line) => line.includes('"event":"channels_composition_failed"'));
}

Then(
	"the front door logged {int} channel composition error(s) that name(s) {string} and hold(s) no secret",
	function (this: ChatticusWorld, count: number, named: string) {
		const errors = compositionErrorsIn(deploymentOf(this).frontDoorLogs);
		assert.equal(errors.length, count, errors.join("\n"));
		for (const line of errors) {
			assert.ok(line.includes(named), line);
			assert.ok(!line.includes(DEPLOYED_SECRET_VALUE), line);
		}
	},
);

Then("the executor logged {int} channel composition error(s)", function (this: ChatticusWorld, count: number) {
	assert.equal(compositionErrorsIn(deploymentOf(this).executorLogs).length, count);
});

Then("the executor logged {int} event publish failure naming ids only", function (this: ChatticusWorld, count: number) {
	const lines = deploymentOf(this).executorLogs.filter((line) => line.includes('"event":"channel_event_publish_failed"'));
	assert.equal(lines.length, count);
	for (const line of lines) {
		const parsed = JSON.parse(line) as Record<string, unknown>;
		assert.deepEqual(Object.keys(parsed).sort(), ["binding_id", "component", "error_name", "event", "level", "message_id", "tenant_id"]);
		assert.ok(!line.includes("The research is done.") && !line.includes("sam.sender"));
	}
});

Then("the front door answers its health route", async function (this: ChatticusWorld) {
	assert.ok(this.api);
	const response = await this.api.get("/health");
	assert.equal(response.status, 200);
});

Then("external channels do not exist in this deployment", function (this: ChatticusWorld) {
	const deployment = channelsScenarioOf(this).deployment;
	assert.ok(deployment, "The deployment has not composed external channels");
	assert.equal(deployment.holder.current, null);
	assert.equal(deployment.recorder, undefined);
});

Then("the deployment read exactly the parameter {string}", function (this: ChatticusWorld, name: string) {
	assert.deepEqual(deploymentOf(this).requestedParameters, [name]);
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
