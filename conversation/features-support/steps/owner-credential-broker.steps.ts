import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Given, Then, When } from "@cucumber/cucumber";
import type { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { ownerCredentialBrokerResponseSchema, type OwnerCredentialBrokerResponse } from "@chatticus/host-protocol/supervisor";
import { createDeployedOwnerCredentialBrokerHandler, createOwnerCredentialBrokerHandler } from "../../src/lambdas/owner-credential-broker.ts";
import {
	mintComputerOwnerToken,
	mintOwnerBootstrapToken,
	mintSessionToken,
	verifyComputerOwnerToken,
	verifySessionToken,
} from "../../src/gateway/session-token.ts";
import { FakeClock } from "../clock.ts";
import type { ChatticusWorld } from "../world.ts";

const SUPERVISOR_ROLE_ARN = "arn:aws:iam::111111111111:role/ComputerSupervisorRole";
const SCOPED_ROLE_ARN = "arn:aws:iam::111111111111:role/ComputerOwnerScopedRole";
const SIGNING_KEY_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:111111111111:secret:signing-key";
const SIGNING_KEY = "scenario-signing-key-".padEnd(48, "k");
const STS_SECRET_ACCESS_KEY = "sts-secret-access-key-value";
const STS_SESSION_TOKEN = "sts-session-token-value";
const SESSION_SECONDS = 3600;

type AssumeRoleInput = ConstructorParameters<typeof AssumeRoleCommand>[0];

type BrokerScenario = {
	ownerAgeSeconds: number;
	signingKeyReadable: boolean;
	stsFailure: string | null;
	deployedEnvironment: Record<string, string | undefined> | null;
	startFailure: string | null;
	readonly clock: FakeClock;
	readonly stsInputs: AssumeRoleInput[];
	response: OwnerCredentialBrokerResponse | null;
};

const scenarios = new WeakMap<ChatticusWorld, BrokerScenario>();

function scenarioOf(world: ChatticusWorld): BrokerScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = { ownerAgeSeconds: 0, signingKeyReadable: true, stsFailure: null, deployedEnvironment: null, startFailure: null, clock: new FakeClock(), stsInputs: [], response: null };
		scenarios.set(world, scenario);
	}
	return scenario;
}

function responseOf(world: ChatticusWorld): OwnerCredentialBrokerResponse {
	const response = scenarioOf(world).response;
	assert.ok(response, "The broker has not answered.");
	return response;
}

function okResponseOf(world: ChatticusWorld): Extract<OwnerCredentialBrokerResponse, { ok: true }> {
	const response = responseOf(world);
	assert.ok(response.ok, `The broker refused: ${JSON.stringify(response)}`);
	return response;
}

type ClaimOverrides = { tenantId?: string; computerId?: string; ownerId?: string; startGeneration?: number; expired?: boolean };

function baseClaims(scenario: BrokerScenario, overrides: ClaimOverrides, lifetimeSeconds: number) {
	const nowSeconds = Math.floor(scenario.clock.now().getTime() / 1000);
	const expired = overrides.expired === true;
	return {
		tenantId: overrides.tenantId ?? "anthus",
		computerId: overrides.computerId ?? "computer-1",
		ownerId: overrides.ownerId ?? "owner-1",
		startGeneration: overrides.startGeneration ?? 2,
		issuedAtSeconds: expired ? nowSeconds - 2 * lifetimeSeconds : nowSeconds,
		expiresAtSeconds: expired ? nowSeconds - lifetimeSeconds : nowSeconds + lifetimeSeconds,
	};
}

function bootstrapToken(scenario: BrokerScenario, overrides: ClaimOverrides = {}): string {
	return mintOwnerBootstrapToken(SIGNING_KEY, { audience: "owner-bootstrap", ...baseClaims(scenario, overrides, 300) });
}

function nowSecondsOf(scenario: BrokerScenario): number {
	return Math.floor(scenario.clock.now().getTime() / 1000);
}

function supervisorToken(scenario: BrokerScenario, overrides: ClaimOverrides = {}): string {
	const ownerStartedAtSeconds = nowSecondsOf(scenario) - scenario.ownerAgeSeconds;
	return mintComputerOwnerToken(SIGNING_KEY, { audience: "computer-owner", ownerStartedAtSeconds, ...baseClaims(scenario, overrides, SESSION_SECONDS) });
}

