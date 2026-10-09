import { SQSClient } from "@aws-sdk/client-sqs";
import type { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import type { EcsRunTaskInput } from "../src/computer/aws-ports.ts";
import type { Organization } from "../src/domain/organizations.ts";
import { composeComputerStarterDependencies, type ComputerStarterAwsClients } from "../src/lambdas/computer-starter.ts";
import type { ComputerStarterDependencies } from "../src/domain/computer-start.ts";
import { FakeCloudFormation, FakeEcr } from "./fakes/fake-customer-aws.ts";
import { FakeAssumeRole, FakeEcs, FakeStsAssumeRole } from "./fakes/fake-ecs.ts";
import { SCENARIO_GATEWAY_SIGNING_KEY } from "./model-gateway-support.ts";
import type { ChatticusWorld } from "./world.ts";

/** The account the scenario's deployment runs in. */
export const OWNER_START_DEPLOYMENT_ACCOUNT = "123456789012";

/** The invoke key value the scenario's secret holds; no log may carry it. */
export const OWNER_START_INVOKE_KEY = "scenario-invoke-key-value-77aa";

/** The secrets the starter reads by ARN. */
export const OWNER_START_INVOKE_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:invoke-AbCdEf";
export const OWNER_START_SIGNING_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:gateway-signing-AbCdEf";

/** What one scenario about the starter remembers between its steps. */
export type OwnerStartScenario = {
	environment: Record<string, string | undefined>;
	readonly ecs: FakeEcs;
	/** The ECS of a customer account, reached under the assumed cross-account role. */
	readonly customerEcs: FakeEcs;
	readonly sts: FakeStsAssumeRole;
	composed: ComputerStarterDependencies | null;
	composeError: Error | null;
	readonly logs: string[];
	/** The cross-account AssumeRole a customer-account start would make. */
	readonly crossAccount: FakeAssumeRole;
};

const scenarios = new WeakMap<ChatticusWorld, OwnerStartScenario>();

/** The scenario's starter state, created on first use with the host-worker settings the deployed starter has today. */
export function ownerStartOf(world: ChatticusWorld): OwnerStartScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = {
			environment: {
				CHATTICUS_ENVIRONMENT: "development",
				CHATTICUS_MESSAGING_TABLE: world.messagingTable.tableName,
				CHATTICUS_TURN_RUNS_QUEUE_URL: "http://127.0.0.1:1/000000000000/runs",
				CHATTICUS_TURN_PROBES_QUEUE_URL: "http://127.0.0.1:1/000000000000/probes",
				CHATTICUS_COMPUTER_STARTS_QUEUE_URL: "http://127.0.0.1:1/000000000000/starts",
				CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID: OWNER_START_DEPLOYMENT_ACCOUNT,
				CHATTICUS_HOST_STARTER: "ecs",
				CHATTICUS_ECS_CLUSTER: "computers",
				CHATTICUS_ECS_TASK_DEFINITION: "computer:7",
				CHATTICUS_ECS_SUBNETS: "subnet-aaa",
				CHATTICUS_ECS_CONTAINER_NAME: "computer",
				CHATTICUS_ECS_HOST_COMMAND: "node /opt/chatticus/host/host-worker.mjs",
				CHATTICUS_FRONT_DOOR_URL: "https://front-door.test/",
				CHATTICUS_INVOKE_KEY_SECRET_ARN: OWNER_START_INVOKE_SECRET_ARN,
				AWS_REGION: "us-east-1",
			},
			ecs: new FakeEcs(),
			customerEcs: new FakeEcs(),
			sts: new FakeStsAssumeRole(),
			composed: null,
			composeError: null,
			logs: [],
			crossAccount: new FakeAssumeRole(),
		};
		scenarios.set(world, scenario);
	}
	return scenario;
}

