import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { CreateBucketCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import type { GetParameterCommand } from "@aws-sdk/client-ssm";
import { SQSClient } from "@aws-sdk/client-sqs";
import { beforeAll, describe, expect, it } from "vitest";
import { DynamoWriteGate, WRITE_GATE_CACHE_MILLISECONDS } from "../src/migration/migration-state.ts";
import { createMessagingTable } from "../features-support/messaging-table.ts";
import { ensureComputer } from "../src/domain/computers.ts";
import { mintComputerOwnerToken } from "../src/gateway/session-token.ts";
import { DynamoMessagingStore } from "../src/store/dynamo-messaging-store.ts";
import {
	composeFrontDoorApp,
	REQUIRED_FRONT_DOOR_ENVIRONMENT,
	type FrontDoorAwsClients,
} from "../src/lambdas/front-door-composition.ts";

const endpoint = process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5555";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };
const dynamo = new DynamoDBClient({ endpoint, region: "us-east-1", credentials, maxAttempts: 1 });
const tableName = `front-door-composition-${randomUUID()}`;

const OPERATOR_KEY_PARAMETER_NAME = "/chatticus/test/thin-turn/operator-key";

const PARAMETER_VALUES: Record<string, string> = {
	"/chatticus/test/web/cognito-user-pool-id": "us-east-1_example",
	"/chatticus/test/web/cognito-app-client-id": "exampleclientid",
	"/chatticus/test/integration-test/allowed-role-arn": "arn:aws:iam::111122223333:role/runner",
	[OPERATOR_KEY_PARAMETER_NAME]: "operator-key-value",
};

function fakeParameters(values: Record<string, string>, requested: string[] = [], failures: Record<string, string> = {}) {
	return {
		async send(command: GetParameterCommand) {
			const name = command.input.Name ?? "";
			requested.push(name);
			const failure = failures[name];
			if (failure !== undefined) throw Object.assign(new Error(failure), { name: failure });
			const value = values[name];
			return { Parameter: value === undefined ? undefined : { Value: value } };
		},
	};
}

const INVOKE_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:111122223333:secret:invoke-AbCdEf";
const SECRET_VALUES: Record<string, string> = {
	[INVOKE_SECRET_ARN]: "invoke-key-value",
};

function fakeSecrets(values: Record<string, string> = SECRET_VALUES, requested: string[] = []) {
	return {
		async send(command: GetSecretValueCommand) {
			const secretId = command.input.SecretId ?? "";
			requested.push(secretId);
			return { SecretString: values[secretId] };
		},
	} as FrontDoorAwsClients["secrets"];
}

function clientsWith(
	parameters: FrontDoorAwsClients["parameters"],
	secrets: FrontDoorAwsClients["secrets"] = fakeSecrets(),
): FrontDoorAwsClients {
	return {
		dynamo,
		s3: new S3Client({ endpoint, region: "us-east-1", credentials, forcePathStyle: true, maxAttempts: 1 }),
		sqs: new SQSClient({ endpoint, region: "us-east-1", credentials, maxAttempts: 1 }),
		parameters,
		secrets,
	};
}

function environmentFor(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
	return {
		CHATTICUS_ENVIRONMENT: "test",
		CHATTICUS_MESSAGING_TABLE: tableName,
		CHATTICUS_CONVERSATIONS_TABLE: "conversations",
		CHATTICUS_PI_SESSIONS_BUCKET: "pi-sessions",
		CHATTICUS_TURN_RUNS_QUEUE_URL: `${endpoint}/000000000000/runs`,
		CHATTICUS_TURN_PROBES_QUEUE_URL: `${endpoint}/000000000000/probes`,
		CHATTICUS_COMPUTER_STARTS_QUEUE_URL: `${endpoint}/000000000000/starts`,
		CHATTICUS_SIGNUP_MODE: "open",
		CHATTICUS_COGNITO_USER_POOL_ID_PARAMETER: "/chatticus/test/web/cognito-user-pool-id",
		CHATTICUS_COGNITO_APP_CLIENT_ID_PARAMETER: "/chatticus/test/web/cognito-app-client-id",
		CHATTICUS_INVOKE_KEY_SECRET_ARN: INVOKE_SECRET_ARN,
		CHATTICUS_OPERATOR_KEY_PARAMETER_NAME: OPERATOR_KEY_PARAMETER_NAME,
		CHATTICUS_INTEGRATION_TEST_ENABLED: "true",
		CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID: "123456789012",
		OPENAI_API_KEY: "sk-test",
		...overrides,
	};
}

beforeAll(async () => {
	await createMessagingTable(dynamo, tableName);
});

describe("front door composition", () => {
	it("requires exactly the variables the stack sets", () => {
		expect([...REQUIRED_FRONT_DOOR_ENVIRONMENT].sort()).toEqual(
			[
				"CHATTICUS_COGNITO_APP_CLIENT_ID_PARAMETER",
				"CHATTICUS_COGNITO_USER_POOL_ID_PARAMETER",
				"CHATTICUS_COMPUTER_STARTS_QUEUE_URL",
				"CHATTICUS_CONVERSATIONS_TABLE",
				"CHATTICUS_ENVIRONMENT",
				"CHATTICUS_INVOKE_KEY_SECRET_ARN",
				"CHATTICUS_MESSAGING_TABLE",
				"CHATTICUS_OPERATOR_KEY_PARAMETER_NAME",
				"CHATTICUS_PI_SESSIONS_BUCKET",
				"CHATTICUS_SIGNUP_MODE",
				"CHATTICUS_TURN_PROBES_QUEUE_URL",
				"CHATTICUS_TURN_RUNS_QUEUE_URL",
			].sort(),
		);
	});

	it("reads every required environment variable and fails clearly when one is missing", async () => {
		for (const name of REQUIRED_FRONT_DOOR_ENVIRONMENT) {
			await expect(
				composeFrontDoorApp(environmentFor({ [name]: undefined }), clientsWith(fakeParameters(PARAMETER_VALUES))),
			).rejects.toThrow(`The environment variable ${name} is required.`);
			await expect(
				composeFrontDoorApp(environmentFor({ [name]: "" }), clientsWith(fakeParameters(PARAMETER_VALUES))),
			).rejects.toThrow(`The environment variable ${name} is required.`);
		}
	});

	it("reads the invoke key from Secrets Manager by ARN and the operator key from SSM by name, never from the environment", async () => {
		const requested: string[] = [];
		const requestedParameters: string[] = [];
		const environment = environmentFor({ CHATTICUS_INVOKE_KEY: "ignored", CHATTICUS_OPERATOR_KEY: "ignored" });
		const app = await composeFrontDoorApp(environment, clientsWith(fakeParameters(PARAMETER_VALUES, requestedParameters), fakeSecrets(SECRET_VALUES, requested)));
		expect(requested).toEqual([INVOKE_SECRET_ARN, INVOKE_SECRET_ARN]);
		expect(requestedParameters).toContain(OPERATOR_KEY_PARAMETER_NAME);
		const response = await app.request("http://front-door.test/operator/orgs/nobody/enable", {
			method: "POST",
			headers: { "X-Chatticus-Invoke-Key": "invoke-key-value", Authorization: "Bearer operator-key-value" },
		});
		expect(response.status).toBe(404);
	});

	it("fails clearly when the invoke key secret has no value", async () => {
		await expect(
			composeFrontDoorApp(
				environmentFor(),
				clientsWith(fakeParameters(PARAMETER_VALUES), fakeSecrets({ ...SECRET_VALUES, [INVOKE_SECRET_ARN]: "" })),
			),
		).rejects.toThrow(`The secret ${INVOKE_SECRET_ARN} has no value.`);
	});

	it("fails clearly when the operator key parameter has no value", async () => {
		const without = { ...PARAMETER_VALUES };
		delete without[OPERATOR_KEY_PARAMETER_NAME];
		await expect(composeFrontDoorApp(environmentFor(), clientsWith(fakeParameters(without)))).rejects.toThrow(
			`The SSM parameter ${OPERATOR_KEY_PARAMETER_NAME} has no value.`,
		);
	});

	it("fails clearly when a Cognito parameter has no value", async () => {
		const without = { ...PARAMETER_VALUES };
		delete without["/chatticus/test/web/cognito-app-client-id"];
		await expect(composeFrontDoorApp(environmentFor(), clientsWith(fakeParameters(without)))).rejects.toThrow(
			"The SSM parameter /chatticus/test/web/cognito-app-client-id has no value.",
		);
	});

	it("reads the Cognito pool, the Cognito client, the integration role and the operator key from SSM", async () => {
		const requested: string[] = [];
		await composeFrontDoorApp(environmentFor(), clientsWith(fakeParameters(PARAMETER_VALUES, requested)));
		expect(requested.filter((name) => name !== OPERATOR_KEY_PARAMETER_NAME)).toEqual([
			"/chatticus/test/web/cognito-user-pool-id",
			"/chatticus/test/web/cognito-app-client-id",
			"/chatticus/test/integration-test/allowed-role-arn",
			"/chatticus/test/integration-test/tenant-id",
			"/chatticus/test/integration-test/user-id",
		]);
		expect(requested.filter((name) => name === OPERATOR_KEY_PARAMETER_NAME)).toHaveLength(1);
	});

	const integrationNames = [
		"/chatticus/test/integration-test/allowed-role-arn",
		"/chatticus/test/integration-test/tenant-id",
		"/chatticus/test/integration-test/user-id",
	];

	it("treats missing integration test parameters as integration test auth disabled", async () => {
		const failures = Object.fromEntries(integrationNames.map((name) => [name, "ParameterNotFound"]));
		const app = await composeFrontDoorApp(
			environmentFor(),
			clientsWith(fakeParameters({ ...PARAMETER_VALUES }, [], failures)),
		);
		const response = await app.request("http://front-door.test/integration-test/session", {
			method: "POST",
			headers: { "X-Chatticus-Invoke-Key": "invoke-key-value" },
		});
		expect(response.status).toBe(404);
	});

	it("still fails when a Cognito parameter is not found", async () => {
		await expect(
			composeFrontDoorApp(
				environmentFor(),
				clientsWith(
					fakeParameters(PARAMETER_VALUES, [], { "/chatticus/test/web/cognito-user-pool-id": "ParameterNotFound" }),
				),
			),
		).rejects.toThrow("ParameterNotFound");
	});

	it("still fails when an integration test parameter is denied", async () => {
		await expect(
			composeFrontDoorApp(
				environmentFor(),
				clientsWith(fakeParameters(PARAMETER_VALUES, [], { [integrationNames[0]!]: "AccessDeniedException" })),
			),
		).rejects.toThrow("AccessDeniedException");
	});

	it("reads the OpenAI key from its SSM parameter when it is not already set", async () => {
		const environment = environmentFor({ OPENAI_API_KEY: undefined, OPENAI_API_KEY_PARAMETER: "/chatticus/test/key" });
		await composeFrontDoorApp(
			environment,
			clientsWith(fakeParameters({ ...PARAMETER_VALUES, "/chatticus/test/key": "sk-from-ssm" })),
		);
		expect(environment.OPENAI_API_KEY).toBe("sk-from-ssm");
	});
});

describe("composed front door against the local emulator", () => {
	const send = async (app: Awaited<ReturnType<typeof composeFrontDoorApp>>, path: string, init: RequestInit = {}) =>
		app.request(`http://front-door.test${path}`, init);

	it("answers GET /health", async () => {
		const app = await composeFrontDoorApp(environmentFor(), clientsWith(fakeParameters(PARAMETER_VALUES)));
		const response = await send(app, "/health");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok", environment: "test" });
	});

	it("refuses every other route without the invoke key", async () => {
		const app = await composeFrontDoorApp(environmentFor(), clientsWith(fakeParameters(PARAMETER_VALUES)));
		const response = await send(app, "/integration-test/session", { method: "POST" });
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ detail: "invoke key required" });
	});

	it("serves POST /integration-test/session and refuses an unsigned caller", async () => {
		const app = await composeFrontDoorApp(environmentFor(), clientsWith(fakeParameters(PARAMETER_VALUES)));
		const response = await send(app, "/integration-test/session", {
			method: "POST",
			headers: { "X-Chatticus-Invoke-Key": "invoke-key-value" },
		});
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ detail: "integration test caller required" });
	});

	it("does not mount the integration test session in production", async () => {
		const app = await composeFrontDoorApp(
			environmentFor({ CHATTICUS_ENVIRONMENT: "production" }),
			clientsWith(fakeParameters(PARAMETER_VALUES)),
		);
		const response = await send(app, "/integration-test/session", {
			method: "POST",
			headers: { "X-Chatticus-Invoke-Key": "invoke-key-value" },
		});
		expect(response.status).toBe(404);
	});

	it("reads the Messaging table behind an operator route", async () => {
		const app = await composeFrontDoorApp(environmentFor(), clientsWith(fakeParameters(PARAMETER_VALUES)));
		const unauthorized = await send(app, "/operator/orgs/nobody/enable", {
			method: "POST",
			headers: { "X-Chatticus-Invoke-Key": "invoke-key-value" },
		});
		expect(unauthorized.status).toBe(403);
		const known = await send(app, "/operator/orgs/nobody/enable", {
			method: "POST",
			headers: { "X-Chatticus-Invoke-Key": "invoke-key-value", Authorization: "Bearer operator-key-value" },
		});
		expect(known.status).toBe(404);
	});
});

