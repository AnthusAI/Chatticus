import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import {
	actionResultResponseSchema,
	claimActionResponseSchema,
	hostComputerSchema,
	renewActionResponseSchema,
	type HostAction,
	type HostComputer,
	HOST_USER_HEADER,
} from "@chatticus/host-protocol";
import { runFargateTask } from "../../src/computer/host-starter.ts";
import { type RecordedResponse, recordResponse } from "../api.ts";
import { FakeEcs } from "../fakes/fake-customer-aws.ts";
import {
	HOUSEHOLD_HOST_WORKER_ID,
	STORY_TENANT,
	STORY_USER,
	computerScenarioOf,
	hostNamed,
	journalNow,
	registerHost,
} from "../computer-scenario.ts";
import { actionStoreOf } from "../computer-support.ts";
import { activeTurnOf } from "../turn-grant-support.ts";
import { runQueuedJobs } from "../turn-recovery.ts";
import type { ChatticusWorld } from "../world.ts";

type HostScenario = {
	lastResponse: RecordedResponse | null;
	claimedAction: HostAction | null;
	firstLease: string | null;
	readinessOrder: string[];
};

const scenarios = new WeakMap<ChatticusWorld, HostScenario>();

function hostScenarioOf(world: ChatticusWorld): HostScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = { lastResponse: null, claimedAction: null, firstLease: null, readinessOrder: [] };
		scenarios.set(world, scenario);
	}
	return scenario;
}

function lastResponseOf(world: ChatticusWorld): RecordedResponse {
	const response = hostScenarioOf(world).lastResponse;
	assert.ok(response, "The host has made no request in this scenario.");
	return response;
}

async function computerSeenBy(world: ChatticusWorld, workerId: string): Promise<HostComputer> {
	const response = await hostNamed(world, workerId).request("GET", "/computer");
	assert.equal(response.status, 200, response.text);
	return hostComputerSchema.parse(response.json);
}

async function claimFor(world: ChatticusWorld, workerId: string): Promise<HostAction | null> {
	const response = await hostNamed(world, workerId).request("POST", "/actions/claim");
	hostScenarioOf(world).lastResponse = response;
	assert.equal(response.status, 200, response.text);
	return claimActionResponseSchema.parse(response.json).action;
}

function claimedActionOf(world: ChatticusWorld): HostAction {
	const action = hostScenarioOf(world).claimedAction;
	assert.ok(action, "No host has claimed an action in this scenario.");
	return action;
}

async function reportReady(world: ChatticusWorld, workerId: string, capability: string): Promise<RecordedResponse> {
	const response = await hostNamed(world, workerId).request("POST", "/computer/state", {
		body: { capability_ready: capability },
		headers: { [HOST_USER_HEADER]: STORY_USER },
	});
	hostScenarioOf(world).lastResponse = response;
	return response;
}

When("host worker {string} reads the computer", async function (this: ChatticusWorld, workerId: string) {
	hostScenarioOf(this).lastResponse = await hostNamed(this, workerId).request("GET", "/computer");
});

When("host worker {string} reports the computer running", async function (this: ChatticusWorld, workerId: string) {
	hostScenarioOf(this).lastResponse = await hostNamed(this, workerId).request("POST", "/computer/state", { body: { stopped: false } });
});

When(
	"host worker {string} reports the {string} capability ready",
	async function (this: ChatticusWorld, workerId: string, capability: string) {
		await reportReady(this, workerId, capability);
	},
);

When("host worker {string} reports a computer state with nothing in it", async function (this: ChatticusWorld, workerId: string) {
	hostScenarioOf(this).lastResponse = await hostNamed(this, workerId).request("POST", "/computer/state", { body: {} });
});

When(
	"host worker {string} publishes a snapshot with checksum {string}",
	async function (this: ChatticusWorld, workerId: string, checksum: string) {
		hostScenarioOf(this).lastResponse = await hostNamed(this, workerId).request("POST", "/snapshot/published", {
			body: { worker_id: workerId, checksum },
		});
	},
);

