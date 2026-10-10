import assert from "node:assert/strict";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import { getTurn } from "../../src/domain/turns.ts";
import { actionStoreOf } from "../computer-support.ts";
import { computerScenarioOf } from "../computer-scenario.ts";
import { httpBaseUrl } from "../front-door.ts";
import { createGatewayModels } from "../../../computer/host/src/owner-models.ts";
import { consoleLogEmitter } from "../../src/observability/log-line.ts";
import { assertEventsInOrder, capturedConsoleLines, parsedLogLines, type ParsedLogLine } from "../log-capture-support.ts";
import { gatewayScenarioOf, SCENARIO_VENDOR_KEY } from "../model-gateway-support.ts";
import { containerEnvironmentOf, OWNER_START_INVOKE_KEY, ownerStartOf } from "../owner-start-support.ts";
import { SCENARIO_GATEWAY_SIGNING_KEY } from "../model-gateway-support.ts";
import { FAKE_SCOPED_CREDENTIALS } from "../fakes/fake-ecs.ts";
import type { ChatticusWorld } from "../world.ts";
import { turnOf } from "./model-gateway.steps.ts";

const OWNER_EVENTS: ReadonlySet<string> = new Set([
	"owner_started",
	"workspace_hydrated",
	"turn_claimed",
	"turn_claim_lost",
	"turn_skipped",
	"tool_started",
	"tool_finished",
	"model_call",
	"snapshot_published",
	"snapshot_skipped",
	"owner_exit",
]);

const STARTER_EVENTS: ReadonlySet<string> = new Set([
	"owner_token_minted",
	"scoped_credentials_assumed",
	"scoped_credentials_failed",
	"owner_task_started",
	"owner_task_failed",
]);

const ownerLinesOf = (world: ChatticusWorld, ownerId: string): ParsedLogLine[] =>
	parsedLogLines(capturedConsoleLines(world)).filter((line) => OWNER_EVENTS.has(line.event) && line.fields.get("owner_id") === ownerId);

const starterLinesOf = (world: ChatticusWorld): ParsedLogLine[] => parsedLogLines(ownerStartOf(world).logs).filter((line) => STARTER_EVENTS.has(line.event));

const lineOf = (lines: readonly ParsedLogLine[], event: string): ParsedLogLine => {
	const found = lines.find((line) => line.event === event);
	assert.ok(found, `The log has no ${event} line. Events: ${lines.map((line) => line.event).join(", ")}`);
	return found;
};

const eventsOf = (table: DataTable): string[] => table.raw().map((row) => row[0]!);

function startJobOf(world: ChatticusWorld) {
	const job = computerScenarioOf(world).startJob;
	assert.ok(job, "No start job is queued in this scenario.");
	return job;
}

const startedOwnerId = (world: ChatticusWorld): string => {
	const value = containerEnvironmentOf(world).get("CHATTICUS_OWNER_ID");
	assert.ok(value, "The container environment has no owner id.");
	return value;
};

Then("the owner log of {string} shows these events in order:", function (this: ChatticusWorld, ownerId: string, table: DataTable) {
	assertEventsInOrder(ownerLinesOf(this, ownerId), eventsOf(table));
});

Then("the owner log of the started owner shows these events in order:", function (this: ChatticusWorld, table: DataTable) {
	assertEventsInOrder(ownerLinesOf(this, startedOwnerId(this)), eventsOf(table));
});

Then(
	"every owner log line of {string} names the tenant {string}, the turn and the owner id",
	function (this: ChatticusWorld, ownerId: string, tenantId: string) {
		const all = parsedLogLines(capturedConsoleLines(this)).filter((line) => OWNER_EVENTS.has(line.event));
		assert.ok(ownerLinesOf(this, ownerId).length > 0, `The owner ${ownerId} logged nothing.`);
		for (const line of all) {
			assert.equal(line.fields.get("tenant_id"), tenantId, line.text);
			assert.ok((line.fields.get("turn_id") ?? "") !== "", line.text);
			assert.ok((line.fields.get("owner_id") ?? "") !== "", line.text);
		}
	},
);

Then("the owner log line {string} of {string} has {string} {string}", function (this: ChatticusWorld, event: string, ownerId: string, field: string, value: string) {
	assert.equal(lineOf(ownerLinesOf(this, ownerId), event).fields.get(field), value);
});

