import assert from "node:assert/strict";
import { Given, When, Then } from "@cucumber/cucumber";
import { OrganizationsKernelImpl } from "../../src/domain/organizations.ts";
import { createApp } from "../../src/http/app.ts";
import { ApiClient } from "../api.ts";
import { createIdTokenVerifier } from "../../src/auth/cognito.ts";
import { CognitoTestKeys, TEST_USER_POOL_ID, TEST_CLIENT_ID } from "../test-jwt.ts";
import type { ChatticusWorld } from "../world.ts";

const orgsKernel = new OrganizationsKernelImpl();

Given("a Cognito-verified HTTP front door", async function (this: ChatticusWorld) {
	if (!this.cognitoTestKeys) {
		this.cognitoTestKeys = await CognitoTestKeys.generate();
	}
	const verifier = createIdTokenVerifier(
		{
			userPoolId: TEST_USER_POOL_ID,
			clientId: TEST_CLIENT_ID,
		},
		this.cognitoTestKeys.jwks,
	);
	const app = createApp({
		clock: this.clock,
		ids: this.ids,
		store: this.inMemoryStore || this.createInMemoryStore(),
		invokeKey: null,
		environment: "test",
		verifier,
		signupMode: "invitation_only",
	});
	this.api = new ApiClient(app);
});

Given("an HTTP front door without a Cognito verifier", async function (this: ChatticusWorld) {
	const app = createApp({
		clock: this.clock,
		ids: this.ids,
		store: this.inMemoryStore || this.createInMemoryStore(),
		invokeKey: null,
		environment: "test",
		verifier: null,
		signupMode: "invitation_only",
	});
	this.api = new ApiClient(app);
});

Given("a Cognito-verified HTTP front door with open signup", async function (this: ChatticusWorld) {
	if (!this.cognitoTestKeys) {
		this.cognitoTestKeys = await CognitoTestKeys.generate();
	}
	const verifier = createIdTokenVerifier(
		{
			userPoolId: TEST_USER_POOL_ID,
			clientId: TEST_CLIENT_ID,
		},
		this.cognitoTestKeys.jwks,
	);
	const app = createApp({
		clock: this.clock,
		ids: this.ids,
		store: this.inMemoryStore || this.createInMemoryStore(),
		invokeKey: null,
		environment: "test",
		verifier,
		signupMode: "open",
	});
	this.api = new ApiClient(app);
});

Given("a Cognito-verified HTTP front door with invitation-only signup", async function (this: ChatticusWorld) {
	if (!this.cognitoTestKeys) {
		this.cognitoTestKeys = await CognitoTestKeys.generate();
	}
	const verifier = createIdTokenVerifier(
		{
			userPoolId: TEST_USER_POOL_ID,
			clientId: TEST_CLIENT_ID,
		},
		this.cognitoTestKeys.jwks,
	);
	const app = createApp({
		clock: this.clock,
		ids: this.ids,
		store: this.inMemoryStore || this.createInMemoryStore(),
		invokeKey: null,
		environment: "test",
		verifier,
		signupMode: "invitation_only",
	});
	this.api = new ApiClient(app);
});

Given("the me front door has tenant {string} enabled for {string}", async function (this: ChatticusWorld, tenantId: string, email: string) {
	const identity = await orgsKernel.signIn(email, {
		store: this.inMemoryStore || this.createInMemoryStore(),
		clock: this.clock,
		ids: this.ids,
	});
	const org = {
		tenantId,
		name: "Test Org",
		status: "enabled" as const,
		ownerUserId: identity.userId,
		createdAt: this.clock.now(),
		awsAccountId: null,
		awsCrossAccountRole: null,
		awsExternalId: null,
		awsSetupPath: null,
		monthlyAwsSpendCeilingUsd: null,
	};
	await this.inMemoryStore?.putOrganization(org);
	const membership = {
		tenantId,
		userId: identity.userId,
		role: "owner" as const,
		joinedAt: this.clock.now(),
	};
	await this.inMemoryStore?.putMembership(membership);
	if (!this.identitiesByEmail) this.identitiesByEmail = new Map();
	this.identitiesByEmail.set(email, identity);
});

Given("{string} has signed in on the me front door", async function (this: ChatticusWorld, email: string) {
	const identity = await orgsKernel.signIn(email, {
		store: this.inMemoryStore || this.createInMemoryStore(),
		clock: this.clock,
		ids: this.ids,
	});
	this.currentIdentity = identity;
	if (!this.identitiesByEmail) this.identitiesByEmail = new Map();
	this.identitiesByEmail.set(email, identity);
});

When("GET \\/me is called without Authorization", async function (this: ChatticusWorld) {
	assert.ok(this.api);
	try {
		this.lastHttpResponse = await this.api.get("/api/me");
	} catch (error) {
		this.lastHttpResponse = error as Response;
	}
});

