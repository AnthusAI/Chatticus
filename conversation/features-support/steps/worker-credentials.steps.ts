import assert from "node:assert/strict";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import { recordResponse, type RecordedResponse } from "../api.ts";
import { wireFrontDoor } from "../front-door.ts";
import { organizationMemberHeaders } from "../org-user-client.ts";
import type { ChatticusWorld } from "../world.ts";
import { resetScenarioToEmptyControlPlane } from "./bot.steps.ts";
import { registerWorkerOverHttp } from "./worker-registration.ts";

const INVOKE_HEADER = "X-Chatticus-Invoke-Key";

function heartbeatPath(tenantId: string): string {
	return `/orgs/${tenantId}/host/heartbeat`;
}

function lastRegistered(world: ChatticusWorld): { tenantId: string; workerId: string; token: string } {
	assert.ok(world.lastRegisteredWorker, "No worker has registered in this scenario.");
	return world.lastRegisteredWorker;
}

function channelTenantOf(world: ChatticusWorld): string {
	assert.ok(world.lastChannel, "No channel has been opened");
	return world.lastChannel.tenantId;
}

async function registerFromTable(world: ChatticusWorld, table: DataTable): Promise<void> {
	const values: Record<string, string> = {};
	for (const row of table.raw()) {
		values[(row[0] ?? "").trim()] = (row[1] ?? "").trim();
	}
	world.previousWorkerToken = world.lastRegisteredWorker?.token ?? null;
	await registerWorkerOverHttp(world, {
		tenantId: values.tenant_id!,
		workerId: values.worker_id!,
		costClass: values.cost_class!,
		capabilities: (values.capabilities ?? "")
			.split(",")
			.map((item) => item.trim())
			.filter((item) => item !== ""),
	});
}

async function callWorkerRoute(
	world: ChatticusWorld,
	tenantId: string,
	headers: Record<string, string>,
): Promise<RecordedResponse> {
	assert.ok(world.api, "The scenario has no HTTP front door.");
	return recordResponse(await world.api.post(heartbeatPath(tenantId), { headers }));
}

Given("an empty control plane with invoke key {string}", async function (this: ChatticusWorld, invokeKey: string) {
	await resetScenarioToEmptyControlPlane(this);
	await wireFrontDoor(this, { signupMode: "invitation_only", cognitoVerifier: true, invokeKey });
	assert.ok(this.api);
	this.api.defaultHeaders[INVOKE_HEADER] = invokeKey;
});

When("a worker registers over HTTP:", async function (this: ChatticusWorld, table: DataTable) {
	await registerFromTable(this, table);
});

Then("the registration response includes a worker token", function (this: ChatticusWorld) {
	assert.ok(lastRegistered(this).token.length >= 32);
});

Then("the registration response includes a new worker token", function (this: ChatticusWorld) {
	assert.ok(lastRegistered(this).token);
	assert.notEqual(lastRegistered(this).token, this.previousWorkerToken);
});

Then("the previous worker token is rejected on worker routes", async function (this: ChatticusWorld) {
	assert.ok(this.previousWorkerToken, "There is no previous worker token.");
	const response = await callWorkerRoute(this, lastRegistered(this).tenantId, {
		Authorization: `Bearer ${this.previousWorkerToken}`,
	});
	assert.equal(response.status, 403, response.text);
});

When("a worker route is called without a bearer credential", async function (this: ChatticusWorld) {
	this.workerRouteResponse = await callWorkerRoute(this, channelTenantOf(this), {});
});

When("a worker route is called with only the invoke key", async function (this: ChatticusWorld) {
	const invokeKey = this.api?.defaultHeaders[INVOKE_HEADER];
	assert.ok(invokeKey, "The front door has no invoke key.");
	this.workerRouteResponse = await callWorkerRoute(this, channelTenantOf(this), { [INVOKE_HEADER]: invokeKey });
});

When("a user principal calls a worker route", async function (this: ChatticusWorld) {
	const tenantId = channelTenantOf(this);
	this.workerRouteResponse = await callWorkerRoute(
		this,
		tenantId,
		await organizationMemberHeaders(this, heartbeatPath(tenantId)),
	);
});

When("the worker bearer credential is used on a worker route", async function (this: ChatticusWorld) {
	const worker = lastRegistered(this);
	this.workerRouteResponse = await callWorkerRoute(this, worker.tenantId, { Authorization: `Bearer ${worker.token}` });
});

Then("the worker route responds with status {int}", function (this: ChatticusWorld, status: number) {
	assert.ok(this.workerRouteResponse, "No worker route has been called.");
	assert.equal(this.workerRouteResponse.status, status, this.workerRouteResponse.text);
});

When("the worker bearer credential is used on a browser route", async function (this: ChatticusWorld) {
	assert.ok(this.api, "The scenario has no HTTP front door.");
	const worker = lastRegistered(this);
	const response = await recordResponse(
		await this.api.post(`/orgs/${worker.tenantId}/channels`, {
			headers: { Authorization: `Bearer ${worker.token}` },
			body: { user_id: "ryan", bot_ids: ["not-authorized"], kind: "direct", name: null },
		}),
	);
	this.browserRouteStatus = response.status;
});
