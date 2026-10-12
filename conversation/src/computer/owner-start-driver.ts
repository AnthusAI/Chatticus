/**
 * Start the organization's computer as a long-lived container owner: a Fargate task that runs the supervisor program,
 * which exchanges one bootstrap token for its credentials, asks the control plane for work, and runs each dispatched turn
 * in a child process.
 *
 * Each start generates a fresh owner id and binds one token to it: the bootstrap token, which names the organization, the
 * computer, the owner id and the claimed host start generation, lives five minutes and works once. The starter assumes no
 * role and mints no gateway token and no host token; the credential broker issues the supervisor's credentials at the
 * bootstrap exchange and each turn's credentials at dispatch. The starter, not the container, registers the owner as a
 * worker of its organization, because the worker item is the liveness record of the owner and the container holds no key
 * that could register it. The only secret in the task overrides is therefore the bootstrap token, and a reader of ECS task
 * descriptions who races for it can only take an exchange that the real owner will then see refused.
 */

import { OWNER_BOOTSTRAP_TOKEN_LIFETIME_SECONDS } from "@chatticus/host-protocol/supervisor";
import { supervisorSessionTags } from "../gateway/session-tags.ts";
import { mintOwnerBootstrapToken } from "../gateway/session-token.ts";
import { consoleLogEmitter, errorNameOf } from "../observability/log-line.ts";
import type { ComputerStartJob, HostStartDriver } from "../domain/computer-start.ts";
import type { HostStartClaim } from "../domain/computers.ts";
import type { EcsPort } from "./aws-ports.ts";
import { runFargateTask, type DeploymentEcsConfig, type StarterEnvironment } from "./host-starter.ts";
import { OWNER_START_GENERATION_VARIABLE } from "./owner-environment.ts";

/** Where the owner container finds its control plane and stores, and how the starter reaches ECS. */
export type OwnerStartConfig = {
	readonly ecs: DeploymentEcsConfig;
	/** The task definition that runs the supervisor program, in place of the host worker's. */
	readonly ownerTaskDefinition: string;
	readonly containerName: string;
	readonly command: readonly string[];
	/** The secret the bootstrap token is signed with. */
	readonly signingKey: string;
	readonly frontDoorUrl: string;
	readonly messagingTable: string;
	readonly conversationsTable: string;
	readonly piSessionsBucket: string;
	readonly snapshotBucket: string;
	readonly environment: string;
	readonly deploymentAccountId: string;
	readonly region: string;
	/** Process environment values copied unchanged into the task environment for tags. */
	readonly taskEnvironment: StarterEnvironment;
};

/** What the owner start calls out to. */
export type OwnerStartPorts = {
	readonly ecs: EcsPort;
	readonly clock: { now(): Date };
	readonly newOwnerId: () => string;
	/** Register the owner as a worker of the organization's computer, so its poll has a liveness record to land on. */
	readonly registerOwnerWorker: (registration: { tenantId: string; ownerId: string; computerId: string }) => Promise<void>;
};

/** A required setting of the owner start is missing. */
export class OwnerStartConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OwnerStartConfigurationError";
	}
}

function required(environment: StarterEnvironment, name: string): string {
	const value = (environment[name] ?? "").trim();
	if (value === "") throw new OwnerStartConfigurationError(`The environment variable ${name} is required.`);
	return value;
}

/**
 * Read the owner start's settings. The signing key is a value the caller already resolved from its secret; it is never read
 * from the environment itself.
 *
 * @param environment The starter's environment.
 * @param secrets The signing key.
 * @returns The settings.
 * @throws OwnerStartConfigurationError If a required variable is missing.
 */
export function ownerStartConfigFromEnvironment(
	environment: StarterEnvironment,
	secrets: { readonly signingKey: string },
): OwnerStartConfig {
	const subnets = required(environment, "CHATTICUS_ECS_SUBNETS")
		.split(",")
		.filter((part) => part !== "");
	const securityGroups = (environment["CHATTICUS_ECS_SECURITY_GROUPS"] ?? "")
		.split(",")
		.filter((part) => part !== "");
	return {
		ecs: {
			cluster: required(environment, "CHATTICUS_ECS_CLUSTER"),
			taskDefinition: required(environment, "CHATTICUS_OWNER_TASK_DEFINITION"),
			subnets,
			securityGroups,
		},
		ownerTaskDefinition: required(environment, "CHATTICUS_OWNER_TASK_DEFINITION"),
		containerName: required(environment, "CHATTICUS_OWNER_CONTAINER_NAME"),
		command: required(environment, "CHATTICUS_OWNER_COMMAND")
			.split(/\s+/)
			.filter((part) => part !== ""),
		signingKey: secrets.signingKey,
		frontDoorUrl: required(environment, "CHATTICUS_FRONT_DOOR_URL").replace(/\/+$/, ""),
		messagingTable: required(environment, "CHATTICUS_MESSAGING_TABLE"),
		conversationsTable: required(environment, "CHATTICUS_CONVERSATIONS_TABLE"),
		piSessionsBucket: required(environment, "CHATTICUS_PI_SESSIONS_BUCKET"),
		snapshotBucket: required(environment, "CHATTICUS_SNAPSHOT_BUCKET"),
		environment: required(environment, "CHATTICUS_ENVIRONMENT"),
		deploymentAccountId: required(environment, "CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID"),
		region: required(environment, "AWS_REGION"),
		taskEnvironment: environment,
	};
}

