import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { SQSClient } from "@aws-sdk/client-sqs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createMessagingTable } from "../features-support/messaging-table.ts";
import { FakeEcs } from "../features-support/fakes/fake-ecs.ts";
import { composeComputerStarterDependencies, type ComputerStarterAwsClients } from "../src/lambdas/computer-starter.ts";
import type { HostStartClaim } from "../src/domain/computers.ts";
import { DynamoMessagingStore } from "../src/store/dynamo-messaging-store.ts";

const endpoint = process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5555";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };
const dynamo = new DynamoDBClient({ endpoint, region: "us-east-1", credentials, maxAttempts: 1 });
const sqs = new SQSClient({ endpoint, region: "us-east-1", credentials, maxAttempts: 1 });

const ACCOUNT_ID = "123456789012";
const SECRET_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:invoke-AbCdEf";
const SECRET_VALUE = "super-secret-invoke-key-value";
const FRONT_DOOR_URL = "https://front-door.example.lambda-url.us-east-1.on.aws/";
const tableName = `computer-starter-${randomUUID()}`;

function environment(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
	return {
		CHATTICUS_ENVIRONMENT: "development",
		CHATTICUS_MESSAGING_TABLE: tableName,
		CHATTICUS_TURN_RUNS_QUEUE_URL: `${endpoint}/000000000000/runs`,
		CHATTICUS_TURN_PROBES_QUEUE_URL: `${endpoint}/000000000000/probes`,
		CHATTICUS_COMPUTER_STARTS_QUEUE_URL: `${endpoint}/000000000000/starts`,
		CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID: ACCOUNT_ID,
		CHATTICUS_HOST_STARTER: "ecs",
		CHATTICUS_ECS_CLUSTER: "computers",
		CHATTICUS_ECS_TASK_DEFINITION: "computer:7",
		CHATTICUS_ECS_SUBNETS: "subnet-aaa",
		CHATTICUS_ECS_CONTAINER_NAME: "computer",
		CHATTICUS_ECS_HOST_COMMAND: "node /opt/chatticus/host/host-worker.mjs",
		CHATTICUS_FRONT_DOOR_URL: FRONT_DOOR_URL,
		CHATTICUS_INVOKE_KEY_SECRET_ARN: SECRET_ARN,
		...overrides,
	};
}

function secretsReturning(value: string | undefined, requested: string[] = []): ComputerStarterAwsClients["secrets"] {
	return {
		async send(command: GetSecretValueCommand) {
			requested.push(command.input.SecretId ?? "");
			return { SecretString: value };
		},
	} as ComputerStarterAwsClients["secrets"];
}

function failingSecrets(): ComputerStarterAwsClients["secrets"] {
	return {
		async send() {
			throw Object.assign(new Error("AccessDeniedException"), { name: "AccessDeniedException" });
		},
	} as ComputerStarterAwsClients["secrets"];
}

function clientsWith(secrets: ComputerStarterAwsClients["secrets"]): ComputerStarterAwsClients {
	return { dynamo, sqs, secrets };
}

const claim: HostStartClaim = {
	tenantId: "anthus",
	computerId: "household-computer",
	hostStartGeneration: 1,
	userId: "ryan",
	expiresAt: new Date("2026-10-06T12:00:00Z"),
	newlyClaimed: true,
};

const job = {
	jobId: "job-1",
	tenantId: "anthus",
	turnId: "turn-1",
	botId: "bot",
	userId: "ryan",
	computerId: "household-computer",
	computerPolicy: "prefer_local",
	requiredCapabilities: [],
} as const;

beforeAll(async () => {
	await createMessagingTable(dynamo, tableName);
	await new DynamoMessagingStore(dynamo, tableName).putOrganization({
		tenantId: "anthus",
		name: "Anthus",
		status: "enabled",
		ownerUserId: "ryan",
		createdAt: new Date("2026-10-01T00:00:00Z"),
		awsAccountId: ACCOUNT_ID,
		awsCrossAccountRole: null,
		awsExternalId: null,
		awsSetupPath: "anthus-managed",
		setupFeeCents: null,
		assistedSetupSession: false,
		monthlyAwsSpendCeilingUsd: null,
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ComputerStarter invoke key", () => {
	it("reads the invoke key secret by ARN at composition and forwards it with the Front Door URL in the RunTask overrides", async () => {
		const requested: string[] = [];
		const ecs = new FakeEcs();
		const dependencies = await composeComputerStarterDependencies(environment(), clientsWith(secretsReturning(SECRET_VALUE, requested)), {
			ecsClientFactory: () => ecs,
		});
		expect(requested).toEqual([SECRET_ARN]);
		await dependencies.driver.start(claim, job);
		expect(ecs.runTaskCalls).toHaveLength(1);
		const containerEnvironment = ecs.runTaskCalls[0]!.overrides!.containerOverrides![0]!.environment!;
		expect(containerEnvironment).toContainEqual({ name: "CHATTICUS_INVOKE_KEY", value: SECRET_VALUE });
		expect(containerEnvironment).toContainEqual({ name: "CHATTICUS_FRONT_DOOR_URL", value: FRONT_DOOR_URL });
	});

	it("never writes the key into the process environment", async () => {
		const processEnvironment = environment();
		await composeComputerStarterDependencies(processEnvironment, clientsWith(secretsReturning(SECRET_VALUE)), {
			ecsClientFactory: () => new FakeEcs(),
		});
		expect(processEnvironment.CHATTICUS_INVOKE_KEY).toBeUndefined();
		expect(Object.values(process.env)).not.toContain(SECRET_VALUE);
	});

	it("fails the start loudly when the secret cannot be read", async () => {
		await expect(composeComputerStarterDependencies(environment(), clientsWith(failingSecrets()))).rejects.toThrow("AccessDeniedException");
	});

	it("fails the start loudly when the secret has no value", async () => {
		await expect(composeComputerStarterDependencies(environment(), clientsWith(secretsReturning(undefined)))).rejects.toThrow(
			`The secret ${SECRET_ARN} has no value.`,
		);
	});

	it("fails the start loudly when the secret ARN or the Front Door URL is not configured", async () => {
		for (const name of ["CHATTICUS_INVOKE_KEY_SECRET_ARN", "CHATTICUS_FRONT_DOOR_URL"]) {
			await expect(
				composeComputerStarterDependencies(environment({ [name]: undefined }), clientsWith(secretsReturning(SECRET_VALUE))),
			).rejects.toThrow(`The environment variable ${name} is required.`);
		}
	});

	it("never prints the key value in any log, including the failure path", async () => {
		const printed: string[] = [];
		for (const method of ["log", "info", "warn", "error", "debug"] as const) {
			vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => void printed.push(parts.map(String).join(" ")));
		}
		const ecs = new FakeEcs();
		const dependencies = await composeComputerStarterDependencies(environment(), clientsWith(secretsReturning(SECRET_VALUE)), {
			ecsClientFactory: () => ecs,
		});
		await dependencies.driver.start(claim, job);
		await expect(composeComputerStarterDependencies(environment(), clientsWith(failingSecrets()))).rejects.toThrow();
		expect(printed.join("\n")).not.toContain(SECRET_VALUE);
	});
});
