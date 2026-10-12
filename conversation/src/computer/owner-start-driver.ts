/**
 * Start the organization's computer as a container owner: a Fargate task that runs the Pi session of the parked turn
 * itself, next to the workspace, instead of serving host actions over HTTP.
 *
 * Each start generates a fresh owner id and binds four things to it: the model gateway token, the host token, the claim of
 * the turn the container makes (the container passes the id as the worker id of its claim), and the scoped storage
 * credentials. The container holds the two tokens and credentials whose session tags bind the role's static policy to this organization,
 * computer and conversation, and never the model vendor's key and never the deployment's invoke key.
 *
 * The two tokens are the same claims signed for two audiences, so neither can be replayed on the other's surface. The
 * starter, not the container, registers the owner as a worker of its organization, because registration is what the invoke
 * key used to buy and the container no longer holds it. The only secrets in the task overrides are therefore the two
 * tokens and the scoped credentials, all of which expire one hour after the start; nothing of longer life is left for a
 * reader of ECS task descriptions to find.
 */

import { OWNER_CREDENTIAL_LIFETIME_SECONDS } from "@chatticus/host-protocol/supervisor";
import { ownerSessionTags, type SessionTag } from "../gateway/session-tags.ts";
import { mintSessionToken, type SessionTokenAudience } from "../gateway/session-token.ts";
import { consoleLogEmitter, errorNameOf } from "../observability/log-line.ts";
import type { ComputerStartJob, HostStartDriver } from "../domain/computer-start.ts";
import type { HostStartClaim } from "../domain/computers.ts";
import type { Turn } from "../domain/turns.ts";
import type { EcsPort, ScopedAssumeRolePort } from "./aws-ports.ts";
import { runFargateTask, type DeploymentEcsConfig, type StarterEnvironment } from "./host-starter.ts";
import { OWNER_START_GENERATION_VARIABLE } from "./owner-environment.ts";