function supervisorTokenWithoutStartTime(scenario: BrokerScenario): string {
	const claims = JSON.stringify({ audience: "computer-owner", ...baseClaims(scenario, {}, SESSION_SECONDS) });
	const signedPart = `ct1.${Buffer.from(claims).toString("base64url")}`;
	return `${signedPart}.${createHmac("sha256", SIGNING_KEY).update(signedPart).digest().toString("base64url")}`;
}

function gatewayToken(scenario: BrokerScenario): string {
	return mintSessionToken(SIGNING_KEY, {
		audience: "model-gateway",
		tenantId: "anthus",
		botId: "bot-1",
		turnId: "turn-1",
		ownerId: "owner-1",
		startGeneration: 2,
		expiresAtSeconds: nowSecondsOf(scenario) + SESSION_SECONDS,
	});
}

type TurnPayload = { turn_id: string; bot_id: string; channel_id: string };

type BrokerPurpose = "supervisor" | "supervisor_renewal" | "turn";

function requestFor(purpose: BrokerPurpose, authorization: string, turn?: TurnPayload): Record<string, unknown> {
	return {
		version: 1,
		purpose,
		tenant_id: "anthus",
		computer_id: "computer-1",
		owner_id: "owner-1",
		generation: 2,
		authorization,
		...(turn === undefined ? {} : { turn }),
	};
}

const DEFAULT_TURN: TurnPayload = { turn_id: "turn-1", bot_id: "bot-1", channel_id: "channel-1" };

async function ask(world: ChatticusWorld, payload: Record<string, unknown>): Promise<void> {
	const scenario = scenarioOf(world);
	scenario.stsInputs.length = 0;
	const sts = {
		send: async (command: AssumeRoleCommand) => {
			scenario.stsInputs.push(command.input);
			if (scenario.stsFailure !== null) {
				const failure = new Error("raw AWS message that must never reach the Front Door");
				failure.name = scenario.stsFailure;
				throw failure;
			}
			const expiration = new Date(scenario.clock.now().getTime() + (command.input.DurationSeconds ?? SESSION_SECONDS) * 1000);
			return {
				Credentials: { AccessKeyId: "ASIABROKERSCENARIO", SecretAccessKey: STS_SECRET_ACCESS_KEY, SessionToken: STS_SESSION_TOKEN, Expiration: expiration },
			};
		},
	} as unknown as Pick<STSClient, "send">;
	const secrets = {
		send: async () => {
			if (!scenario.signingKeyReadable) throw new Error("secret unreadable");
			return { SecretString: SIGNING_KEY };
		},
	} as unknown as Pick<SecretsManagerClient, "send">;
	const handler = handlerOf(scenario, sts, secrets);
	scenario.response = ownerCredentialBrokerResponseSchema.parse(await handler(payload));
}

function handlerOf(
	scenario: BrokerScenario,
	sts: Pick<STSClient, "send">,
	secrets: Pick<SecretsManagerClient, "send">,
): (event: unknown) => Promise<OwnerCredentialBrokerResponse> {
	if (scenario.deployedEnvironment !== null) {
		return createDeployedOwnerCredentialBrokerHandler(scenario.deployedEnvironment, { sts, secrets, now: () => scenario.clock.now() });
	}
	return createOwnerCredentialBrokerHandler({
		sts,
		secrets,
		now: () => scenario.clock.now(),
		supervisorRoleArn: SUPERVISOR_ROLE_ARN,
		scopedRoleArn: SCOPED_ROLE_ARN,
		signingKeySecretArn: SIGNING_KEY_SECRET_ARN,
	});
}

Given("the broker holds the signing key", function (this: ChatticusWorld) {
	scenarioOf(this).signingKeyReadable = true;
});

Given("the broker cannot read the signing key", function (this: ChatticusWorld) {
	scenarioOf(this).signingKeyReadable = false;
});

Given("STS refuses the assume-role call with the error {string}", function (this: ChatticusWorld, name: string) {
	scenarioOf(this).stsFailure = name;
});

When("the broker is asked for supervisor credentials with a valid bootstrap token", async function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	await ask(this, requestFor("supervisor", bootstrapToken(scenario)));
});