When("host worker {string} reports its snapshot hydrated", async function (this: ChatticusWorld, workerId: string) {
	hostScenarioOf(this).lastResponse = await hostNamed(this, workerId).request("POST", "/snapshot/hydrated", {
		body: { worker_id: workerId },
	});
});

When(
	"host worker {string} reports the snapshot hydrated as worker {string}",
	async function (this: ChatticusWorld, workerId: string, otherWorkerId: string) {
		hostScenarioOf(this).lastResponse = await hostNamed(this, workerId).request("POST", "/snapshot/hydrated", {
			body: { worker_id: otherWorkerId },
		});
	},
);

When("a caller with no worker credential claims an action", async function (this: ChatticusWorld) {
	assert.ok(this.api, "The scenario has no HTTP front door.");
	hostScenarioOf(this).lastResponse = await recordResponse(
		await this.api.post(`/orgs/${STORY_TENANT}/host/actions/claim`, { body: {} }),
	);
});

When("host worker {string} claims the next action", async function (this: ChatticusWorld, workerId: string) {
	const scenario = hostScenarioOf(this);
	scenario.claimedAction = await claimFor(this, workerId);
	scenario.firstLease = scenario.claimedAction?.lease_expires_at ?? null;
});

When("host worker {string} renews the action it holds", async function (this: ChatticusWorld, workerId: string) {
	const action = claimedActionOf(this);
	hostScenarioOf(this).lastResponse = await hostNamed(this, workerId).request("POST", `/actions/${action.action_id}/renew`);
});

When(
	"host worker {string} posts the result {string} for the action it holds",
	async function (this: ChatticusWorld, workerId: string, result: string) {
		const action = claimedActionOf(this);
		hostScenarioOf(this).lastResponse = await hostNamed(this, workerId).request("POST", `/actions/${action.action_id}/result`, {
			body: { result },
		});
	},
);

When(
	"host worker {string} posts the error {string} for the action it holds",
	async function (this: ChatticusWorld, workerId: string, error: string) {
		const action = claimedActionOf(this);
		hostScenarioOf(this).lastResponse = await hostNamed(this, workerId).request("POST", `/actions/${action.action_id}/result`, {
			body: { error },
		});
	},
);

When(
	"host worker {string} posts both a result and an error for the action it holds",
	async function (this: ChatticusWorld, workerId: string) {
		const action = claimedActionOf(this);
		hostScenarioOf(this).lastResponse = await hostNamed(this, workerId).request("POST", `/actions/${action.action_id}/result`, {
			body: { result: "opened", error: "disk full" },
		});
	},
);

When(
	"host worker {string} asks to regate {word} of {string}",
	async function (this: ChatticusWorld, workerId: string, kind: string, target: string) {
		const action = claimedActionOf(this);
		hostScenarioOf(this).lastResponse = await hostNamed(this, workerId).request("POST", `/actions/${action.action_id}/regate`, {
			body: { kind, target },
		});
	},
);

When("host worker {string} sends a heartbeat", async function (this: ChatticusWorld, workerId: string) {
	hostScenarioOf(this).lastResponse = await hostNamed(this, workerId).request("POST", "/heartbeat");
});

When("the platform runs the queued turn jobs", async function (this: ChatticusWorld) {
	assert.equal((await runQueuedJobs(this)).at(-1), "done");
});

Then("the host request is accepted", function (this: ChatticusWorld) {
	const response = lastResponseOf(this);
	assert.equal(response.status, 200, response.text);
});

Then("the host request is refused with status {int}", function (this: ChatticusWorld, status: number) {
	const response = lastResponseOf(this);
	assert.equal(response.status, status, response.text);
});

