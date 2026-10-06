import assert from "node:assert/strict";
import { join } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { runWebHarness } from "../web-harness-runner.ts";
import type { ChatticusWorld } from "../world.ts";

async function runAuthHarness(
	world: ChatticusWorld,
	command: string,
	payload?: Record<string, unknown>,
): Promise<Record<string, any>> {
	assert.ok(world.snapshotTmpdir, "The scenario temporary directory is not available.");
	const args = [command];
	if (payload !== undefined) {
		args.push(JSON.stringify(payload));
	}
	return runWebHarness("auth-behavior-harness.ts", args, {
		CHATTICUS_AUTH_HARNESS_STATE: join(world.snapshotTmpdir, "auth-harness-state.json"),
		CHATTICUS_AUTH_HARNESS_OIDC_STORE: join(world.snapshotTmpdir, "auth-harness-oidc-store.json"),
		CHATTICUS_AUTH_HARNESS_SESSION_STORE: join(world.snapshotTmpdir, "auth-harness-session-store.json"),
	});
}

async function authStep(world: ChatticusWorld, command: string, payload?: Record<string, unknown>): Promise<void> {
	world.webFeature.auth = await runAuthHarness(world, command, payload);
}

function authState(world: ChatticusWorld): Record<string, any> {
	assert.ok(world.webFeature.auth, "The web SPA auth harness has not run in this scenario.");
	return world.webFeature.auth;
}

Given("the web SPA Cognito auth module", async function (this: ChatticusWorld) {
	await authStep(this, "reset");
});

Given("the web SPA has no signed-in session", async function (this: ChatticusWorld) {
	await authStep(this, "seed-no-session");
});

Given("the web SPA IdP session is valid but no persisted OIDC user", async function (this: ChatticusWorld) {
	await authStep(this, "seed-idp-session-only");
});

Given("the web SPA has an expired id_token and a valid refresh token", async function (this: ChatticusWorld) {
	await authStep(this, "seed-expired-with-refresh");
});

Given("the web SPA has an active signed-in session", async function (this: ChatticusWorld) {
	await authStep(this, "seed-session", {});
});

Given(
	"the web SPA has an active signed-in session with id_token {string}",
	async function (this: ChatticusWorld, token: string) {
		await authStep(this, "seed-session", { id_token: token });
	},
);

Given("the person has signed out of the web SPA", async function (this: ChatticusWorld) {
	await runAuthHarness(this, "sign-out");
	await authStep(this, "complete-sign-out");
});

Given("the web SPA is completing a Cognito sign-out redirect", async function (this: ChatticusWorld) {
	await authStep(this, "seed-signout-callback");
});

When("the person signs out from the web SPA", async function (this: ChatticusWorld) {
	await authStep(this, "sign-out");
});

When("the person reloads the workspace", async function (this: ChatticusWorld) {
	await authStep(this, "reload-workspace");
});

When("the person starts Google sign-in from the web SPA", async function (this: ChatticusWorld) {
	await authStep(this, "sign-in");
});

When("the sign-out redirect callback is handled", async function (this: ChatticusWorld) {
	await authStep(this, "complete-sign-out");
});

Then(
	"the web SPA navigates to Cognito hosted UI logout with client_id and logout_uri",
	function (this: ChatticusWorld) {
		const harness = authState(this);
		const url = harness.cognitoLogoutNavigationUrl;
		assert.ok(url, JSON.stringify(harness));
		assert.ok(url.includes("client_id=test-client-id"), JSON.stringify(harness));
		assert.ok(
			url.includes("logout_uri=") && url.includes("dev.chattic.us%2Fauth%2Fsignout-callback"),
			JSON.stringify(harness),
		);
	},
);

Then("the Cognito logout URL does not include identity_provider", function (this: ChatticusWorld) {
	const url: string = authState(this).cognitoLogoutNavigationUrl ?? "";
	assert.ok(!url.includes("identity_provider"), JSON.stringify(authState(this)));
});

Then("the web SPA does not have a signed-in session", function (this: ChatticusWorld) {
	assert.notEqual(authState(this).sessionPresent, true, JSON.stringify(authState(this)));
});

Then("the web SPA did not attempt silent sign-in", function (this: ChatticusWorld) {
	assert.notEqual(authState(this).signinSilentCalled, true, JSON.stringify(authState(this)));
});

Then(
	"the web SPA begins Cognito sign-out redirect with id_token_hint {string}",
	function (this: ChatticusWorld, token: string) {
		const harness = authState(this);
		assert.equal(harness.signoutRedirectCalled, true, JSON.stringify(harness));
		assert.equal((harness.signoutRedirectArgs ?? {}).id_token_hint, token, JSON.stringify(harness));
	},
);

Then("the Cognito sign-out redirect includes client_id and logout_uri", function (this: ChatticusWorld) {
	const harness = authState(this);
	const extra = (harness.signoutRedirectArgs ?? {}).extraQueryParams ?? {};
	assert.equal(extra.client_id, "test-client-id", JSON.stringify(harness));
	assert.equal(extra.logout_uri, "https://dev.chattic.us/auth/signout-callback", JSON.stringify(harness));
});

Then("the Cognito sign-out redirect does not include identity_provider", function (this: ChatticusWorld) {
	const harness = authState(this);
	const extra = (harness.signoutRedirectArgs ?? {}).extraQueryParams ?? {};
	assert.ok(!("identity_provider" in extra), JSON.stringify(harness));
});

Then("the web SPA does not clear the session with removeUser only", function (this: ChatticusWorld) {
	const harness = authState(this);
	assert.ok(harness.cognitoLogoutNavigationUrl, JSON.stringify(harness));
	assert.notEqual(harness.removeUserBeforeRedirect, true, JSON.stringify(harness));
});

Then("the web SPA still has that signed-in session", function (this: ChatticusWorld) {
	assert.equal(authState(this).sessionPresent, true, JSON.stringify(authState(this)));
});

Then("the person is not sent through Google sign-in", function (this: ChatticusWorld) {
	assert.notEqual(authState(this).signinRedirectCalled, true, JSON.stringify(authState(this)));
});

Then(
	"the Google authorization request does not include prompt {string}",
	function (this: ChatticusWorld, prompt: string) {
		const harness = authState(this);
		assert.equal(harness.signinRedirectCalled, true, JSON.stringify(harness));
		assert.notEqual((harness.signinExtraQueryParams ?? {}).prompt, prompt, JSON.stringify(harness));
	},
);

Then(
	"the Google authorization request includes identity_provider {string}",
	function (this: ChatticusWorld, provider: string) {
		const harness = authState(this);
		assert.equal(harness.signinRedirectCalled, true, JSON.stringify(harness));
		assert.equal((harness.signinExtraQueryParams ?? {}).identity_provider, provider, JSON.stringify(harness));
	},
);

Then("the web SPA attempted silent sign-in", function (this: ChatticusWorld) {
	assert.equal(authState(this).signinSilentCalled, true, JSON.stringify(authState(this)));
});

Then("the Google authorization request includes prompt {string}", function (this: ChatticusWorld, prompt: string) {
	const harness = authState(this);
	assert.equal(harness.signinRedirectCalled, true, JSON.stringify(harness));
	assert.equal((harness.signinExtraQueryParams ?? {}).prompt, prompt, JSON.stringify(harness));
});

Then("the web SPA persisted session is cleared", function (this: ChatticusWorld) {
	assert.equal(authState(this).sessionCleared, true, JSON.stringify(authState(this)));
});