Given("the supervisor token names a bootstrap {int} seconds ago", function (this: ChatticusWorld, seconds: number) {
	scenarioOf(this).ownerAgeSeconds = seconds;
});

When("the broker is asked for supervisor renewal credentials with a valid supervisor token", async function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	await ask(this, requestFor("supervisor_renewal", supervisorToken(scenario)));
});

When("the broker is asked for turn credentials with a valid supervisor token", async function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	await ask(this, requestFor("turn", supervisorToken(scenario), { ...DEFAULT_TURN }));
});

When("the broker is asked for turn credentials with a supervisor token without a start time", async function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	await ask(this, requestFor("turn", supervisorTokenWithoutStartTime(scenario), { ...DEFAULT_TURN }));
});

When(/^the broker is asked for supervisor renewal credentials and (.+)$/, async function (this: ChatticusWorld, fault: string) {
	const scenario = scenarioOf(this);
	let payload: Record<string, unknown> = requestFor("supervisor_renewal", supervisorToken(scenario));
	const age = /^the owner was bootstrapped (\d+) seconds ago$/.exec(fault);
	if (age !== null) {
		scenario.ownerAgeSeconds = Number(age[1]);
		payload = requestFor("supervisor_renewal", supervisorToken(scenario));
	} else {
		switch (fault) {
			case "the authorization is a bootstrap token":
				payload = requestFor("supervisor_renewal", bootstrapToken(scenario));
				break;
			case "the authorization is a model gateway token":
				payload = requestFor("supervisor_renewal", gatewayToken(scenario));
				break;
			case "the authorization is an expired supervisor token":
				payload = requestFor("supervisor_renewal", supervisorToken(scenario, { expired: true }));
				break;
			case "the authorization names another owner than the payload":
				payload = requestFor("supervisor_renewal", supervisorToken(scenario, { ownerId: "owner-other" }));
				break;
			case "the authorization names another computer than the payload":
				payload = requestFor("supervisor_renewal", supervisorToken(scenario, { computerId: "computer-other" }));
				break;
			case "the authorization is a supervisor token without a start time":
				payload = requestFor("supervisor_renewal", supervisorTokenWithoutStartTime(scenario));
				break;
			case "the payload names a turn":
				payload = requestFor("supervisor_renewal", supervisorToken(scenario), { ...DEFAULT_TURN });
				break;
			default:
				assert.fail(`Unknown broker renewal fault: ${fault}`);
		}
	}
	await ask(this, payload);
});

When(
	"the broker is asked for turn credentials for bot {string}, channel {string} and turn {string} with a valid supervisor token",
	async function (this: ChatticusWorld, botId: string, channelId: string, turnId: string) {
		const scenario = scenarioOf(this);
		await ask(this, requestFor("turn", supervisorToken(scenario), { turn_id: turnId, bot_id: botId, channel_id: channelId }));
	},
);

When(/^the broker is asked for (supervisor|turn) credentials and (.+)$/, async function (this: ChatticusWorld, purpose: "supervisor" | "turn", fault: string) {
	const scenario = scenarioOf(this);
	const valid = purpose === "supervisor" ? bootstrapToken(scenario) : supervisorToken(scenario);
	const turn = purpose === "turn" ? { ...DEFAULT_TURN } : undefined;
	let payload: Record<string, unknown> = requestFor(purpose, valid, turn);
	switch (fault) {
		case "the authorization is a supervisor token":
			payload = requestFor(purpose, supervisorToken(scenario), turn);
			break;
		case "the authorization is a bootstrap token":
			payload = requestFor(purpose, bootstrapToken(scenario), turn);
			break;
		case "the authorization is expired":
			payload = requestFor(purpose, bootstrapToken(scenario, { expired: true }), turn);
			break;
		case "the authorization names another owner than the payload":
			payload = requestFor(purpose, bootstrapToken(scenario, { ownerId: "owner-other" }), turn);
			break;
		case "the authorization names another generation than the payload":
			payload = requestFor(purpose, bootstrapToken(scenario, { startGeneration: 3 }), turn);
			break;
		case "the authorization names another organization than the payload":
			payload = requestFor(purpose, supervisorToken(scenario, { tenantId: "other" }), turn);
			break;
		case 'the bot id is "bot 1"':
			payload = requestFor(purpose, valid, { ...DEFAULT_TURN, bot_id: "bot 1" });
			break;
		case "the payload has no turn":
			payload = requestFor(purpose, valid);
			break;
		case "the payload names a turn":
			payload = requestFor(purpose, valid, { ...DEFAULT_TURN });
			break;
		case "the payload version is 2":
			payload = { ...payload, version: 2 };
			break;
		default:
			assert.fail(`Unknown broker fault: ${fault}`);
	}
	await ask(this, payload);
});