Then(
	"the host request is refused with status {int} saying {string}",
	function (this: ChatticusWorld, status: number, text: string) {
		const response = lastResponseOf(this);
		assert.equal(response.status, status, response.text);
		assert.ok(String(response.json?.detail).includes(text), response.text);
	},
);

Then("host worker {string} sees the computer stopped", async function (this: ChatticusWorld, workerId: string) {
	assert.equal((await computerSeenBy(this, workerId)).stopped, true);
});

Then("host worker {string} sees the computer running", async function (this: ChatticusWorld, workerId: string) {
	assert.equal((await computerSeenBy(this, workerId)).stopped, false);
});

Then(
	"host worker {string} sees the {string} capability ready",
	async function (this: ChatticusWorld, workerId: string, capability: string) {
		assert.equal((await computerSeenBy(this, workerId))[`${capability}_ready` as "model_ready"], true);
	},
);

Then(
	"host worker {string} sees the {string} capability not ready",
	async function (this: ChatticusWorld, workerId: string, capability: string) {
		assert.equal((await computerSeenBy(this, workerId))[`${capability}_ready` as "model_ready"], false);
	},
);

Then(
	"host worker {string} sees snapshot generation {int} with checksum {string}",
	async function (this: ChatticusWorld, workerId: string, generation: number, checksum: string) {
		const computer = await computerSeenBy(this, workerId);
		assert.equal(computer.snapshot_generation, generation);
		assert.equal(computer.snapshot_checksum, checksum);
	},
);

Then("the host is given no action", function (this: ChatticusWorld) {
	assert.equal(claimActionResponseSchema.parse(lastResponseOf(this).json).action, null);
});

Then(
	"the host is given a {string} action for the parked turn under a lease",
	function (this: ChatticusWorld, toolName: string) {
		const action = claimedActionOf(this);
		assert.equal(action.tool_name, toolName);
		assert.equal(action.turn_id, activeTurnOf(this).turnId);
		assert.equal(action.status, "claimed");
		assert.ok(action.lease_expires_at, "The claimed action carries no lease.");
	},
);

Then("the lease of that action ends later than before", function (this: ChatticusWorld) {
	const renewed = renewActionResponseSchema.parse(lastResponseOf(this).json).action;
	const first = hostScenarioOf(this).firstLease;
	assert.ok(first && renewed.lease_expires_at, "The action carries no lease.");
	assert.ok(Date.parse(renewed.lease_expires_at) > Date.parse(first), `${renewed.lease_expires_at} is not after ${first}`);
});

Then("the host is told the parked turn was resumed", function (this: ChatticusWorld) {
	const answer = actionResultResponseSchema.parse(lastResponseOf(this).json);
	assert.equal(answer.turn_id, activeTurnOf(this).turnId);
	assert.equal(answer.turn_resumed, true);
});

Then("the turn journal records a tool result containing {string} for the pending action id", async function (this: ChatticusWorld, body: string) {
	const state = computerScenarioOf(this);
	const { tenantId } = activeTurnOf(this);
	const action = await actionStoreOf(this).get(tenantId, state.pendingActionId!);
	const results = (await journalNow(this)).filter((event) => event.kind === "tool.result" && event.action_id === action?.callId);
	assert.equal(results.length, 1);
	assert.ok(String(results[0]!.body).includes(body), String(results[0]!.body));
});

When("the customer computer host boots through the Front Door worker plane", async function (this: ChatticusWorld) {
	const host = await registerHost(this, STORY_TENANT, HOUSEHOLD_HOST_WORKER_ID, "local");
	const order = hostScenarioOf(this).readinessOrder;
	const stopped = await host.request("POST", "/computer/state", { body: { stopped: false } });
	assert.equal(stopped.status, 200, stopped.text);
	for (const capability of ["model", "workspace", "browser"]) {
		const response = await reportReady(this, HOUSEHOLD_HOST_WORKER_ID, capability);
		assert.equal(response.status, 200, response.text);
		order.push(capability);
	}
});

