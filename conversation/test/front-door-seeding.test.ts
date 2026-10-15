import { randomUUID } from "node:crypto";
import { DynamoDBClient, PutItemCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import type { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import type { GetParameterCommand } from "@aws-sdk/client-ssm";
import { SQSClient } from "@aws-sdk/client-sqs";
import { beforeEach, describe, expect, it } from "vitest";
import { createMessagingTable } from "../features-support/messaging-table.ts";
import {
	DEFAULT_INTEGRATION_TEST_TENANT_ID,
	DEFAULT_INTEGRATION_TEST_USER_ID,
} from "../src/auth/integration-test.ts";
import { composeFrontDoorApp, type FrontDoorAwsClients } from "../src/lambdas/front-door-composition.ts";
import { DynamoMessagingStore } from "../src/store/dynamo-messaging-store.ts";

const endpoint = process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5555";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };
const dynamo = new DynamoDBClient({ endpoint, region: "us-east-1", credentials, maxAttempts: 1 });

const DEPLOYMENT_ACCOUNT_ID = "123456789012";
const INVOKE_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:111122223333:secret:invoke-AbCdEf";
const OPERATOR_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:111122223333:secret:operator-GhIjKl";

function parametersWith(values: Record<string, string>): FrontDoorAwsClients["parameters"] {
	return {
		async send(command: GetParameterCommand) {
			const value = values[command.input.Name ?? ""];
			return { Parameter: value === undefined ? undefined : { Value: value } };
		},
	};
}

const secrets = {
	async send(command: GetSecretValueCommand) {
		return { SecretString: command.input.SecretId === INVOKE_SECRET_ARN ? "invoke-key-value" : "operator-key-value" };
	},
} as FrontDoorAwsClients["secrets"];

const WITH_ALLOWED_ROLE = {
	"/chatticus/test/web/cognito-user-pool-id": "us-east-1_example",
	"/chatticus/test/web/cognito-app-client-id": "exampleclientid",
	"/chatticus/test/integration-test/allowed-role-arn": "arn:aws:iam::111122223333:role/runner",
};

const WITHOUT_ALLOWED_ROLE = {
	"/chatticus/test/web/cognito-user-pool-id": "us-east-1_example",
	"/chatticus/test/web/cognito-app-client-id": "exampleclientid",
};

let tableName = "";

function clientsFor(parameters: Record<string, string>, dynamoClient: DynamoDBClient = dynamo): FrontDoorAwsClients {
	return {
		dynamo: dynamoClient,
		s3: new S3Client({ endpoint, region: "us-east-1", credentials, forcePathStyle: true, maxAttempts: 1 }),
		sqs: new SQSClient({ endpoint, region: "us-east-1", credentials, maxAttempts: 1 }),
		parameters: parametersWith(parameters),
		secrets,
	};
}

function environmentFor(environmentName: string): Record<string, string | undefined> {
	return {
		CHATTICUS_ENVIRONMENT: environmentName,
		CHATTICUS_MESSAGING_TABLE: tableName,
		CHATTICUS_CONVERSATIONS_TABLE: "conversations",
		CHATTICUS_PI_SESSIONS_BUCKET: "pi-sessions",
		CHATTICUS_TURN_RUNS_QUEUE_URL: `${endpoint}/000000000000/runs`,
		CHATTICUS_TURN_PROBES_QUEUE_URL: `${endpoint}/000000000000/probes`,
		CHATTICUS_COMPUTER_STARTS_QUEUE_URL: `${endpoint}/000000000000/starts`,
		CHATTICUS_SIGNUP_MODE: "open",
		CHATTICUS_COGNITO_USER_POOL_ID_PARAMETER: `/chatticus/${environmentName}/web/cognito-user-pool-id`,
		CHATTICUS_COGNITO_APP_CLIENT_ID_PARAMETER: `/chatticus/${environmentName}/web/cognito-app-client-id`,
		CHATTICUS_INVOKE_KEY_SECRET_ARN: INVOKE_SECRET_ARN,
		CHATTICUS_OPERATOR_KEY_SECRET_ARN: OPERATOR_SECRET_ARN,
		CHATTICUS_INTEGRATION_TEST_ENABLED: "true",
		CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID: DEPLOYMENT_ACCOUNT_ID,
		OPENAI_API_KEY: "sk-test",
	};
}

async function itemCount(): Promise<number> {
	let count = 0;
	let startKey: Record<string, never> | undefined;
	do {
		const page = await dynamo.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey: startKey }));
		count += page.Items?.length ?? 0;
		startKey = page.LastEvaluatedKey as Record<string, never> | undefined;
	} while (startKey !== undefined);
	return count;
}

beforeEach(async () => {
	tableName = `front-door-seeding-${randomUUID()}`;
	await createMessagingTable(dynamo, tableName);
});

