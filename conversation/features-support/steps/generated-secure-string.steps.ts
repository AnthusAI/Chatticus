import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { PutParameterCommand } from "@aws-sdk/client-ssm";
import {
	createGeneratedSecureStringHandler,
	type GeneratedSecureStringEvent,
	type GeneratedSecureStringResult,
} from "../../src/lambdas/generated-secure-string.ts";
import type { ChatticusWorld } from "../world.ts";

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

async function withCapturedConsole(lines: string[], action: () => Promise<void>): Promise<void> {
	const originals = CONSOLE_METHODS.map((method) => console[method]);
	for (const method of CONSOLE_METHODS) {
		console[method] = (...parts: unknown[]) => {
			lines.push(parts.map((part) => (part instanceof Error ? `${part.message}\n${part.stack}` : String(part))).join(" "));
		};
	}
	try {
		await action();
	} finally {
		CONSOLE_METHODS.forEach((method, index) => {
			console[method] = originals[index] as never;
		});
	}
}

type StoredParameter = { value: string; type: string; tier: string };

type GeneratedKeyScenario = {
	parameters: Map<string, StoredParameter>;
	handedWrites: Array<{ name: string; overwrite: boolean | undefined }>;
	calls: number;
	writeFailure: string | null;
	handByHand: Map<string, string>;
	answers: GeneratedSecureStringResult[];
	failures: Error[];
	printed: string[];
	createdKeys: string[];
};

const scenarios = new WeakMap<ChatticusWorld, GeneratedKeyScenario>();

function scenarioOf(world: ChatticusWorld): GeneratedKeyScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = { parameters: new Map(), handedWrites: [], calls: 0, writeFailure: null, handByHand: new Map(), answers: [], failures: [], printed: [], createdKeys: [] };
		scenarios.set(world, scenario);
	}
	return scenario;
}

const PLACED_BY_HAND_VALUE = "value-placed-by-hand-before-the-deploy-0123456789";

function fakeSsm(scenario: GeneratedKeyScenario) {
	return {
		send: async (command: PutParameterCommand) => {
			scenario.calls += 1;
			if (scenario.writeFailure !== null) {
				const failure = new Error("raw SSM message that must not travel");
				failure.name = scenario.writeFailure;
				throw failure;
			}
			const input = command.input;
			scenario.handedWrites.push({ name: input.Name ?? "", overwrite: input.Overwrite });
			if (scenario.parameters.has(input.Name ?? "") && input.Overwrite !== true) {
				const failure = new Error("The parameter already exists.");
				failure.name = "ParameterAlreadyExists";
				throw failure;
			}
			scenario.parameters.set(input.Name ?? "", { value: input.Value ?? "", type: input.Type ?? "", tier: input.Tier ?? "" });
			return { Version: 1 };
		},
	} as never;
}

function eventOf(requestType: GeneratedSecureStringEvent["RequestType"], name: string, length: number): GeneratedSecureStringEvent {
	return {
		RequestType: requestType,
		...(requestType === "Create" ? {} : { PhysicalResourceId: name }),
		ResourceProperties: { ParameterName: name, ValueLength: String(length) },
	};
}

async function handle(world: ChatticusWorld, requestType: GeneratedSecureStringEvent["RequestType"], name: string, length: number): Promise<void> {
	const scenario = scenarioOf(world);
	const handler = createGeneratedSecureStringHandler(fakeSsm(scenario));
	await withCapturedConsole(scenario.printed, async () => {
		try {
			scenario.answers.push(await handler(eventOf(requestType, name, length)));
		} catch (error) {
			scenario.failures.push(error instanceof Error ? error : new Error(String(error)));
		}
	});
	const stored = scenario.parameters.get(name);
	if (requestType === "Create" && stored !== undefined && stored.value !== PLACED_BY_HAND_VALUE) scenario.createdKeys.push(stored.value);
}

Given("the SSM parameter store holds nothing", function (this: ChatticusWorld) {
	scenarios.set(this, { parameters: new Map(), handedWrites: [], calls: 0, writeFailure: null, handByHand: new Map(), answers: [], failures: [], printed: [], createdKeys: [] });
});

Given("the parameter {string} already holds a SecureString that was placed by hand", function (this: ChatticusWorld, name: string) {
	scenarioOf(this).parameters.set(name, { value: PLACED_BY_HAND_VALUE, type: "SecureString", tier: "Standard" });
	scenarioOf(this).handByHand.set(name, PLACED_BY_HAND_VALUE);
});

