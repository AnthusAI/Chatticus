import assert from "node:assert/strict";
import { Then, When, type DataTable } from "@cucumber/cucumber";
import { getTurn } from "../../src/domain/turns.ts";
import { consoleLogEmitter } from "../../src/observability/log-line.ts";
import { createGatewayModels } from "../../../computer/host/src/owner-models.ts";
import { actionStoreOf } from "../computer-support.ts";
import { computerScenarioOf } from "../computer-scenario.ts";
import { startComputerOwner } from "../computer-owner.ts";
import { httpBaseUrl } from "../front-door.ts";
import { assertEventsInOrder, capturedConsoleLines, parsedLogLines } from "../log-capture-support.ts";
import { gatewayScenarioOf, SCENARIO_GATEWAY_SIGNING_KEY, SCENARIO_VENDOR_KEY } from "../model-gateway-support.ts";
import { containerEnvironmentOf, OWNER_START_INVOKE_KEY, ownerStartOf } from "../owner-start-support.ts";
import type { ChatticusWorld } from "../world.ts";
import { ownerServerOf, poll, presentBootstrap } from "./owner-supervisor-server.steps.ts";

const FRONT_DOOR_EVENTS: ReadonlySet<string> = new Set([
	"owner_bootstrap_ok",
	"owner_bootstrap_refused",
	"owner_dispatch_offered",
	"owner_dispatch_failed",
	"owner_stop_decision",
]);

const startedEnvironment = (world: ChatticusWorld, name: string): string => {
	const value = containerEnvironmentOf(world).get(name);
	assert.ok(value, `The container environment has no ${name}.`);
	return value;
};

function startJobOf(world: ChatticusWorld) {
	const job = computerScenarioOf(world).startJob;
	assert.ok(job, "No start job is queued in this scenario.");
	return job;
}

Then("the Front Door log shows these events in order:", function (this: ChatticusWorld, table: DataTable) {
	assertEventsInOrder(
		parsedLogLines(capturedConsoleLines(this)).filter((line) => FRONT_DOOR_EVENTS.has(line.event)),
		table.raw().map((row) => row[0]!),
	);
});

When("the owner exchanges its bootstrap token and is offered the parked turn", async function (this: ChatticusWorld) {
	const scenario = ownerServerOf(this);
	scenario.ownerId = startedEnvironment(this, "CHATTICUS_OWNER_ID");
	scenario.computerId = startedEnvironment(this, "CHATTICUS_COMPUTER_ID");
	scenario.generation = Number(startedEnvironment(this, "CHATTICUS_OWNER_START_GENERATION"));
	scenario.bootstrapToken = startedEnvironment(this, "CHATTICUS_OWNER_BOOTSTRAP_TOKEN");
	const bootstrapped = await presentBootstrap(this, scenario.bootstrapToken);
	assert.equal(bootstrapped.status, 200, JSON.stringify(bootstrapped.body));
	const polled = await poll(this, "idle");
	assert.equal(polled.status, 200, JSON.stringify(polled.body));
	assert.equal(scenario.dispatches.length, 1, "The owner was offered no dispatch.");
});

When("the container takes over the turn with its dispatch and is held after its tool ran", async function (this: ChatticusWorld) {
	const dispatch = ownerServerOf(this).dispatches.at(-1);
	assert.ok(dispatch, "No dispatch was offered.");
	const job = startJobOf(this);
	const { ended, held } = await startComputerOwner(this, "started", {
		hold: true,
		job: { tenantId: job.tenantId, turnId: dispatch.turn_id, botId: dispatch.bot_id },
		workerId: startedEnvironment(this, "CHATTICUS_OWNER_ID"),
	});
	assert.ok(held);
	const early = ended.then((outcome) => {
		throw new Error(`The container ended ${outcome} before its tool ran.`);
	});
	await Promise.race([held.reached, early]);
});

When("the container asks the model gateway for an answer through Pi and logs as its owner", async function (this: ChatticusWorld) {
	const dispatch = ownerServerOf(this).dispatches.at(-1);
	assert.ok(dispatch, "No dispatch was offered.");
	const tenantId = startedEnvironment(this, "CHATTICUS_TENANT_ID");
	const models = createGatewayModels(
		{ baseUrl: `${await httpBaseUrl(this)}/orgs/${tenantId}/model-gateway/v1`, token: dispatch.gateway_token },
		consoleLogEmitter({ tenant_id: tenantId, turn_id: dispatch.turn_id, owner_id: startedEnvironment(this, "CHATTICUS_OWNER_ID") }),
	);
	const model = models.getModel("openai", "gpt-5-nano");
	assert.ok(model, "Pi has no model to ask");
	const answer = await models.complete(model, { messages: [{ role: "user", content: "Say good morning.", timestamp: Date.now() }] });
	assert.equal(answer.stopReason, "stop", JSON.stringify(answer));
});

Then(
	"the combined log text of the starter, the Front Door, the owner and the gateway contains none of:",
	async function (this: ChatticusWorld, table: DataTable) {
		const job = startJobOf(this);
		const turn = await getTurn(this.turnDependencies(), job.tenantId, job.turnId);
		const actions = await actionStoreOf(this).listForTurn(job.tenantId, turn.turnId);
		assert.ok(actions.length > 0, "The turn has no computer action to take the tool's arguments and output from.");
		const scenario = ownerServerOf(this);
		const dispatch = scenario.dispatches.at(-1);
		assert.ok(dispatch, "No dispatch was offered.");
		const supervisorCredentials = scenario.bootstrapAnswers.find((answer) => answer.status === 200)?.body.aws_credentials as { secret_access_key: string };
		const secrets = new Map<string, string[]>([
			["the bootstrap token", [scenario.bootstrapToken]],
			["the supervisor token", [scenario.supervisorToken]],
			["the gateway token", [dispatch.gateway_token]],
			["the turn's access key id", [dispatch.aws_credentials.access_key_id]],
			["the turn's secret access key", [dispatch.aws_credentials.secret_access_key]],
			["the turn's session token", [dispatch.aws_credentials.session_token]],
			["the supervisor's secret key", [supervisorCredentials.secret_access_key]],
			["the invoke key", [OWNER_START_INVOKE_KEY]],
			["the signing key", [SCENARIO_GATEWAY_SIGNING_KEY]],
			["the vendor key", [SCENARIO_VENDOR_KEY]],
			["the tool arguments", actions.flatMap((action) => Object.values(action.arguments))],
			["the tool output", actions.map((action) => action.result ?? "")],
		]);
		const text = [...capturedConsoleLines(this), ...ownerStartOf(this).logs, ...gatewayScenarioOf(this).consoleLines].join("\n");
		assert.ok(
			text.includes("tool_finished") && text.includes("owner_task_started") && text.includes("owner_dispatch_offered"),
			"The combined log is missing the lines under test.",
		);
		for (const [description] of table.raw().map((row) => row as [string])) {
			const values = secrets.get(description);
			assert.ok(values, `Unknown secret description ${description}`);
			for (const value of values) {
				assert.ok(value !== "", `${description} is empty, so the check proves nothing.`);
				assert.ok(!text.includes(value), `The log text contains ${description}.`);
			}
		}
	},
);