function onlyStsInput(world: ChatticusWorld): AssumeRoleInput {
	const inputs = scenarioOf(world).stsInputs;
	assert.equal(inputs.length, 1, "STS should have been asked exactly once.");
	return inputs[0]!;
}

function expectedExpiry(world: ChatticusWorld): string {
	const scenario = scenarioOf(world);
	return new Date(scenario.clock.now().getTime() + (onlyStsInput(world).DurationSeconds ?? SESSION_SECONDS) * 1000).toISOString();
}

function hardEndIso(world: ChatticusWorld, secondsAfterBootstrap: number): string {
	const scenario = scenarioOf(world);
	return new Date((nowSecondsOf(scenario) - scenario.ownerAgeSeconds + secondsAfterBootstrap) * 1000).toISOString();
}

Then("the role {string} was assumed for {int} seconds", function (this: ChatticusWorld, roleName: string, seconds: number) {
	const input = onlyStsInput(this);
	assert.ok(input.RoleArn?.endsWith(`:role/${roleName}`), `Assumed ${String(input.RoleArn)}`);
	assert.equal(input.DurationSeconds, seconds);
});

Then("the role was assumed for {int} seconds", function (this: ChatticusWorld, seconds: number) {
	assert.equal(onlyStsInput(this).DurationSeconds, seconds);
});

Then("the session name is the session name of the bootstrap", function (this: ChatticusWorld) {
	assert.equal(onlyStsInput(this).RoleSessionName, "supervisor-owner-1");
});

Then(/^the session tags are exactly (.+)$/, function (this: ChatticusWorld, keyList: string) {
	const expectedKeys = [...keyList.matchAll(/"([a-z]+)"/g)].map((match) => match[1]!);
	const tags = onlyStsInput(this).Tags ?? [];
	assert.deepEqual(
		tags.map((tag) => tag.Key),
		expectedKeys,
	);
	const expectedValues: Record<string, string> = { tenant: "anthus", bot: "bot-1", channel: "channel-1", computer: "computer-1", turn: "turn-1" };
	for (const tag of tags) assert.equal(tag.Value, expectedValues[tag.Key ?? ""], `tag ${String(tag.Key)}`);
});

Then("the broker's assume-role call carries no session policy", function (this: ChatticusWorld) {
	const input = onlyStsInput(this);
	assert.equal(input.Policy, undefined);
	assert.equal(input.PolicyArns, undefined);
});

function supervisorTokenOf(world: ChatticusWorld, purpose: "supervisor" | "supervisor_renewal") {
	const response = okResponseOf(world);
	assert.equal(response.purpose, purpose);
	if (response.purpose !== purpose) assert.fail("The answer is not a supervisor grant.");
	const verification = verifyComputerOwnerToken(SIGNING_KEY, response.supervisor_token, scenarioOf(world).clock.now());
	assert.ok(verification.valid, "The supervisor token did not verify.");
	if (!verification.valid) assert.fail("The supervisor token did not verify.");
	return { response, claims: verification.claims };
}

Then("the answer holds a supervisor token that keeps the bootstrap time of the token it was given", function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	const { claims } = supervisorTokenOf(this, "supervisor_renewal");
	assert.equal(claims.ownerStartedAtSeconds, nowSecondsOf(scenario) - scenario.ownerAgeSeconds);
	assert.equal(claims.tenantId, "anthus");
	assert.equal(claims.computerId, "computer-1");
	assert.equal(claims.ownerId, "owner-1");
	assert.equal(claims.startGeneration, 2);
});

Then("the answer holds a supervisor token whose bootstrap time is the time of the broker's clock", function (this: ChatticusWorld) {
	const { claims } = supervisorTokenOf(this, "supervisor");
	assert.equal(claims.ownerStartedAtSeconds, nowSecondsOf(scenarioOf(this)));
});