Then(
	"tenant {string} household computer readiness reports model before browser",
	async function (this: ChatticusWorld, _tenantId: string) {
		const order = hostScenarioOf(this).readinessOrder;
		assert.ok(order.indexOf("model") !== -1 && order.indexOf("model") < order.indexOf("browser"), JSON.stringify(order));
		assert.equal((await computerSeenBy(this, HOUSEHOLD_HOST_WORKER_ID)).model_ready, true);
	},
);

Then("tenant {string} household computer readiness reports browser ready", async function (this: ChatticusWorld, _tenantId: string) {
	assert.equal((await computerSeenBy(this, HOUSEHOLD_HOST_WORKER_ID)).browser_ready, true);
});

When("the customer computer host discovers a computer job through the Front Door", async function (this: ChatticusWorld) {
	await registerHost(this, STORY_TENANT, HOUSEHOLD_HOST_WORKER_ID, "local");
	hostScenarioOf(this).claimedAction = await claimFor(this, HOUSEHOLD_HOST_WORKER_ID);
});

Then("the discovered computer job matches the queued continuation job", function (this: ChatticusWorld) {
	const state = computerScenarioOf(this);
	const action = claimedActionOf(this);
	assert.ok(state.startJob, "The scenario has no queued continuation job.");
	assert.equal(action.turn_id, state.startJob.turnId);
	assert.equal(action.action_id, state.pendingActionId);
});

When("the customer computer host runs one browser_open job through the Front Door", async function (this: ChatticusWorld) {
	const host = await registerHost(this, STORY_TENANT, HOUSEHOLD_HOST_WORKER_ID, "local");
	const ran = await host.runNextAction();
	assert.ok(ran, "The host found no computer action to run.");
	assert.equal((await runQueuedJobs(this)).at(-1), "done");
});

Given("the host worker {string} holds the pending action", async function (this: ChatticusWorld, workerId: string) {
	const scenario = hostScenarioOf(this);
	scenario.claimedAction = await claimFor(this, workerId);
	scenario.firstLease = scenario.claimedAction?.lease_expires_at ?? null;
	assert.ok(scenario.claimedAction, "The host found no action to hold.");
});

type EcsStartScenario = { environment: Record<string, string>; ecs: FakeEcs };

const ecsStarts = new WeakMap<ChatticusWorld, EcsStartScenario>();

const HOST_WORKER_COMMAND = "node /opt/chatticus/host/host-worker.mjs";

function ecsStartOf(world: ChatticusWorld): EcsStartScenario {
	const start = ecsStarts.get(world);
	assert.ok(start, "The scenario has not configured the ECS host command.");
	return start;
}

Given("CHATTICUS_ECS_HOST_COMMAND is the computer host worker module", function (this: ChatticusWorld) {
	ecsStarts.set(this, {
		environment: { CHATTICUS_ECS_HOST_COMMAND: HOST_WORKER_COMMAND, CHATTICUS_ECS_CONTAINER_NAME: "computer" },
		ecs: new FakeEcs(),
	});
});

When("the ECS host starter starts a host for a claim", async function (this: ChatticusWorld) {
	const start = ecsStartOf(this);
	await runFargateTask(start.ecs, {
		cluster: "ChatticusComputers",
		taskDefinition: "computer",
		subnets: ["subnet-1"],
		securityGroups: ["sg-1"],
		claim: { tenantId: "anthus", computerId: "household-computer", hostStartCount: 1, userId: "ryan" },
		environment: start.environment,
	});
});

Then("RunTask overrides that container command", function (this: ChatticusWorld) {
	const [call] = ecsStartOf(this).ecs.calls;
	assert.ok(call, "The starter made no RunTask call.");
	const container = (call as any).overrides.containerOverrides[0];
	assert.equal(container.name, "computer");
	assert.deepEqual(container.command, ["node", "/opt/chatticus/host/host-worker.mjs"]);
});