/** The settings the owner runtime adds to the starter's environment. */
export function ownerRuntimeSettings(): Record<string, string> {
	return {
		CHATTICUS_OWNER_TASK_DEFINITION: "owner-computer:3",
		CHATTICUS_OWNER_CONTAINER_NAME: "owner",
		CHATTICUS_OWNER_COMMAND: "node /opt/chatticus/host/owner.mjs",
		CHATTICUS_OWNER_SCOPED_ROLE_ARN: "arn:aws:iam::123456789012:role/owner-scoped",
		CHATTICUS_MODEL_GATEWAY_SIGNING_KEY_SECRET_ARN: OWNER_START_SIGNING_SECRET_ARN,
		CHATTICUS_CONVERSATIONS_TABLE: "conversations-table",
		CHATTICUS_PI_SESSIONS_BUCKET: "pi-sessions-bucket",
		CHATTICUS_SNAPSHOT_BUCKET: "snapshot-bucket",
	};
}

function secretsFor(): ComputerStarterAwsClients["secrets"] {
	const values: Record<string, string> = {
		[OWNER_START_INVOKE_SECRET_ARN]: OWNER_START_INVOKE_KEY,
		[OWNER_START_SIGNING_SECRET_ARN]: SCENARIO_GATEWAY_SIGNING_KEY,
	};
	return {
		async send(command: GetSecretValueCommand) {
			return { SecretString: values[command.input.SecretId ?? ""] };
		},
	} as ComputerStarterAwsClients["secrets"];
}

/** Run `action` while every console line it prints is kept on the scenario. */
export async function withCapturedLogs<T>(world: ChatticusWorld, action: () => Promise<T>): Promise<T> {
	const scenario = ownerStartOf(world);
	const methods = ["log", "info", "warn", "error", "debug"] as const;
	const originals = methods.map((method) => console[method]);
	for (const method of methods) {
		console[method] = (...parts: unknown[]) => {
			scenario.logs.push(parts.map((part) => (part instanceof Error ? `${part.message}\n${part.stack}` : String(part))).join(" "));
		};
	}
	try {
		return await action();
	} finally {
		methods.forEach((method, index) => {
			console[method] = originals[index]!;
		});
	}
}

/**
 * Compose the starter as the deployed Lambda does, from the scenario's environment and fakes. A refusal at composition
 * is kept on the scenario.
 */
export async function composeStarter(world: ChatticusWorld): Promise<ComputerStarterDependencies | null> {
	const scenario = ownerStartOf(world);
	if (scenario.composed !== null) return scenario.composed;
	scenario.composeError = null;
	try {
		scenario.composed = await withCapturedLogs(world, () =>
			composeComputerStarterDependencies(
				scenario.environment,
				{ dynamo: world.messagingTable.client, sqs: new SQSClient({ region: "us-east-1" }), secrets: secretsFor() },
				{
					ecsClientFactory: (credentials) => (credentials === null ? scenario.ecs : scenario.customerEcs),
					cloudformationClientFactory: () => new FakeCloudFormation(),
					ecrClientFactory: () => new FakeEcr(),
					assumeRole: scenario.crossAccount.port,
				},
				{ ecs: scenario.ecs, assumeRole: scenario.sts.port, clock: world.clock },
			),
		);
	} catch (error) {
		scenario.composeError = error as Error;
	}
	return scenario.composed;
}

/** The RunTask call number `index` (from 0) the starter made. */
export function runTaskOf(world: ChatticusWorld, index = 0): EcsRunTaskInput {
	const call = ownerStartOf(world).ecs.runTaskCalls[index];
	if (call === undefined) throw new Error(`The starter made no RunTask call number ${index + 1}.`);
	return call;
}

/** The environment of the container the RunTask call number `index` overrode, by name. */
export function containerEnvironmentOf(world: ChatticusWorld, index = 0): Map<string, string> {
	const override = runTaskOf(world, index).overrides?.containerOverrides?.[0];
	if (override === undefined) throw new Error("The RunTask call overrode no container.");
	return new Map(override.environment.map((entry) => [entry.name, entry.value]));
}

/** An organization of the scenario's tenant homed in `awsAccountId`. */
export function organizationHomedIn(existing: Organization | null, awsAccountId: string): Organization {
	return {
		tenantId: "anthus",
		name: "Anthus",
		status: "enabled",
		ownerUserId: "ryan",
		createdAt: new Date("2026-08-31T12:00:00Z"),
		awsCrossAccountRole: null,
		awsExternalId: null,
		awsSetupPath: "anthus-managed",
		setupFeeCents: null,
		assistedSetupSession: false,
		monthlyAwsSpendCeilingUsd: null,
		...(existing ?? {}),
		awsAccountId,
	};
}