Then("the credentials, the token and the token's expiry end {int} seconds after the bootstrap", function (this: ChatticusWorld, seconds: number) {
	const { response, claims } = supervisorTokenOf(this, "supervisor_renewal");
	const expiry = hardEndIso(this, seconds);
	assert.equal(response.aws_credentials.expires_at, expiry);
	assert.equal(response.supervisor_token_expires_at, expiry);
	assert.equal(new Date(claims.expiresAtSeconds * 1000).toISOString(), expiry);
});

Then("the gateway token and the credentials end {int} seconds after the bootstrap", function (this: ChatticusWorld, seconds: number) {
	const response = okResponseOf(this);
	assert.equal(response.purpose, "turn");
	if (response.purpose !== "turn") return;
	const verification = verifySessionToken(SIGNING_KEY, response.gateway_token, scenarioOf(this).clock.now(), "model-gateway");
	assert.ok(verification.valid, "The gateway token did not verify.");
	if (!verification.valid) return;
	const expiry = hardEndIso(this, seconds);
	assert.equal(response.expires_at, expiry);
	assert.equal(response.aws_credentials.expires_at, expiry);
	assert.equal(new Date(verification.claims.expiresAtSeconds * 1000).toISOString(), expiry);
});

Then("the answer holds a supervisor token for the audience {string} that names no turn", function (this: ChatticusWorld, audience: string) {
	const response = okResponseOf(this);
	assert.equal(response.purpose, "supervisor");
	if (response.purpose !== "supervisor") return;
	const verification = verifyComputerOwnerToken(SIGNING_KEY, response.supervisor_token, scenarioOf(this).clock.now());
	assert.ok(verification.valid, "The supervisor token did not verify.");
	if (!verification.valid) return;
	assert.equal(verification.claims.audience, audience);
	assert.equal(verification.claims.tenantId, "anthus");
	assert.equal(verification.claims.computerId, "computer-1");
	assert.equal(verification.claims.ownerId, "owner-1");
	assert.equal(verification.claims.startGeneration, 2);
	assert.equal(verification.claims.ownerStartedAtSeconds, Math.floor(scenarioOf(this).clock.now().getTime() / 1000));
	assert.equal(
		Object.keys(verification.claims).some((key) => ["turnId", "botId", "channelId"].includes(key)),
		false,
	);
});

Then("the credentials, the token and the token's expiry end at the same moment", function (this: ChatticusWorld) {
	const response = okResponseOf(this);
	assert.notEqual(response.purpose, "turn");
	if (response.purpose === "turn") return;
	const verification = verifyComputerOwnerToken(SIGNING_KEY, response.supervisor_token, scenarioOf(this).clock.now());
	assert.ok(verification.valid);
	if (!verification.valid) return;
	const expiry = expectedExpiry(this);
	assert.equal(response.aws_credentials.expires_at, expiry);
	assert.equal(response.supervisor_token_expires_at, expiry);
	assert.equal(new Date(verification.claims.expiresAtSeconds * 1000).toISOString(), expiry);
});

Then("the answer holds a gateway token for the audience {string} bound to the turn, the bot and the owner id", function (this: ChatticusWorld, audience: string) {
	const response = okResponseOf(this);
	assert.equal(response.purpose, "turn");
	if (response.purpose !== "turn") return;
	const verification = verifySessionToken(SIGNING_KEY, response.gateway_token, scenarioOf(this).clock.now(), audience as "model-gateway");
	assert.ok(verification.valid, "The gateway token did not verify.");
	if (!verification.valid) return;
	assert.equal(verification.claims.audience, audience);
	assert.equal(verification.claims.tenantId, "anthus");
	assert.equal(verification.claims.botId, "bot-1");
	assert.equal(verification.claims.turnId, "turn-1");
	assert.equal(verification.claims.ownerId, "owner-1");
	assert.equal(verification.claims.startGeneration, 2);
	const expiry = expectedExpiry(this);
	assert.equal(response.expires_at, expiry);
	assert.equal(response.aws_credentials.expires_at, expiry);
	assert.equal(verification.claims.expiresAtSeconds * 1000, new Date(expiry).getTime());
});