describe("front door cold start seeding of the integration-test organization", () => {
	it("seeds the enabled organization and the integration user's membership when integration auth is configured", async () => {
		await composeFrontDoorApp(environmentFor("test"), clientsFor(withTestPrefix(WITH_ALLOWED_ROLE)));
		const store = new DynamoMessagingStore(dynamo, tableName);
		const organization = await store.getOrganization(DEFAULT_INTEGRATION_TEST_TENANT_ID);
		expect(organization?.status).toBe("enabled");
		expect(organization?.awsAccountId).toBe(DEPLOYMENT_ACCOUNT_ID);
		const membership = await store.getMembership(DEFAULT_INTEGRATION_TEST_TENANT_ID, DEFAULT_INTEGRATION_TEST_USER_ID);
		expect(membership?.role).toBe("owner");
	});

	it("converges an organization stored with no AWS home to the deployment account id on the next compose", async () => {
		const store = new DynamoMessagingStore(dynamo, tableName);
		await composeFrontDoorApp(environmentFor("test"), clientsFor(withTestPrefix(WITH_ALLOWED_ROLE)));
		const seeded = await store.getOrganization(DEFAULT_INTEGRATION_TEST_TENANT_ID);
		await store.putOrganization({ ...seeded!, awsAccountId: null });
		expect((await store.getOrganization(DEFAULT_INTEGRATION_TEST_TENANT_ID))?.awsAccountId).toBeNull();
		await composeFrontDoorApp(environmentFor("test"), clientsFor(withTestPrefix(WITH_ALLOWED_ROLE)));
		expect((await store.getOrganization(DEFAULT_INTEGRATION_TEST_TENANT_ID))?.awsAccountId).toBe(DEPLOYMENT_ACCOUNT_ID);
	});

	it("fails the cold start loudly when the deployment account id is missing or malformed", async () => {
		for (const value of [undefined, "", "1234", "12345678901a", "123456789012 "]) {
			const environment = { ...environmentFor("test"), CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID: value };
			await expect(composeFrontDoorApp(environment, clientsFor(withTestPrefix(WITH_ALLOWED_ROLE)))).rejects.toThrow(
				"CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID",
			);
		}
	});

	it("composes twice and concurrently without failing or duplicating", async () => {
		const environment = environmentFor("test");
		await composeFrontDoorApp(environment, clientsFor(withTestPrefix(WITH_ALLOWED_ROLE)));
		const countAfterFirst = await itemCount();
		await composeFrontDoorApp(environment, clientsFor(withTestPrefix(WITH_ALLOWED_ROLE)));
		expect(await itemCount()).toBe(countAfterFirst);
		await Promise.all([
			composeFrontDoorApp(environment, clientsFor(withTestPrefix(WITH_ALLOWED_ROLE))),
			composeFrontDoorApp(environment, clientsFor(withTestPrefix(WITH_ALLOWED_ROLE))),
		]);
		expect(await itemCount()).toBe(countAfterFirst);
	});

	it("seeds nothing in production, where integration auth is off", async () => {
		await composeFrontDoorApp(environmentFor("production"), clientsFor(withPrefix("production", WITH_ALLOWED_ROLE)));
		expect(await itemCount()).toBe(0);
	});

	it("refuses the cold start without the deployment account id, which the operator enable route homes organizations in", async () => {
		const environment = { ...environmentFor("production"), CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID: undefined };
		await expect(composeFrontDoorApp(environment, clientsFor(withPrefix("production", WITH_ALLOWED_ROLE)))).rejects.toThrow(
			"CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID",
		);
		expect(await itemCount()).toBe(0);
	});

	it("seeds nothing when the allowed role is not set", async () => {
		await composeFrontDoorApp(environmentFor("test"), clientsFor(withTestPrefix(WITHOUT_ALLOWED_ROLE)));
		expect(await itemCount()).toBe(0);
	});

	it("fails the cold start loudly when the seed write fails", async () => {
		const failing = new Proxy(dynamo, {
			get(target, property, receiver) {
				if (property !== "send") return Reflect.get(target, property, receiver);
				return (command: unknown, ...rest: unknown[]) => {
					if (command instanceof PutItemCommand) {
						throw Object.assign(new Error("write throttled"), { name: "ProvisionedThroughputExceededException" });
					}
					return (target.send as (...args: unknown[]) => unknown)(command, ...rest);
				};
			},
		});
		await expect(
			composeFrontDoorApp(environmentFor("test"), clientsFor(withTestPrefix(WITH_ALLOWED_ROLE), failing)),
		).rejects.toThrow("write throttled");
	});
});

function withPrefix(environmentName: string, values: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(values).map(([name, value]) => [name.replace("/chatticus/test/", `/chatticus/${environmentName}/`), value]));
}

function withTestPrefix(values: Record<string, string>): Record<string, string> {
	return values;
}