When("GET \/me is called with bearer token {string}", async function (this: ChatticusWorld, token: string) {
	assert.ok(this.api);
	try {
		this.lastHttpResponse = await this.api.get("/api/me", {
			headers: { Authorization: `Bearer ${token}` },
		});
	} catch (error) {
		this.lastHttpResponse = error as Response;
	}
});

When("GET \/me is called with an expired id token for {string}", async function (this: ChatticusWorld, email: string) {
	assert.ok(this.cognitoTestKeys);
	assert.ok(this.api);
	const expiredToken = await this.cognitoTestKeys.mintIdToken({
		email,
		expiresAtSeconds: Math.floor(Date.UTC(2020, 0, 1) / 1000),
	});
	try {
		this.lastHttpResponse = await this.api.get("/api/me", {
			headers: { Authorization: `Bearer ${expiredToken}` },
		});
	} catch (error) {
		this.lastHttpResponse = error as Response;
	}
});

When("GET \/me is called with a valid id token for {string}", async function (this: ChatticusWorld, email: string) {
	assert.ok(this.cognitoTestKeys);
	assert.ok(this.api);
	const token = await this.cognitoTestKeys.mintIdToken({ email });
	try {
		this.lastHttpResponse = await this.api.get("/api/me", {
			headers: { Authorization: `Bearer ${token}` },
		});
	} catch (error) {
		this.lastHttpResponse = error as Response;
	}
});

Then("GET \/me responds with status {int}", async function (this: ChatticusWorld, status: number) {
	assert.ok(this.lastHttpResponse);
	assert.equal(this.lastHttpResponse.status, status);
});

Then("GET \/me email is {string}", async function (this: ChatticusWorld, email: string) {
	assert.ok(this.lastHttpResponse);
	const body = await this.lastHttpResponse.json();
	assert.equal(body.email, email);
});

Then("GET \/me user id is present", async function (this: ChatticusWorld) {
	assert.ok(this.lastHttpResponse);
	const body = await this.lastHttpResponse.json();
	assert.ok(body.userId);
});

Then("GET \/me organizations are empty", async function (this: ChatticusWorld) {
	assert.ok(this.lastHttpResponse);
	const body = await this.lastHttpResponse.json();
	assert.ok(Array.isArray(body.organizations));
	assert.equal(body.organizations.length, 0);
});

Then("GET \/me organizations include:", async function (this: ChatticusWorld, dataTable: any) {
	assert.ok(this.lastHttpResponse);
	const body = await this.lastHttpResponse.json();
	const rows = dataTable.hashes();
	for (const row of rows) {
		const matching = body.organizations.filter((org: any) => org.name === row.name && org.status === row.status);
		assert.ok(matching.length > 0, `No organization found matching ${JSON.stringify(row)}`);
	}
});

When("POST \/organizations is called with a valid id token for {string} and name {string}", async function (
	this: ChatticusWorld,
	email: string,
	name: string,
) {
	assert.ok(this.cognitoTestKeys);
	assert.ok(this.api);
	const token = await this.cognitoTestKeys.mintIdToken({ email });
	try {
		this.lastHttpResponse = await this.api.post("/api/organizations", {
			headers: { Authorization: `Bearer ${token}` },
			body: { name },
		});
	} catch (error) {
		this.lastHttpResponse = error as Response;
	}
});

When("POST \/organizations is called with a valid id token for {string} and an overlong organization name", async function (
	this: ChatticusWorld,
	email: string,
) {
	assert.ok(this.cognitoTestKeys);
	assert.ok(this.api);
	const token = await this.cognitoTestKeys.mintIdToken({ email });
	const longName = "a".repeat(200);
	try {
		this.lastHttpResponse = await this.api.post("/api/organizations", {
			headers: { Authorization: `Bearer ${token}` },
			body: { name: longName },
		});
	} catch (error) {
		this.lastHttpResponse = error as Response;
	}
});

Then("POST \/organizations responds with status {int}", async function (this: ChatticusWorld, status: number) {
	assert.ok(this.lastHttpResponse);
	assert.equal(this.lastHttpResponse.status, status);
});

Then("POST \/organizations body includes tenant_id and status {string}", async function (this: ChatticusWorld, status: string) {
	assert.ok(this.lastHttpResponse);
	const body = await this.lastHttpResponse.json();
	assert.ok(body.tenantId);
	assert.equal(body.status, status);
	if (!this.orgsByName) this.orgsByName = new Map();
	this.orgsByName.set(body.name, {
		tenantId: body.tenantId,
		name: body.name,
		status: status as "pending" | "enabled" | "suspended",
		ownerUserId: "",
		createdAt: new Date(),
		awsAccountId: null,
		awsCrossAccountRole: null,
		awsExternalId: null,
		awsSetupPath: null,
		monthlyAwsSpendCeilingUsd: null,
	});
});