Then("the broker answers not ok with the code {string}", function (this: ChatticusWorld, code: string) {
	const response = responseOf(this);
	assert.equal(response.ok, false, "The broker issued credentials.");
	if (!response.ok) assert.equal(response.error.code, code);
});

Then("STS was not asked to assume a role", function (this: ChatticusWorld) {
	assert.equal(scenarioOf(this).stsInputs.length, 0);
});

Then("the message is {string} and holds no token, key or credential", function (this: ChatticusWorld, message: string) {
	const response = responseOf(this);
	assert.equal(response.ok, false);
	if (response.ok) return;
	assert.equal(response.error.message, message);
	const text = JSON.stringify(response);
	for (const secret of [SIGNING_KEY, STS_SECRET_ACCESS_KEY, STS_SESSION_TOKEN, "ct1.", "raw AWS message"]) {
		assert.equal(text.includes(secret), false, "The answer leaks a secret.");
	}
});

function deployedEnvironmentWith(variables: Record<string, string | undefined>): Record<string, string | undefined> {
	return {
		CHATTICUS_OWNER_SUPERVISOR_ROLE_ARN: SUPERVISOR_ROLE_ARN,
		CHATTICUS_OWNER_SCOPED_ROLE_ARN: SCOPED_ROLE_ARN,
		CHATTICUS_MODEL_GATEWAY_SIGNING_KEY_SECRET_ARN: SIGNING_KEY_SECRET_ARN,
		...variables,
	};
}

Given("the broker runs in the environment {string} with the fault {string}", function (this: ChatticusWorld, environment: string, fault: string) {
	scenarioOf(this).deployedEnvironment = deployedEnvironmentWith({ CHATTICUS_ENVIRONMENT: environment, CHATTICUS_OWNER_BROKER_FAULT: fault });
});

Given(
	"the broker runs in the environment {string} with credentials limited to {int} seconds",
	function (this: ChatticusWorld, environment: string, seconds: number) {
		scenarioOf(this).deployedEnvironment = deployedEnvironmentWith({
			CHATTICUS_ENVIRONMENT: environment,
			CHATTICUS_OWNER_BROKER_CREDENTIAL_SECONDS: String(seconds),
		});
	},
);

async function invokeDeployedEntryPoint(world: ChatticusWorld): Promise<string | null> {
	const scenario = scenarioOf(world);
	scenario.stsInputs.length = 0;
	const environment = scenario.deployedEnvironment;
	assert.ok(environment, "No deployed environment was set in this scenario.");
	const sts = { send: async (command: AssumeRoleCommand) => void scenario.stsInputs.push(command.input) } as unknown as Pick<STSClient, "send">;
	const secrets = { send: async () => ({ SecretString: SIGNING_KEY }) } as unknown as Pick<SecretsManagerClient, "send">;
	const entryPoint = createDeployedOwnerCredentialBrokerHandler(environment, { sts, secrets, now: () => scenario.clock.now() });
	const request = requestFor("supervisor", bootstrapToken(scenario));
	const failures: Array<string | null> = [];
	for (let invocation = 0; invocation < 3; invocation += 1) {
		try {
			await entryPoint(request);
			failures.push(null);
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
		}
	}
	return failures.every((failure) => failure !== null) ? (failures[0] as string) : null;
}

When(
	/^the broker is started in the environment ("[^"]*"|not set) with the fault "([^"]+)"$/,
	async function (this: ChatticusWorld, environment: string, fault: string) {
		const scenario = scenarioOf(this);
		scenario.deployedEnvironment = deployedEnvironmentWith({
			CHATTICUS_ENVIRONMENT: environment === "not set" ? undefined : environment.slice(1, -1),
			CHATTICUS_OWNER_BROKER_FAULT: fault,
		});
		scenario.startFailure = await invokeDeployedEntryPoint(this);
	},
);

Then("the broker refuses to start", async function (this: ChatticusWorld) {
	const scenario = scenarioOf(this);
	scenario.startFailure = await invokeDeployedEntryPoint(this);
	assert.notEqual(scenario.startFailure, null, "The broker started.");
});

Then("every invocation of the deployed entry point fails", function (this: ChatticusWorld) {
	assert.notEqual(scenarioOf(this).startFailure, null, "An invocation of the deployed entry point succeeded.");
});