Then("the owner log line {string} of {string} has a {string} number", function (this: ChatticusWorld, event: string, ownerId: string, field: string) {
	assert.match(lineOf(ownerLinesOf(this, ownerId), event).fields.get(field) ?? "", /^\d+$/);
});

Then("the owner log of {string} has a {string} line with {string} {string}", function (this: ChatticusWorld, ownerId: string, event: string, field: string, value: string) {
	const matching = ownerLinesOf(this, ownerId).filter((line) => line.event === event && line.fields.get(field) === value);
	assert.ok(matching.length > 0, `No ${event} line has ${field}=${value}.`);
});

Then("the owner log of {string} has no {string} line", function (this: ChatticusWorld, ownerId: string, event: string) {
	assert.equal(ownerLinesOf(this, ownerId).filter((line) => line.event === event).length, 0);
});

Then("the owner log of {string} has exactly {int} {string} line(s)", function (this: ChatticusWorld, ownerId: string, count: number, event: string) {
	assert.equal(ownerLinesOf(this, ownerId).filter((line) => line.event === event).length, count);
});

Then("the owner log of {string} does not contain {string}", function (this: ChatticusWorld, ownerId: string, text: string) {
	assert.ok(ownerLinesOf(this, ownerId).length > 0, `The owner ${ownerId} logged nothing.`);
	assert.ok(!capturedConsoleLines(this).some((line) => line.includes(text)), `A console line contains ${JSON.stringify(text)}.`);
});

Then("the owner log of {string} does not contain the container's token", function (this: ChatticusWorld, _ownerId: string) {
	const token = gatewayScenarioOf(this).lastToken;
	assert.ok(token !== "");
	assert.ok(!capturedConsoleLines(this).some((line) => line.includes(token)), "A console line contains the token.");
});

Then("the gateway logged a refusal because {string}", function (this: ChatticusWorld, reason: string) {
	const refusals = gatewayScenarioOf(this).logEvents.filter((event) => event.event === "refused");
	assert.equal(refusals.length, 1, `Expected one refusal, saw ${JSON.stringify(refusals)}`);
	assert.equal(refusals[0]!.reason, reason);
});

Then("that refusal names no tenant, no turn and no owner", function (this: ChatticusWorld) {
	const refusal = gatewayScenarioOf(this).logEvents.find((event) => event.event === "refused");
	assert.ok(refusal);
	assert.equal(refusal.tenantId, undefined);
	assert.equal(refusal.turnId, undefined);
	assert.equal(refusal.ownerId, undefined);
});

Then("that refusal names the tenant and the turn of the container", function (this: ChatticusWorld) {
	const refusal = gatewayScenarioOf(this).logEvents.find((event) => event.event === "refused");
	assert.ok(refusal);
	const turn = turnOf(this);
	assert.equal(refusal.tenantId, turn.tenantId);
	assert.equal(refusal.turnId, turn.turnId);
	assert.ok((refusal.ownerId ?? "") !== "");
});

Then("the gateway logged an upstream failure with a status", function (this: ChatticusWorld) {
	const failure = gatewayScenarioOf(this).logEvents.find((event) => event.event === "upstream_failed");
	assert.ok(failure, "The gateway logged no upstream failure.");
	assert.equal(typeof failure.status, "number");
});

Then("no gateway log line contains {string}", function (this: ChatticusWorld, text: string) {
	const lines = gatewayScenarioOf(this).consoleLines;
	assert.ok(lines.length > 0, "The gateway logged nothing.");
	assert.ok(!lines.join("\n").includes(text));
});

Then("no gateway log line contains the vendor key", function (this: ChatticusWorld) {
	assert.ok(!gatewayScenarioOf(this).consoleLines.join("\n").includes(SCENARIO_VENDOR_KEY));
});

Then("no gateway log line contains the container's token", function (this: ChatticusWorld) {
	assert.ok(!gatewayScenarioOf(this).consoleLines.join("\n").includes(gatewayScenarioOf(this).lastToken));
});

Given("STS refuses the assume role with the error {string}", function (this: ChatticusWorld, name: string) {
	ownerStartOf(this).sts.refusalName = name;
});

Given("ECS answers the run task with no task", function (this: ChatticusWorld) {
	ownerStartOf(this).ecs.startsNoTask = true;
});

Then("the starter log shows these events in order:", function (this: ChatticusWorld, table: DataTable) {
	assertEventsInOrder(starterLinesOf(this), eventsOf(table));
});

