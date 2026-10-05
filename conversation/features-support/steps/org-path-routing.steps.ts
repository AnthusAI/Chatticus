import assert from "node:assert/strict";
import { Given, Then, When, defineParameterType } from "@cucumber/cucumber";
import { wireFrontDoor } from "../front-door.ts";
import type { ChatticusWorld } from "../world.ts";

const WAITLIST_SAFE_ROUTE_PATHS = ["/me"];
const NO_PRINCIPAL_ROUTES = ["/auth/callback"];

defineParameterType({
	name: "path",
	regexp: /"([^"]+)"/,
	transformer: (s: string) => s,
});

When(
	"the front door receives GET \\/orgs\\/{word}\\/users\\/{word}\\/bots with header X-Tenant-Id {word}",
	async function (this: ChatticusWorld, tenantId: string, userId: string, headerTenant: string) {
		assert.ok(this.api, "No API client");
		this.lastHttpResponse = await this.api.get(`/orgs/${tenantId}/users/${userId}/bots`, {
			headers: { "X-Tenant-Id": headerTenant },
		});
	},
);

Then("the front door rejects X-Tenant-Id", async function (this: ChatticusWorld) {
	const response = this.lastHttpResponse;
	assert.ok(response, "No last HTTP response");
	assert.equal(response.status, 400);
	const data = await response.json();
	assert.ok(data.detail?.includes("X-Tenant-Id"), `Expected X-Tenant-Id in detail: ${data.detail}`);
});

Given(
	"a front door serving named environment {string} with HTTP",
	async function (this: ChatticusWorld, environment: string) {
		this.environment = environment;
		await wireFrontDoor(this, { signupMode: "invitation_only", cognitoVerifier: true, environment });
	},
);

Then("GET \\/health reports environment {string}", async function (this: ChatticusWorld, expectedEnvironment: string) {
	assert.ok(this.api, "No API client");
	const response = await this.api.get("/health");
	assert.equal(response.status, 200);
	const data = await response.json();
	assert.equal(data.status, "ok");
	assert.equal(data.environment, expectedEnvironment);
});

Then("{path} is outside the principal marker system", function (this: ChatticusWorld, path: string) {
	assert.ok(NO_PRINCIPAL_ROUTES.includes(path), `Path ${path} is not outside the principal system`);
});

Then("{path} is a named waitlist-safe route", function (this: ChatticusWorld, path: string) {
	assert.ok(WAITLIST_SAFE_ROUTE_PATHS.includes(path), `Path ${path} is not a waitlist-safe route`);
});
