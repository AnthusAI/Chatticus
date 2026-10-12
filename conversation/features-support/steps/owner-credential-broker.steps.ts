import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import type { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { ownerCredentialBrokerResponseSchema, type OwnerCredentialBrokerResponse } from "@chatticus/host-protocol/supervisor";
import { createOwnerCredentialBrokerHandler } from "../../src/lambdas/owner-credential-broker.ts";
import { mintComputerOwnerToken, mintOwnerBootstrapToken, verifyComputerOwnerToken, verifySessionToken } from "../../src/gateway/session-token.ts";
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
	signingKeyReadable: boolean;
	stsFailure: string | null;
	readonly clock: FakeClock;
	readonly stsInputs: AssumeRoleInput[];
	response: OwnerCredentialBrokerResponse | null;
};

const scenarios = new WeakMap<ChatticusWorld, BrokerScenario>();

function scenarioOf(world: ChatticusWorld): BrokerScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = { signingKeyReadable: true, stsFailure: null, clock: new FakeClock(), stsInputs: [], response: null };
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

type ClaimOverrides = { tenantId?: string; ownerId?: string; startGeneration?: number; expired?: boolean };

function baseClaims(scenario: BrokerScenario, overrides: ClaimOverrides, lifetimeSeconds: number) {
	const nowSeconds = Math.floor(scenario.clock.now().getTime() / 1000);
	const expired = overrides.expired === true;
	return {
		tenantId: overrides.tenantId ?? "anthus",
		computerId: "computer-1",
		ownerId: overrides.ownerId ?? "owner-1",
		startGeneration: overrides.startGeneration ?? 2,
		issuedAtSeconds: expired ? nowSeconds - 2 * lifetimeSeconds : nowSeconds,
		expiresAtSeconds: expired ? nowSeconds - lifetimeSeconds : nowSeconds + lifetimeSeconds,
	};
}

function bootstrapToken(scenario: BrokerScenario, overrides: ClaimOverrides = {}): string {
	return mintOwnerBootstrapToken(SIGNING_KEY, { audience: "owner-bootstrap", ...baseClaims(scenario, overrides, 300) });
}

function supervisorToken(scenario: BrokerScenario, overrides: ClaimOverrides = {}): string {
	return mintComputerOwnerToken(SIGNING_KEY, { audience: "computer-owner", ...baseClaims(scenario, overrides, SESSION_SECONDS) });
}

type TurnPayload = { turn_id: string; bot_id: string; channel_id: string };

function requestFor(purpose: "supervisor" | "turn", authorization: string, turn?: TurnPayload): Record<string, unknown> {
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
	const sts = {
		send: async (command: AssumeRoleCommand) => {
			scenario.stsInputs.push(command.input);
			if (scenario.stsFailure !== null) {
				const failure = new Error("raw AWS message that must never reach the Front Door");
				failure.name = scenario.stsFailure;
				throw failure;
			}
			const expiration = new Date(scenario.clock.now().getTime() + SESSION_SECONDS * 1000);
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
	const handler = createOwnerCredentialBrokerHandler({
		sts,
		secrets,
		now: () => scenario.clock.now(),
		supervisorRoleArn: SUPERVISOR_ROLE_ARN,
		scopedRoleArn: SCOPED_ROLE_ARN,
		signingKeySecretArn: SIGNING_KEY_SECRET_ARN,
	});
	scenario.response = ownerCredentialBrokerResponseSchema.parse(await handler(payload));
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
	return new Date(scenarioOf(world).clock.now().getTime() + SESSION_SECONDS * 1000).toISOString();
}

Then("the role {string} was assumed for {int} seconds", function (this: ChatticusWorld, roleName: string, seconds: number) {
	const input = onlyStsInput(this);
	assert.ok(input.RoleArn?.endsWith(`:role/${roleName}`), `Assumed ${String(input.RoleArn)}`);
	assert.equal(input.DurationSeconds, seconds);
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
	assert.equal(
		Object.keys(verification.claims).some((key) => ["turnId", "botId", "channelId"].includes(key)),
		false,
	);
});

Then("the credentials, the token and the token's expiry end at the same moment", function (this: ChatticusWorld) {
	const response = okResponseOf(this);
	assert.equal(response.purpose, "supervisor");
	if (response.purpose !== "supervisor") return;
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