Then("every starter log line names the tenant and the turn of the start job and the owner id of the container", function (this: ChatticusWorld) {
	const job = startJobOf(this);
	const lines = starterLinesOf(this);
	assert.ok(lines.length > 0, "The starter logged nothing.");
	const ownerId = startedOwnerId(this);
	for (const line of lines) {
		assert.equal(line.fields.get("tenant_id"), job.tenantId, line.text);
		assert.equal(line.fields.get("turn_id"), job.turnId, line.text);
		assert.equal(line.fields.get("owner_id"), ownerId, line.text);
	}
});

Then("the starter log line {string} has {string} {string}", function (this: ChatticusWorld, event: string, field: string, value: string) {
	assert.equal(lineOf(starterLinesOf(this), event).fields.get(field), value);
});

Then("the starter log line {string} has the session name of the owner id", function (this: ChatticusWorld, event: string) {
	assert.equal(lineOf(starterLinesOf(this), event).fields.get("session_name"), startedOwnerId(this).slice(0, 64));
});

Then("the starter log has no {string} line", function (this: ChatticusWorld, event: string) {
	assert.equal(starterLinesOf(this).filter((line) => line.event === event).length, 0);
});

Then("the starter log does not contain {string}", function (this: ChatticusWorld, text: string) {
	assert.ok(ownerStartOf(this).logs.length > 0, "The starter logged nothing.");
	assert.ok(!ownerStartOf(this).logs.join("\n").includes(text));
});

Then("the combined log text of the starter, the owner and the gateway contains none of:", async function (this: ChatticusWorld, table: DataTable) {
	const job = startJobOf(this);
	const turn = await getTurn(this.turnDependencies(), job.tenantId, job.turnId);
	const actions = await actionStoreOf(this).listForTurn(job.tenantId, turn.turnId);
	assert.ok(actions.length > 0, "The turn has no computer action to take the tool's arguments and output from.");
	const secrets = new Map<string, string[]>([
		["the gateway token", [containerEnvironmentOf(this).get("CHATTICUS_MODEL_GATEWAY_TOKEN") ?? ""]],
		["the scoped access key id", [FAKE_SCOPED_CREDENTIALS.AccessKeyId]],
		["the scoped secret access key", [FAKE_SCOPED_CREDENTIALS.SecretAccessKey]],
		["the scoped session token", [FAKE_SCOPED_CREDENTIALS.SessionToken]],
		["the invoke key", [OWNER_START_INVOKE_KEY]],
		["the signing key", [SCENARIO_GATEWAY_SIGNING_KEY]],
		["the vendor key", [SCENARIO_VENDOR_KEY]],
		["the tool arguments", actions.flatMap((action) => Object.values(action.arguments))],
		["the tool output", actions.map((action) => action.result ?? "")],
	]);
	const text = [...capturedConsoleLines(this), ...ownerStartOf(this).logs, ...gatewayScenarioOf(this).consoleLines].join("\n");
	assert.ok(text.includes("tool_finished") && text.includes("owner_task_started"), "The combined log is missing the lines under test.");
	for (const [description] of table.raw().map((row) => row as [string])) {
		const values = secrets.get(description);
		assert.ok(values, `Unknown secret description ${description}`);
		for (const value of values) {
			assert.ok(value !== "", `${description} is empty, so the check proves nothing.`);
			assert.ok(!text.includes(value), `The log text contains ${description}.`);
		}
	}
});

When("the container asks the model gateway for an answer through Pi and logs as its owner", async function (this: ChatticusWorld) {
	const environment = containerEnvironmentOf(this);
	const tenantId = environment.get("CHATTICUS_TENANT_ID")!;
	const models = createGatewayModels(
		{
			baseUrl: `${await httpBaseUrl(this)}/orgs/${tenantId}/model-gateway/v1`,
			token: environment.get("CHATTICUS_MODEL_GATEWAY_TOKEN")!,
			invokeKey: environment.get("CHATTICUS_INVOKE_KEY")!,
		},
		consoleLogEmitter({ tenant_id: tenantId, turn_id: environment.get("CHATTICUS_TAKEOVER_TURN_ID")!, owner_id: startedOwnerId(this) }),
	);
	const model = models.getModel("openai", "gpt-5-nano");
	assert.ok(model, "Pi has no model to ask");
	const answer = await models.complete(model, { messages: [{ role: "user", content: "Say good morning.", timestamp: Date.now() }] });
	assert.equal(answer.stopReason, "stop", JSON.stringify(answer));
});