/** Starts one supervisor container for a computer: owner id, bootstrap token, worker registration, then the ECS task. */
export class OwnerStartDriver implements HostStartDriver {
	private readonly config: OwnerStartConfig;
	private readonly ports: OwnerStartPorts;

	constructor(config: OwnerStartConfig, ports: OwnerStartPorts) {
		this.config = config;
		this.ports = ports;
	}

	async start(claim: HostStartClaim, job: ComputerStartJob): Promise<void> {
		const { config, ports } = this;
		const ownerId = ports.newOwnerId();
		const log = consoleLogEmitter({ tenant_id: job.tenantId, turn_id: job.turnId, owner_id: ownerId });
		try {
			supervisorSessionTags({ tenantId: job.tenantId, computerId: claim.computerId });
		} catch (error) {
			log("owner_start_refused", { reason: "unsafe_session_tag", error_name: errorNameOf(error) });
			throw error;
		}
		const issuedAtSeconds = Math.floor(ports.clock.now().getTime() / 1000);
		const expiresAtSeconds = issuedAtSeconds + OWNER_BOOTSTRAP_TOKEN_LIFETIME_SECONDS;
		const bootstrapToken = mintOwnerBootstrapToken(config.signingKey, {
			audience: "owner-bootstrap",
			tenantId: job.tenantId,
			computerId: claim.computerId,
			ownerId,
			startGeneration: claim.hostStartGeneration,
			issuedAtSeconds,
			expiresAtSeconds,
		});
		log("owner_token_minted", { lifetime_seconds: OWNER_BOOTSTRAP_TOKEN_LIFETIME_SECONDS, expires_at_seconds: expiresAtSeconds });
		try {
			await ports.registerOwnerWorker({ tenantId: job.tenantId, ownerId, computerId: claim.computerId });
		} catch (error) {
			log("owner_worker_registration_failed", { error_name: errorNameOf(error) });
			throw error;
		}
		const environment = [
			{ name: "CHATTICUS_TENANT_ID", value: job.tenantId },
			{ name: "CHATTICUS_USER_ID", value: claim.userId },
			{ name: "CHATTICUS_COMPUTER_ID", value: claim.computerId },
			{ name: "CHATTICUS_OWNER_ID", value: ownerId },
			{ name: OWNER_START_GENERATION_VARIABLE, value: String(claim.hostStartGeneration) },
			{ name: "CHATTICUS_OWNER_BOOTSTRAP_TOKEN", value: bootstrapToken },
			{ name: "CHATTICUS_FRONT_DOOR_URL", value: config.frontDoorUrl },
			{ name: "CHATTICUS_MODEL_GATEWAY_URL", value: `${config.frontDoorUrl}/orgs/${job.tenantId}/model-gateway/v1` },
			{ name: "CHATTICUS_MESSAGING_TABLE", value: config.messagingTable },
			{ name: "CHATTICUS_CONVERSATIONS_TABLE", value: config.conversationsTable },
			{ name: "CHATTICUS_PI_SESSIONS_BUCKET", value: config.piSessionsBucket },
			{ name: "CHATTICUS_SNAPSHOT_BUCKET", value: config.snapshotBucket },
			{ name: "CHATTICUS_ENVIRONMENT", value: config.environment },
			{ name: "AWS_REGION", value: config.region },
			{ name: "AWS_DEFAULT_REGION", value: config.region },
		];
		let taskArn: string | null;
		try {
			taskArn = await runFargateTask(ports.ecs, {
				...config.ecs,
				taskDefinition: config.ownerTaskDefinition,
				claim: { tenantId: claim.tenantId, computerId: claim.computerId, hostStartCount: claim.hostStartGeneration, userId: claim.userId },
				environment: config.taskEnvironment,
				containerOverride: { name: config.containerName, command: [...config.command], environment },
			});
		} catch (error) {
			log("owner_task_failed", { generation: claim.hostStartGeneration, error_name: errorNameOf(error) });
			throw error;
		}
		log("owner_task_started", { task_arn: taskArn, generation: claim.hostStartGeneration });
	}
}

/** Chooses, per organization, between the owner start for a computer in the deployment's own account and the host-worker start. */
export class OwnerRuntimeStartDriver implements HostStartDriver {
	private readonly owner: HostStartDriver;
	private readonly hostWorker: HostStartDriver;
	private readonly runsInDeploymentAccount: (tenantId: string) => Promise<boolean>;

	constructor(owner: HostStartDriver, hostWorker: HostStartDriver, runsInDeploymentAccount: (tenantId: string) => Promise<boolean>) {
		this.owner = owner;
		this.hostWorker = hostWorker;
		this.runsInDeploymentAccount = runsInDeploymentAccount;
	}

	async start(claim: HostStartClaim, job: ComputerStartJob): Promise<void> {
		if (await this.runsInDeploymentAccount(job.tenantId)) {
			await this.owner.start(claim, job);
			return;
		}
		await this.hostWorker.start(claim, job);
	}
}
