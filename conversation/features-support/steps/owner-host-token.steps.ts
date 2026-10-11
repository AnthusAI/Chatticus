import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { HOST_USER_HEADER } from "@chatticus/host-protocol";
import { computerForOrganization, requestComputerHostStart } from "../../src/domain/computers.ts";
import { registerWorker } from "../../src/domain/workers.ts";
import { mintSessionToken, type SessionTokenClaims } from "../../src/gateway/session-token.ts";
import { SCENARIO_GATEWAY_SIGNING_KEY } from "../model-gateway-support.ts";
import { wireFrontDoor } from "../front-door.ts";
import type { ChatticusWorld } from "../world.ts";
import { turnOf } from "./model-gateway.steps.ts";

const INVOKE_HEADER = "X-Chatticus-Invoke-Key";
const OWNER_HOST_USER = "ryan";

type HostTokenScenario = {
	invokeKey: string;
	generation: number;
	token: string;
	statuses: number[];
	lastStatus: number;
	workerToken: string | null;
};

const scenarios = new WeakMap<ChatticusWorld, HostTokenScenario>();

function scenarioOf(world: ChatticusWorld): HostTokenScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = { invokeKey: "", generation: 0, token: "", statuses: [], lastStatus: 0, workerToken: null };
		scenarios.set(world, scenario);
	}
	return scenario;
}

const nowSeconds = (world: ChatticusWorld): number => Math.floor(world.clock.now().getTime() / 1000);

function hostTokenFor(world: ChatticusWorld, overrides: Partial<SessionTokenClaims>, secondsValid: number, key = SCENARIO_GATEWAY_SIGNING_KEY): string {
	return mintSessionToken(key, {
		audience: "owner-host",
		startGeneration: scenarioOf(world).generation,
		...turnOf(world),
		...overrides,
		expiresAtSeconds: nowSeconds(world) + secondsValid,
	});
}

function expand(world: ChatticusWorld, path: string): string {
	return path.replaceAll("{tenant}", turnOf(world).tenantId).replaceAll("{owner}", turnOf(world).ownerId);
}

async function call(
	world: ChatticusWorld,
	method: string,
	path: string,
	headers: Record<string, string>,
	body?: unknown,
): Promise<number> {
	assert.ok(world.app, "The scenario has no HTTP front door.");
	const response = await world.app.request(expand(world, path), {
		method,
		headers: { "content-type": "application/json", ...headers },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	await response.text();
	scenarioOf(world).lastStatus = response.status;
	return response.status;
}

const ownerHeaders = (world: ChatticusWorld): Record<string, string> => ({
	authorization: `Bearer ${scenarioOf(world).token}`,
	[HOST_USER_HEADER]: OWNER_HOST_USER,
});

function hostStartDependencies(world: ChatticusWorld) {
	const store = world.messagingStore();
	return {
		store,
		clock: world.clock,
		ids: world.ids,
		heartbeatTimeoutSeconds: world.heartbeatTimeoutSeconds,
		spend: { store, rollups: world.store, environment: world.budgetEnvironment, clock: world.clock },
	};
}

Given("the front door requires the invoke key {string}", async function (this: ChatticusWorld, invokeKey: string) {
	scenarioOf(this).invokeKey = invokeKey;
	await wireFrontDoor(this, { signupMode: "invitation_only", cognitoVerifier: true, serveOverHttp: true, invokeKey });
});

Given("the starter claimed host start generation {int} and registered the container owner as a worker", async function (this: ChatticusWorld, generation: number) {
	const turn = turnOf(this);
	const claim = await requestComputerHostStart(hostStartDependencies(this), turn.tenantId, OWNER_HOST_USER);
	assert.equal(claim.hostStartGeneration, generation);
	scenarioOf(this).generation = generation;
	await registerWorker(
		{ workerId: turn.ownerId, tenantId: turn.tenantId, costClass: "local", capabilities: ["cpu", "computer"], computerId: claim.computerId },
		{ store: this.messagingStore(), clock: this.clock, ids: this.ids },
	);
});

Given("the container holds a host token for its turn valid for {int} seconds", function (this: ChatticusWorld, seconds: number) {
	scenarioOf(this).token = hostTokenFor(this, {}, seconds);
});

Given("the container holds a host token that is {string}", function (this: ChatticusWorld, variant: string) {
	const scenario = scenarioOf(this);
	const variants: Record<string, () => string> = {
		"for another organization": () => hostTokenFor(this, { tenantId: "another-organization" }, 300),
		"for a turn that does not exist": () => hostTokenFor(this, { turnId: "turn-that-does-not-exist" }, 300),
		"bound to another owner of the turn": () => hostTokenFor(this, { ownerId: "owner-of-someone-else" }, 300),
		"already expired": () => hostTokenFor(this, {}, -1),
		"signed with another key": () => hostTokenFor(this, {}, 300, "a-different-signing-key-0123456789abcdef"),
		"minted for the model gateway": () => hostTokenFor(this, { audience: "model-gateway" }, 300),
	};
	const mint = variants[variant];
	assert.ok(mint, `Unknown token variant ${variant}`);
	scenario.token = mint();
});

Given("the host start lease expires and the starter claims host start generation {int}", async function (this: ChatticusWorld, generation: number) {
	this.clock.advanceSeconds(61);
	const claim = await requestComputerHostStart(hostStartDependencies(this), turnOf(this).tenantId, OWNER_HOST_USER);
	assert.equal(claim.hostStartGeneration, generation);
});

When("the container calls {string} {string} with its token", async function (this: ChatticusWorld, method: string, path: string) {
	await call(this, method, path, ownerHeaders(this), method === "POST" ? {} : undefined);
});

When("the container calls {string} {string} without any token", async function (this: ChatticusWorld, method: string, path: string) {
	await call(this, method, path, {});
});

When("the container registers the worker {string} with its token", async function (this: ChatticusWorld, workerId: string) {
	await call(this, "POST", "/orgs/{tenant}/workers/register", ownerHeaders(this), { worker_id: workerId, cost_class: "local", capabilities: ["cpu"] });
});

When("the container reports through every route it uses with its token", async function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	const ownerId = turnOf(this).ownerId;
	scenario.statuses = [];
	const headers = ownerHeaders(this);
	scenario.statuses.push(await call(this, "GET", "/orgs/{tenant}/host/computer", headers));
	scenario.statuses.push(await call(this, "POST", "/orgs/{tenant}/host/computer/state", headers, { stopped: false }));
	scenario.statuses.push(await call(this, "POST", "/orgs/{tenant}/host/computer/state", headers, { capability_ready: "model" }));
	scenario.statuses.push(await call(this, "POST", "/orgs/{tenant}/host/snapshot/published", headers, { worker_id: ownerId, checksum: "checksum-1" }));
	scenario.statuses.push(await call(this, "POST", "/orgs/{tenant}/host/snapshot/hydrated", headers, { worker_id: ownerId }));
	scenario.statuses.push(await call(this, "POST", "/orgs/{tenant}/host/heartbeat", headers, {}));
	scenario.statuses.push(await call(this, "POST", "/orgs/{tenant}/host/computer/state", headers, { stopped: true, start_generation: scenario.generation }));
});

When("the container reports the computer stopped for generation {int}", async function (this: ChatticusWorld, generation: number) {
	await call(this, "POST", "/orgs/{tenant}/host/computer/state", ownerHeaders(this), { stopped: true, start_generation: generation });
});

When("the container reports the computer stopped without naming a generation", async function (this: ChatticusWorld) {
	await call(this, "POST", "/orgs/{tenant}/host/computer/state", ownerHeaders(this), { stopped: true });
});

When("a host worker registers over HTTP with the invoke key", async function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	assert.ok(this.app);
	const response = await this.app.request(expand(this, "/orgs/{tenant}/workers/register"), {
		method: "POST",
		headers: { "content-type": "application/json", [INVOKE_HEADER]: scenario.invokeKey },
		body: JSON.stringify({ worker_id: "customer-host", cost_class: "local", capabilities: ["cpu", "computer"] }),
	});
	scenario.lastStatus = response.status;
	scenario.workerToken = ((await response.json()) as { token: string }).token;
});