Given("SSM refuses the write with the error {string}", function (this: ChatticusWorld, name: string) {
	scenarioOf(this).writeFailure = name;
});

When("CloudFormation creates the generated key {string} of {int} characters", async function (this: ChatticusWorld, name: string, length: number) {
	await handle(this, "Create", name, length);
});

When("CloudFormation updates the generated key {string} of {int} characters", async function (this: ChatticusWorld, name: string, length: number) {
	scenarioOf(this).calls = 0;
	await handle(this, "Update", name, length);
});

When("CloudFormation deletes the generated key {string} of {int} characters", async function (this: ChatticusWorld, name: string, length: number) {
	scenarioOf(this).calls = 0;
	await handle(this, "Delete", name, length);
});

function storedOf(world: ChatticusWorld, name: string): StoredParameter {
	const stored = scenarioOf(world).parameters.get(name);
	assert.ok(stored, `The parameter ${name} does not exist.`);
	return stored;
}

Then("the parameter {string} is a standard-tier SecureString of {int} characters", function (this: ChatticusWorld, name: string, length: number) {
	const stored = storedOf(this, name);
	assert.equal(stored.type, "SecureString");
	assert.equal(stored.tier, "Standard");
	assert.equal(stored.value.length, length);
});

Then("every character of the stored key is a letter or a digit", function (this: ChatticusWorld) {
	const keys = scenarioOf(this).createdKeys;
	assert.ok(keys.length > 0, "No key was generated.");
	for (const key of keys) assert.match(key, /^[A-Za-z0-9]+$/);
});

Then("the parameter was written with overwrite off", function (this: ChatticusWorld) {
	const writes = scenarioOf(this).handedWrites;
	assert.ok(writes.length > 0, "Nothing was written.");
	for (const write of writes) assert.equal(write.overwrite, false);
});

Then("the answer names the parameter {string} and its version and holds no other data", function (this: ChatticusWorld, name: string) {
	const answer = scenarioOf(this).answers.at(-1);
	assert.ok(answer, "The handler gave no answer.");
	assert.equal(answer.PhysicalResourceId, name);
	assert.deepEqual(Object.keys(answer.Data ?? {}).sort(), ["Name", "Version"]);
	assert.equal(answer.Data?.Name, name);
	assert.match(answer.Data?.Version ?? "", /^(\d+|adopted)$/);
	const text = JSON.stringify(answer);
	for (const key of [...scenarioOf(this).createdKeys, PLACED_BY_HAND_VALUE]) assert.equal(text.includes(key), false, "The answer holds a key.");
});

Then("the keys stored in the two parameters differ", function (this: ChatticusWorld) {
	const values = [...scenarioOf(this).parameters.values()].map((stored) => stored.value);
	assert.equal(values.length, 2);
	assert.notEqual(values[0], values[1]);
});

Then("the parameter {string} still holds the value that was placed by hand", function (this: ChatticusWorld, name: string) {
	assert.equal(storedOf(this, name).value, PLACED_BY_HAND_VALUE);
});

Then("the Lambda made no call to SSM", function (this: ChatticusWorld) {
	assert.equal(scenarioOf(this).calls, 0);
});

Then("the Lambda refuses with a message that names the minimum length {int}", function (this: ChatticusWorld, minimum: number) {
	const failure = scenarioOf(this).failures.at(-1);
	assert.ok(failure, "The Lambda did not refuse.");
	assert.ok(failure.message.includes(String(minimum)), failure.message);
});

Then("the Lambda refuses with a message that holds no key", function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	const failure = scenario.failures.at(-1);
	assert.ok(failure, "The Lambda did not refuse.");
	assert.equal(failure.message.includes("raw SSM message"), false);
	assert.ok(failure.message.includes("AccessDeniedException"), failure.message);
	assert.equal(scenario.parameters.size, 0);
});

Then("nothing the Lambda printed holds a generated key or the value that was placed by hand", function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	assert.ok(scenario.createdKeys.length > 0, "No key was generated.");
	const text = scenario.printed.join("\n");
	for (const key of [...scenario.createdKeys, PLACED_BY_HAND_VALUE]) assert.equal(text.includes(key), false, "The log holds a key.");
});
