import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import type { GetParameterCommand } from "@aws-sdk/client-ssm";
import { SQSClient } from "@aws-sdk/client-sqs";
import { beforeAll, describe, expect, it } from "vitest";
import { createMessagingTable } from "../features-support/messaging-table.ts";
import {
	composeFrontDoorApp,
	REQUIRED_FRONT_DOOR_ENVIRONMENT,
	type FrontDoorAwsClients,
} from "../src/lambdas/front-door-composition.ts";

const endpoint = process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5555";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };
const dynamo = new DynamoDBClient({ endpoint, region: "us-east-1", credentials, maxAttempts: 1 });
const tableName = `front-door-composition-${randomUUID()}`;

const PARAMETER_VALUES: Record<string, string> = {
	"/chatticus/test/web/cognito-user-pool-id": "us-east-1_example",
	"/chatticus/test/web/cognito-app-client-id": "exampleclientid",
	"/chatticus/test/integration-test/allowed-role-arn": "arn:aws:iam::111122223333:role/runner",
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

function clientsWith(parameters: FrontDoorAwsClients["parameters"]): FrontDoorAwsClients {
	return {
		dynamo,
		s3: new S3Client({ endpoint, region: "us-east-1", credentials, forcePathStyle: true, maxAttempts: 1 }),
		sqs: new SQSClient({ endpoint, region: "us-east-1", credentials, maxAttempts: 1 }),
		parameters,
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
		CHATTICUS_INVOKE_KEY: "invoke-key-value",
		CHATTICUS_OPERATOR_KEY: "operator-key-value",
		CHATTICUS_INTEGRATION_TEST_ENABLED: "true",
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
				"CHATTICUS_INVOKE_KEY",
				"CHATTICUS_MESSAGING_TABLE",
				"CHATTICUS_OPERATOR_KEY",
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

	it("fails clearly when a Cognito parameter has no value", async () => {
		const without = { ...PARAMETER_VALUES };
		delete without["/chatticus/test/web/cognito-app-client-id"];
		await expect(composeFrontDoorApp(environmentFor(), clientsWith(fakeParameters(without)))).rejects.toThrow(
			"The SSM parameter /chatticus/test/web/cognito-app-client-id has no value.",
		);
	});

	it("reads the Cognito pool, the Cognito client and the integration role from SSM", async () => {
		const requested: string[] = [];
		await composeFrontDoorApp(environmentFor(), clientsWith(fakeParameters(PARAMETER_VALUES, requested)));
		expect(requested).toEqual([
			"/chatticus/test/web/cognito-user-pool-id",
			"/chatticus/test/web/cognito-app-client-id",
			"/chatticus/test/integration-test/allowed-role-arn",
			"/chatticus/test/integration-test/tenant-id",
			"/chatticus/test/integration-test/user-id",
		]);
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