/** Where the owner container finds its control plane and stores, and how the starter reaches ECS and STS. */
export type OwnerStartConfig = {
	readonly ecs: DeploymentEcsConfig;
	/** The task definition that runs the owner program, in place of the host worker's. */
	readonly ownerTaskDefinition: string;
	readonly containerName: string;
	readonly command: readonly string[];
	/** The role whose static policy the session tags resolve. */
	readonly scopedRoleArn: string;
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
	readonly assumeRole: ScopedAssumeRolePort;
	readonly getTurn: (tenantId: string, turnId: string) => Promise<Turn | null>;
	readonly clock: { now(): Date };
	readonly newOwnerId: () => string;
	/** Register the owner as a worker of the organization's computer, so its heartbeat and snapshot reports have a record to land on. */
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
		scopedRoleArn: required(environment, "CHATTICUS_OWNER_SCOPED_ROLE_ARN"),
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

/** Starts one owner container for a parked turn: owner id, gateway token, scoped credentials, then the ECS task. */
export class OwnerStartDriver implements HostStartDriver {
	private readonly config: OwnerStartConfig;
	private readonly ports: OwnerStartPorts;

	constructor(config: OwnerStartConfig, ports: OwnerStartPorts) {
		this.config = config;
		this.ports = ports;
	}

	async start(claim: HostStartClaim, job: ComputerStartJob): Promise<void> {
		const { config, ports } = this;
		const turn = await ports.getTurn(job.tenantId, job.turnId);
		if (turn === null || turn.botId !== job.botId) {
			consoleLogEmitter({ tenant_id: job.tenantId, turn_id: job.turnId })("owner_start_refused", { reason: "turn_not_found" });
			throw new Error(`Turn ${JSON.stringify(job.turnId)} of bot ${JSON.stringify(job.botId)} does not exist, so no owner was started.`);
		}
		const ownerId = ports.newOwnerId();
		const log = consoleLogEmitter({ tenant_id: job.tenantId, turn_id: job.turnId, owner_id: ownerId });
		const expiresAtSeconds = Math.floor(ports.clock.now().getTime() / 1000) + OWNER_CREDENTIAL_LIFETIME_SECONDS;
		const mintFor = (audience: SessionTokenAudience): string =>
			mintSessionToken(config.signingKey, {
				audience,
				tenantId: job.tenantId,
				botId: job.botId,
				turnId: job.turnId,
				ownerId,
				startGeneration: claim.hostStartGeneration,
				expiresAtSeconds,
			});
		const gatewayToken = mintFor("model-gateway");
		const hostToken = mintFor("owner-host");
		log("owner_token_minted", { lifetime_seconds: OWNER_CREDENTIAL_LIFETIME_SECONDS, expires_at_seconds: expiresAtSeconds });
		let tags: SessionTag[];
		try {
			tags = ownerSessionTags({
				tenantId: job.tenantId,
				botId: job.botId,
				channelId: turn.channelId,
				computerId: claim.computerId,
				turnId: job.turnId,
			});
		} catch (error) {
			log("owner_start_refused", { reason: "unsafe_session_tag", error_name: errorNameOf(error) });
			throw error;
		}
		const sessionName = ownerId.slice(0, 64);
		let assumed: Awaited<ReturnType<OwnerStartPorts["assumeRole"]>>;
		try {
			assumed = await ports.assumeRole({
				RoleArn: config.scopedRoleArn,
				RoleSessionName: sessionName,
				Tags: tags,
				DurationSeconds: OWNER_CREDENTIAL_LIFETIME_SECONDS,
			});
		} catch (error) {
			log("scoped_credentials_failed", { session_name: sessionName, error_name: errorNameOf(error) });
			throw error;
		}
		log("scoped_credentials_assumed", { session_name: sessionName, expires_at: assumed.Credentials.Expiration.toISOString() });
		try {
			await ports.registerOwnerWorker({ tenantId: job.tenantId, ownerId, computerId: claim.computerId });
		} catch (error) {
			log("owner_worker_registration_failed", { error_name: errorNameOf(error) });
			throw error;
		}
		const environment = [
			{ name: "CHATTICUS_TENANT_ID", value: job.tenantId },
			{ name: "CHATTICUS_USER_ID", value: claim.userId },
			{ name: "CHATTICUS_TAKEOVER_TURN_ID", value: job.turnId },
			{ name: "CHATTICUS_TAKEOVER_BOT_ID", value: job.botId },
			{ name: "CHATTICUS_OWNER_ID", value: ownerId },
			{ name: OWNER_START_GENERATION_VARIABLE, value: String(claim.hostStartGeneration) },
			{ name: "CHATTICUS_MODEL_GATEWAY_URL", value: `${config.frontDoorUrl}/orgs/${job.tenantId}/model-gateway/v1` },
			{ name: "CHATTICUS_MODEL_GATEWAY_TOKEN", value: gatewayToken },
			{ name: "CHATTICUS_OWNER_HOST_TOKEN", value: hostToken },
			{ name: "CHATTICUS_FRONT_DOOR_URL", value: config.frontDoorUrl },
			{ name: "CHATTICUS_MESSAGING_TABLE", value: config.messagingTable },
			{ name: "CHATTICUS_CONVERSATIONS_TABLE", value: config.conversationsTable },
			{ name: "CHATTICUS_PI_SESSIONS_BUCKET", value: config.piSessionsBucket },
			{ name: "CHATTICUS_SNAPSHOT_BUCKET", value: config.snapshotBucket },
			{ name: "CHATTICUS_ENVIRONMENT", value: config.environment },
			{ name: "AWS_REGION", value: config.region },
			{ name: "AWS_DEFAULT_REGION", value: config.region },
			{ name: "AWS_ACCESS_KEY_ID", value: assumed.Credentials.AccessKeyId },
			{ name: "AWS_SECRET_ACCESS_KEY", value: assumed.Credentials.SecretAccessKey },
			{ name: "AWS_SESSION_TOKEN", value: assumed.Credentials.SessionToken },
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