describe("front door write gate", () => {
	const invokeHeaders = { "X-Chatticus-Invoke-Key": "invoke-key-value" };
	const gate = new DynamoWriteGate(dynamo, tableName);
	const clockAt = (state: { ms: number }) => ({ now: () => new Date(state.ms) });
	const compose = (clock: { now(): Date }, client: DynamoDBClient = dynamo) =>
		composeFrontDoorApp(environmentFor({ CHATTICUS_INTEGRATION_TEST_ENABLED: undefined }), { ...clientsWith(fakeParameters(PARAMETER_VALUES)), dynamo: client }, clock);
	const write = (app: Awaited<ReturnType<typeof compose>>, method: string) =>
		app.request("http://front-door.test/api/channels", { method, headers: invokeHeaders });

	it("refuses POST, PUT and DELETE with 503 and Retry-After while closed, and keeps reads, health and OPTIONS open", async () => {
		await gate.set("MIGRATING", new Date());
		const app = await compose(clockAt({ ms: 1_000_000 }));
		for (const method of ["POST", "PUT", "DELETE"]) {
			const response = await write(app, method);
			expect(response.status, method).toBe(503);
			expect(response.headers.get("Retry-After")).toBe("30");
		}
		expect((await app.request("http://front-door.test/health", { headers: invokeHeaders })).status).toBe(200);
		expect((await write(app, "GET")).status).not.toBe(503);
		expect((await write(app, "OPTIONS")).status).not.toBe(503);
		await gate.set("OPEN", new Date());
	});

	it("admits a write when open", async () => {
		await gate.set("OPEN", new Date());
		const app = await compose(clockAt({ ms: 1_000_000 }));
		expect((await write(app, "POST")).status).not.toBe(503);
	});

	it("fails closed when the gate item cannot be read", async () => {
		const failing = new Proxy(dynamo, {
			get(target, property, receiver) {
				if (property !== "send") return Reflect.get(target, property, receiver);
				return async (command: { constructor: { name: string }; input: { Key?: { pk?: { S?: string } } } }) => {
					if (command.constructor.name === "GetItemCommand" && command.input.Key?.pk?.S === "MIGRATION") {
						throw new Error("dynamo unavailable");
					}
					return target.send(command as never);
				};
			},
		});
		const app = await compose(clockAt({ ms: 1_000_000 }), failing);
		expect((await write(app, "POST")).status).toBe(503);
		expect((await app.request("http://front-door.test/health", { headers: invokeHeaders })).status).toBe(200);
	});

	it("takes a gate open effect only after the cache window", async () => {
		const time = { ms: 1_000_000 };
		await gate.set("MIGRATING", new Date());
		const app = await compose(clockAt(time));
		expect((await write(app, "POST")).status).toBe(503);
		await gate.set("OPEN", new Date());
		time.ms += WRITE_GATE_CACHE_MILLISECONDS - 1;
		expect((await write(app, "POST")).status).toBe(503);
		time.ms += 1;
		expect((await write(app, "POST")).status).not.toBe(503);
	});
});