async function heartbeatAs(world: ChatticusWorld, invokeKey: string | null): Promise<void> {
	const scenario = scenarioOf(world);
	assert.ok(scenario.workerToken, "No host worker has registered.");
	await call(world, "POST", "/orgs/{tenant}/host/heartbeat", {
		authorization: `Bearer ${scenario.workerToken}`,
		...(invokeKey === null ? {} : { [INVOKE_HEADER]: invokeKey }),
	}, {});
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
	const response = await this.app!.request(expand(this, "/orgs/{tenant}/workers/register"), {
		method: "POST",
		headers: { "content-type": "application/json", [INVOKE_HEADER]: scenario.invokeKey },
		body: JSON.stringify({ worker_id: "customer-host", cost_class: "local", capabilities: ["cpu", "computer"] }),
	});
	scenario.workerToken = ((await response.json()) as { token: string }).token;
	await heartbeatAs(this, scenario.invokeKey);
	assert.equal(scenario.lastStatus, 200, "The new worker token should work before the old one is tried.");
	scenario.workerToken = previous;
	await heartbeatAs(this, scenario.invokeKey);
});

Then("the front door answers with status {int}", function (this: ChatticusWorld, status: number) {
	assert.equal(scenarioOf(this).lastStatus, status);
});

Then("every one of those routes answered with status {int}", function (this: ChatticusWorld, status: number) {
	assert.deepEqual(scenarioOf(this).statuses, [status, status, status, status, status, status, status]);
});

Then("the organization has no worker {string}", async function (this: ChatticusWorld, workerId: string) {
	assert.equal(await this.messagingStore().getWorker(turnOf(this).tenantId, workerId), null);
});

Then("the organization computer still holds the host start lease of generation {int}", async function (this: ChatticusWorld, generation: number) {
	const computer = await computerForOrganization(turnOf(this).tenantId, { store: this.messagingStore() });
	assert.equal(computer.hostStartGeneration, generation);
	assert.ok(computer.hostStartLeaseExpiresAt !== undefined && computer.hostStartLeaseExpiresAt.getTime() > this.clock.now().getTime());
});

Then("the organization computer has released the host start lease of generation {int}", async function (this: ChatticusWorld, generation: number) {
	const computer = await computerForOrganization(turnOf(this).tenantId, { store: this.messagingStore() });
	assert.equal(computer.hostStartGeneration, generation);
	assert.equal(computer.hostStartLeaseExpiresAt, undefined);
});
