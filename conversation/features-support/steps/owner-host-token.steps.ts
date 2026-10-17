import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { wireFrontDoor } from "../front-door.ts";
import type { ChatticusWorld } from "../world.ts";

const INVOKE_HEADER = "X-Chatticus-Invoke-Key";
const TENANT = "anthus";

type HostWorkerScenario = {
	invokeKey: string;
	lastStatus: number;
	workerToken: string | null;
};

const scenarios = new WeakMap<ChatticusWorld, HostWorkerScenario>();

function scenarioOf(world: ChatticusWorld): HostWorkerScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = { invokeKey: "", lastStatus: 0, workerToken: null };
		scenarios.set(world, scenario);
	}
	return scenario;
}

const expand = (path: string): string => path.replaceAll("{tenant}", TENANT);

async function call(world: ChatticusWorld, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<number> {
	assert.ok(world.app, "The scenario has no HTTP front door.");
	const response = await world.app.request(expand(path), {
		method,
		headers: { "content-type": "application/json", ...headers },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	await response.text();
	scenarioOf(world).lastStatus = response.status;
	return response.status;
}

Given("the front door requires the invoke key {string}", async function (this: ChatticusWorld, invokeKey: string) {
	scenarioOf(this).invokeKey = invokeKey;
	await wireFrontDoor(this, { signupMode: "invitation_only", cognitoVerifier: true, serveOverHttp: true, invokeKey });
});

When("a caller sends {string} {string} without any token", async function (this: ChatticusWorld, method: string, path: string) {
	await call(this, method, path, {});
});

async function registerHostWorker(world: ChatticusWorld): Promise<void> {
	const scenario = scenarioOf(world);
	assert.ok(world.app);
	const response = await world.app.request(expand("/orgs/{tenant}/workers/register"), {
		method: "POST",
		headers: {
			"content-type": "application/json",
			[INVOKE_HEADER]: scenario.invokeKey,
			...(scenario.workerToken ? { authorization: `Bearer ${scenario.workerToken}` } : {}),
		},
		body: JSON.stringify({ worker_id: "customer-host", cost_class: "local", capabilities: ["cpu", "computer"] }),
	});
	scenario.lastStatus = response.status;
	scenario.workerToken = ((await response.json()) as { token: string }).token;
}

When("a host worker registers over HTTP with the invoke key", async function (this: ChatticusWorld) {
	await registerHostWorker(this);
});

async function heartbeatAs(world: ChatticusWorld, invokeKey: string | null): Promise<void> {
	const scenario = scenarioOf(world);
	assert.ok(scenario.workerToken, "No host worker has registered.");
	await call(
		world,
		"POST",
		"/orgs/{tenant}/host/heartbeat",
		{ authorization: `Bearer ${scenario.workerToken}`, ...(invokeKey === null ? {} : { [INVOKE_HEADER]: invokeKey }) },
		{},
	);
}

When("the host worker calls the heartbeat route with its worker token and the invoke key", async function (this: ChatticusWorld) {
	await heartbeatAs(this, scenarioOf(this).invokeKey);
});

When("the host worker calls the heartbeat route with its worker token and no invoke key", async function (this: ChatticusWorld) {
	await heartbeatAs(this, null);
});

When("the host worker calls the heartbeat route with its worker token and a wrong invoke key", async function (this: ChatticusWorld) {
	await heartbeatAs(this, "not-the-invoke-key");
});

When("the host worker registers again and presents its previous worker token", async function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	const previous = scenario.workerToken;
	assert.ok(previous, "No host worker has registered.");
	await registerHostWorker(this);
	await heartbeatAs(this, scenario.invokeKey);
	assert.equal(scenario.lastStatus, 200, "The new worker token should work before the old one is tried.");
	scenario.workerToken = previous;
	await heartbeatAs(this, scenario.invokeKey);
});

Then("the front door answers with status {int}", function (this: ChatticusWorld, status: number) {
	assert.equal(scenarioOf(this).lastStatus, status);
});