describe("front door composition of the owner routes", () => {
	const GATEWAY_PARAMETER_NAME = "/chatticus/test/model-gateway/signing-key";
	const parameters = fakeParameters({ ...PARAMETER_VALUES, [GATEWAY_PARAMETER_NAME]: "gateway-signing-key-for-the-composition-test" });
	const lambda = {
		async send() {
			throw new Error("the broker must not be called by an unauthenticated request");
		},
	};
	const pollWithInvokeKey = (app: Awaited<ReturnType<typeof composeFrontDoorApp>>) =>
		app.request("http://front-door.test/orgs/anthus/host/owner/poll", {
			method: "POST",
			headers: { "X-Chatticus-Invoke-Key": "invoke-key-value", "content-type": "application/json" },
			body: "{}",
		});

	it("serves the owner routes when the signing key and the broker function are set", async () => {
		const app = await composeFrontDoorApp(
			environmentFor({ CHATTICUS_MODEL_GATEWAY_SIGNING_KEY_PARAMETER_NAME: GATEWAY_PARAMETER_NAME, CHATTICUS_OWNER_CREDENTIAL_BROKER_FUNCTION_NAME: "owner-credential-broker" }),
			{ ...clientsWith(parameters), lambda },
		);
		const response = await pollWithInvokeKey(app);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ code: "not_current_owner" });
	});

	describe("the edit overlay routes", () => {
		const SIGNING_KEY = "gateway-signing-key-for-the-composition-test";
		const bucket = `front-door-overlay-${randomUUID().slice(0, 12)}`;
		const s3 = new S3Client({ endpoint, region: "us-east-1", credentials, forcePathStyle: true, maxAttempts: 1 });

		const sealRequest = async (app: Awaited<ReturnType<typeof composeFrontDoorApp>>, tenantId: string, ownerId: string) => {
			const issuedAtSeconds = Math.floor(Date.now() / 1000);
			const token = mintComputerOwnerToken(SIGNING_KEY, {
				audience: "computer-owner",
				tenantId,
				computerId: "household",
				ownerId,
				startGeneration: 1,
				ownerStartedAtSeconds: issuedAtSeconds,
				issuedAtSeconds,
				expiresAtSeconds: issuedAtSeconds + 600,
			});
			return app.request(`http://front-door.test/orgs/${tenantId}/host/owner/overlay-seal`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ owner_id: ownerId, generation: 1 }),
			});
		};

		const seedOwnedComputer = async (tenantId: string, ownerId: string) => {
			const store = new DynamoMessagingStore(dynamo, tableName);
			const computer = await ensureComputer(tenantId, { store, ids: { next: () => randomUUID() } }, "household");
			await store.putComputer({ ...computer, hostStartGeneration: 1, hostStartDispatchedGeneration: 1, ownerId, ownerGeneration: 1, ownerProtocolVersion: 2 });
		};

		const composeWith = (extra: Record<string, string | undefined>) =>
			composeFrontDoorApp(
				environmentFor({
					CHATTICUS_MODEL_GATEWAY_SIGNING_KEY_PARAMETER_NAME: GATEWAY_PARAMETER_NAME,
					CHATTICUS_OWNER_CREDENTIAL_BROKER_FUNCTION_NAME: "owner-credential-broker",
					...extra,
				}),
				{ ...clientsWith(fakeParameters({ ...PARAMETER_VALUES, [GATEWAY_PARAMETER_NAME]: SIGNING_KEY })), s3, lambda },
			);

		it("lets an owner seal the overlay in the snapshot bucket when the deployment names one", async () => {
			await s3.send(new CreateBucketCommand({ Bucket: bucket }));
			await seedOwnedComputer("sealtenant", "owner-seal-1");
			const response = await sealRequest(await composeWith({ CHATTICUS_SNAPSHOT_BUCKET: bucket }), "sealtenant", "owner-seal-1");
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ entries: [] });
			const stored = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: "tenants/sealtenant/computers/household/overlay/index.json" }));
			expect(JSON.parse(await stored.Body!.transformToString())).toMatchObject({ sealed: { owner_id: "owner-seal-1", generation: 1 }, entries: [] });
		});

		it("answers 503 on the overlay routes when the deployment has no snapshot bucket", async () => {
			await seedOwnedComputer("nobuckettenant", "owner-seal-2");
			const response = await sealRequest(await composeWith({ CHATTICUS_SNAPSHOT_BUCKET: undefined }), "nobuckettenant", "owner-seal-2");
			expect(response.status).toBe(503);
		});
	});

	it("serves no owner route when the broker function is not set", async () => {
		const app = await composeFrontDoorApp(
			environmentFor({ CHATTICUS_MODEL_GATEWAY_SIGNING_KEY_PARAMETER_NAME: GATEWAY_PARAMETER_NAME }),
			clientsWith(parameters),
		);
		expect((await pollWithInvokeKey(app)).status).toBe(404);
	});
});
