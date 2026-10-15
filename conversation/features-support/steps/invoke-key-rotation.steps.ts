import assert from "node:assert/strict";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { Given, Then, When } from "@cucumber/cucumber";
import { secretsManagerInvokeKeySource, type InvokeKeySecretReader } from "../../src/auth/invoke-key-source.ts";
import { wireFrontDoor } from "../front-door.ts";
import type { ChatticusWorld } from "../world.ts";

const INVOKE_HEADER = "X-Chatticus-Invoke-Key";
const SECRET_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:invoke-key-scenario";
const REFUSAL_DETAIL = "invoke key required";

class ScenarioInvokeSecret {
	current: string;
	previous: string | null = null;
	unreadable = false;

	constructor(current: string) {
		this.current = current;
	}

	reader(): InvokeKeySecretReader {
		const send = async (command: unknown) => {
			assert.ok(command instanceof GetSecretValueCommand);
			if (this.unreadable) throw new Error("secrets manager is unreachable");
			const stage = command.input.VersionStage;
			if (stage === "AWSCURRENT") return { SecretString: this.current };
			if (stage === "AWSPREVIOUS" && this.previous !== null) return { SecretString: this.previous };
			const missing = new Error("no such stage");
			missing.name = "ResourceNotFoundException";
			throw missing;
		};
		return { send } as unknown as InvokeKeySecretReader;
	}
}

const secrets = new WeakMap<object, ScenarioInvokeSecret>();

function secretOf(world: ChatticusWorld): ScenarioInvokeSecret {
	const secret = secrets.get(world);
	assert.ok(secret, "The scenario has no invoke key secret.");
	return secret;
}

async function protectedRequest(world: ChatticusWorld, headers: Record<string, string>): Promise<{ status: number; text: string }> {
	assert.ok(world.api, "The scenario has no HTTP front door.");
	const response = await world.api.get("/me", { headers });
	return { status: response.status, text: await response.text() };
}

Given("a front door that reads the invoke key from its secret, which holds {string}", async function (this: ChatticusWorld, key: string) {
	const secret = new ScenarioInvokeSecret(key);
	secrets.set(this, secret);
	const invokeKeys = await secretsManagerInvokeKeySource(secret.reader(), SECRET_ARN, this.clock);
	await wireFrontDoor(this, { signupMode: "invitation_only", cognitoVerifier: true, invokeKeys });
});

When("the secret is rotated to {string} and the previous value is retired", function (this: ChatticusWorld, key: string) {
	const secret = secretOf(this);
	secret.current = key;
	secret.previous = null;
});

When("the secret is rotated to {string} and the previous value is kept", function (this: ChatticusWorld, key: string) {
	const secret = secretOf(this);
	secret.previous = secret.current;
	secret.current = key;
});

When("the previous value is retired", function (this: ChatticusWorld) {
	secretOf(this).previous = null;
});

When("{int} seconds pass on the front door clock", function (this: ChatticusWorld, seconds: number) {
	this.clock.advanceSeconds(seconds);
});

When("the secret cannot be read and {int} seconds pass on the front door clock", function (this: ChatticusWorld, seconds: number) {
	secretOf(this).unreadable = true;
	this.clock.advanceSeconds(seconds);
});

Then("a request with the invoke key {string} is let through", async function (this: ChatticusWorld, key: string) {
	const { text } = await protectedRequest(this, { [INVOKE_HEADER]: key });
	assert.ok(!text.includes(REFUSAL_DETAIL), `The invoke key was refused: ${text}`);
});

Then("a request with the invoke key {string} is refused", async function (this: ChatticusWorld, key: string) {
	const { status, text } = await protectedRequest(this, { [INVOKE_HEADER]: key });
	assert.equal(status, 403);
	assert.ok(text.includes(REFUSAL_DETAIL), `The request was refused for another reason: ${text}`);
});

Then("a request with no invoke key is refused", async function (this: ChatticusWorld) {
	const { status, text } = await protectedRequest(this, {});
	assert.equal(status, 403);
	assert.ok(text.includes(REFUSAL_DETAIL), text);
});

Then("the health route answers without an invoke key", async function (this: ChatticusWorld) {
	assert.ok(this.api, "The scenario has no HTTP front door.");
	const response = await this.api.get("/health");
	assert.equal(response.status, 200);
});
