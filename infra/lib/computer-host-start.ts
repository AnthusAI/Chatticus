import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { ChatticusCloudEnvironment } from "./environments";
import {
  OWNER_SESSION_TAG_KEYS,
  SUPERVISOR_SESSION_TAG_KEYS,
  ownerRolePolicyStatements,
  ownerSessionTagConditions,
  supervisorRolePolicyStatements,
} from "./owner-role-policy";

export interface ComputerHostStartEcsConfig {
  readonly cluster: string;
  readonly subnets: string[];
  readonly securityGroups: string[];
  readonly computerRepositoryName: string;
  readonly computerRepositoryArn: string;
  readonly computerImageUri: string;
}

/** Longest session either owner role may be assumed for, in seconds. */
export const OWNER_SCOPED_ROLE_MAX_SESSION_SECONDS = 3600;

/** Container command the starter runs in the owner task definition: the supervisor, which runs one child per turn. */
export const OWNER_CONTAINER_COMMAND = "node /opt/chatticus/host/supervisor.mjs";

/** The owner task definition and snapshot bucket read from ChatticusComputers. */
export interface ComputerOwnerStartConfig {
  readonly taskDefinition: string;
  readonly taskRoleArn: string;
  readonly executionRoleArn: string;
  readonly snapshotBucketName: string;
}

function contextString(scope: Construct, key: string): string {
  const value = scope.node.tryGetContext(key);
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function contextCsv(scope: Construct, key: string): string[] {
  return contextString(scope, key)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function computerRepositoryArn(
  scope: Construct,
  repositoryUri: string,
): { repositoryName: string; repositoryArn: string; imageUri: string } {
  const region =
    cdk.Stack.of(scope).region ||
    process.env.AWS_DEFAULT_REGION ||
    process.env.AWS_REGION ||
    "us-east-1";
  const account = cdk.Stack.of(scope).account;
  const repositoryName = repositoryUri.split("/").pop() ?? "";
  if (!repositoryName) {
    throw new Error(`Could not parse repository name from URI ${repositoryUri}`);
  }
  return {
    repositoryName,
    repositoryArn: `arn:aws:ecr:${region}:${account}:repository/${repositoryName}`,
    imageUri: `${repositoryUri}:dev`,
  };
}

function configFromContext(
  scope: Construct,
): ComputerHostStartEcsConfig | undefined {
  const cluster = contextString(scope, "computerEcsCluster");
  const subnets = contextCsv(scope, "computerEcsSubnets");
  const repositoryUri = contextString(scope, "computerEcrRepositoryUri");
  if (!cluster || subnets.length === 0 || !repositoryUri) {
    return undefined;
  }
  const repository = computerRepositoryArn(scope, repositoryUri);
  return {
    cluster,
    subnets,
    securityGroups: contextCsv(scope, "computerEcsSecurityGroups"),
    computerRepositoryName: repository.repositoryName,
    computerRepositoryArn: repository.repositoryArn,
    computerImageUri: repository.imageUri,
  };
}

function awsJson(args: string[]): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { execFileSync } = require("child_process") as typeof import("child_process");
  const raw = execFileSync("aws", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(raw);
}

/** The outputs of the live ChatticusComputers stack, by output key. Throws when the stack cannot be described. */
function computersStackOutputs(scope: Construct): Record<string, string> {
  const region =
    cdk.Stack.of(scope).region ||
    process.env.AWS_DEFAULT_REGION ||
    process.env.AWS_REGION ||
    "us-east-1";
  const stack = awsJson([
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    "ChatticusComputers",
    "--region",
    region,
    "--output",
    "json",
  ]) as {
    Stacks?: Array<{
      Outputs?: Array<{ OutputKey?: string; OutputValue?: string }>;
    }>;
  };
  const outputs: Record<string, string> = {};
  for (const output of stack.Stacks?.[0]?.Outputs || []) {
    if (output.OutputKey && output.OutputValue) {
      outputs[output.OutputKey] = output.OutputValue;
    }
  }
  return outputs;
}

/**
 * Read the ChatticusComputers outputs (cluster, repository, subnets, security group) at synth time so
 * ``cdk deploy ChatticusWeb`` cannot restack ThinTurn onto the no-op starter. Does not deploy Computers. Staging and
 * production stay no-op.
 */
function lookupComputersHostStart(
  scope: Construct,
): ComputerHostStartEcsConfig | undefined {
  try {
    const outputs = computersStackOutputs(scope);
    const cluster = outputs.ComputerClusterName;
    const repositoryUri = outputs.ComputerRepositoryUri;
    const subnets = (outputs.ComputerSubnetIds || "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const securityGroupId = outputs.ComputerSecurityGroupId;
    if (!cluster || !repositoryUri || subnets.length === 0 || !securityGroupId) {
      return undefined;
    }
    const repository = computerRepositoryArn(scope, repositoryUri);
    return {
      cluster,
      subnets,
      securityGroups: [securityGroupId],
      computerRepositoryName: repository.repositoryName,
      computerRepositoryArn: repository.repositoryArn,
      computerImageUri: repository.imageUri,
    };
  } catch {
    return undefined;
  }
}

/**
 * Development-only ECS host start wiring.
 *
 * Prefer explicit ``-c computerHostStart=ecs`` plus cluster/task/network/role
 * values. If those are omitted, look up the live ChatticusComputers stack so a
 * later ChatticusWeb deploy (which restacks ThinTurn) cannot drop RunTask.
 * Pass ``-c computerHostStart=noop`` to force the no-op starter.
 */
export function computerHostStartEcsConfig(
  scope: Construct,
  environmentName: ChatticusCloudEnvironment,
): ComputerHostStartEcsConfig | undefined {
  if (environmentName !== "development") {
    return undefined;
  }
  if (contextString(scope, "computerHostStart") === "noop") {
    return undefined;
  }
  return configFromContext(scope) || lookupComputersHostStart(scope);
}

/**
 * Starter-side ECS wiring only: the cluster, network and container name the starter runs tasks in, ecs:TagResource on
 * the tasks it starts, and sts:AssumeRole into customer-account computer roles. It names no task definition and passes
 * no role: the owner task definition is wired by {@link wireComputerStarterOwnerRunTask}. Grants the computer's task
 * role nothing.
 */
export function wireComputerStarterEcsRunTask(
  computerWorkerFunction: lambda.Function,
  stack: cdk.Stack,
  config: ComputerHostStartEcsConfig,
): void {
  const environment: Record<string, string> = {
    CHATTICUS_HOST_STARTER: "ecs",
    CHATTICUS_ECS_CLUSTER: config.cluster,
    CHATTICUS_ECS_SUBNETS: config.subnets.join(","),
    CHATTICUS_ECS_CONTAINER_NAME: "computer",
  };
  if (config.securityGroups.length > 0) {
    environment.CHATTICUS_ECS_SECURITY_GROUPS = config.securityGroups.join(",");
  }
  for (const [key, value] of Object.entries(environment)) {
    computerWorkerFunction.addEnvironment(key, value);
  }
  computerWorkerFunction.addEnvironment(
    "CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID",
    stack.account,
  );

  computerWorkerFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["ecs:TagResource"],
      resources: [
        `arn:aws:ecs:${stack.region}:${stack.account}:task/${config.cluster}/*`,
      ],
    }),
  );
  computerWorkerFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["sts:AssumeRole"],
      resources: ["arn:aws:iam::*:role/ChatticusOrganizationComputerRole"],
    }),
  );
}

function ownerConfigFromContext(
  scope: Construct,
): ComputerOwnerStartConfig | undefined {
  const taskDefinition = contextString(scope, "computerOwnerTaskDefinition");
  const taskRoleArn = contextString(scope, "computerOwnerTaskRoleArn");
  const executionRoleArn = contextString(scope, "computerOwnerExecutionRoleArn");
  const snapshotBucketName = contextString(scope, "computerSnapshotBucketName");
  if (!taskDefinition || !taskRoleArn || !executionRoleArn || !snapshotBucketName) {
    return undefined;
  }
  return { taskDefinition, taskRoleArn, executionRoleArn, snapshotBucketName };
}

function lookupComputersOwnerStart(
  scope: Construct,
): ComputerOwnerStartConfig | undefined {
  try {
    const outputs = computersStackOutputs(scope);
    const taskDefinition = outputs.ComputerOwnerTaskDefinitionArn;
    const taskRoleArn = outputs.ComputerOwnerTaskRoleArn;
    const executionRoleArn = outputs.ComputerOwnerExecutionRoleArn;
    const snapshotBucketName = outputs.ComputerSnapshotBucketName;
    if (!taskDefinition || !taskRoleArn || !executionRoleArn || !snapshotBucketName) {
      return undefined;
    }
    return { taskDefinition, taskRoleArn, executionRoleArn, snapshotBucketName };
  } catch {
    return undefined;
  }
}

/**
 * Development-only owner task wiring. Explicit ``-c computerOwner*`` context
 * values win; otherwise the owner outputs of the live ChatticusComputers stack
 * are read at synth time. Returns undefined until the Computers stack has been
 * deployed with the owner task definition, which leaves host-worker wiring as
 * it was. After any Computers stack change, redeploy the ControlPlane stack so
 * it re-reads these outputs.
 */
export function computerOwnerStartConfig(
  scope: Construct,
  environmentName: ChatticusCloudEnvironment,
): ComputerOwnerStartConfig | undefined {
  if (environmentName !== "development") {
    return undefined;
  }
  if (contextString(scope, "computerHostStart") === "noop") {
    return undefined;
  }
  return ownerConfigFromContext(scope) || lookupComputersOwnerStart(scope);
}

/** The control-plane resources the scoped owner role may touch. */
export interface ComputerOwnerStorage {
  readonly messagingTable: dynamodb.ITable;
  readonly conversationsTable: dynamodb.ITable;
  readonly piSessionsBucket: s3.IBucket;
}

/** The two roles only the credential broker assumes. */
export interface ComputerOwnerRoles {
  /** Per turn: the Pi session and conversation items of one conversation, assumed with five session tags. */
  readonly scopedRole: iam.Role;
  /** Per owner: the snapshot objects of one computer, assumed with two session tags. */
  readonly supervisorRole: iam.Role;
}

function brokerAssumedRole(
  stack: cdk.Stack,
  id: string,
  brokerRole: iam.IRole,
  tagKeys: readonly string[],
  description: string,
): iam.Role {
  const role = new iam.Role(stack, id, {
    assumedBy: new iam.PrincipalWithConditions(brokerRole, ownerSessionTagConditions(tagKeys)),
    maxSessionDuration: cdk.Duration.seconds(OWNER_SCOPED_ROLE_MAX_SESSION_SECONDS),
    description,
  });
  role.assumeRolePolicy!.addStatements(
    new iam.PolicyStatement({
      principals: [brokerRole],
      actions: ["sts:TagSession"],
      conditions: ownerSessionTagConditions(tagKeys),
    }),
  );
  return role;
}

/**
 * Creates the two roles of an owner, makes the credential broker the only principal they trust, gives the broker the
 * role ARNs and the right to assume them, and wires the starter to the owner task definition.
 *
 * The per-turn role carries one static permission policy written with aws:PrincipalTag policy variables (see
 * owner-role-policy.ts and the file it reads): DynamoDB and S3 access narrowed to the session named by five session
 * tags. The supervisor role carries one statement: get, put and abort of multipart upload on the snapshot objects of the
 * one computer its two session tags name. Each trust policy lets only the broker's execution role assume the role, with
 * sts:AssumeRole and sts:TagSession, only when every one of its tags is set and no other tag is, for at most one hour.
 * The broker passes the tags and no session policy. The starter holds no right to assume either role, and the owner task
 * role itself stays empty.
 *
 * @param computerWorkerFunction The starter.
 * @param stack The stack the roles belong to.
 * @param hostConfig The cluster the starter runs the owner task in.
 * @param ownerConfig The owner task definition and the snapshot bucket.
 * @param storage The control-plane stores the per-turn role may touch.
 * @param brokerFunction The credential broker: its execution role is the trust principal.
 * @returns The two roles.
 */
export function wireComputerStarterOwnerRunTask(
  computerWorkerFunction: lambda.Function,
  stack: cdk.Stack,
  hostConfig: ComputerHostStartEcsConfig,
  ownerConfig: ComputerOwnerStartConfig,
  storage: ComputerOwnerStorage,
  brokerFunction: lambda.Function,
): ComputerOwnerRoles {
  const brokerRole = brokerFunction.role!;
  const scopedRole = brokerAssumedRole(
    stack,
    "ComputerOwnerScopedRole",
    brokerRole,
    OWNER_SESSION_TAG_KEYS,
    "One conversation of the organization computer: the credential broker assumes it per turn with session tags that its static policy reads.",
  );
  const supervisorRole = brokerAssumedRole(
    stack,
    "ComputerSupervisorRole",
    brokerRole,
    SUPERVISOR_SESSION_TAG_KEYS,
    "The supervisor of the organization computer: the credential broker assumes it per owner with session tags that confine it to one snapshot prefix.",
  );
  const snapshotBucket = s3.Bucket.fromBucketName(
    stack,
    "ComputerOwnerSnapshotBucket",
    ownerConfig.snapshotBucketName,
  );
  for (const statement of ownerRolePolicyStatements({
    piSessionsBucketArn: storage.piSessionsBucket.bucketArn,
    snapshotBucketArn: snapshotBucket.bucketArn,
    conversationsTableArn: storage.conversationsTable.tableArn,
    messagingTableArn: storage.messagingTable.tableArn,
  })) {
    scopedRole.addToPolicy(statement);
  }
  for (const statement of supervisorRolePolicyStatements({ snapshotBucketArn: snapshotBucket.bucketArn })) {
    supervisorRole.addToPolicy(statement);
  }

  brokerFunction.addEnvironment("CHATTICUS_OWNER_SCOPED_ROLE_ARN", scopedRole.roleArn);
  brokerFunction.addEnvironment("CHATTICUS_OWNER_SUPERVISOR_ROLE_ARN", supervisorRole.roleArn);
  brokerFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["sts:AssumeRole", "sts:TagSession"],
      resources: [scopedRole.roleArn, supervisorRole.roleArn],
    }),
  );

  const environment: Record<string, string> = {
    CHATTICUS_OWNER_TASK_DEFINITION: ownerConfig.taskDefinition,
    CHATTICUS_OWNER_CONTAINER_NAME: "computer",
    CHATTICUS_OWNER_COMMAND: OWNER_CONTAINER_COMMAND,
    CHATTICUS_SNAPSHOT_BUCKET: ownerConfig.snapshotBucketName,
  };
  for (const [key, value] of Object.entries(environment)) {
    computerWorkerFunction.addEnvironment(key, value);
  }

  const ownerFamily = ownerConfig.taskDefinition.includes("/")
    ? ownerConfig.taskDefinition.split("/").pop()!.split(":")[0]
    : ownerConfig.taskDefinition.split(":")[0];
  computerWorkerFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["ecs:RunTask"],
      resources: [
        `arn:aws:ecs:${stack.region}:${stack.account}:task-definition/${ownerFamily}:*`,
      ],
      conditions: {
        ArnEquals: {
          "ecs:cluster": `arn:aws:ecs:${stack.region}:${stack.account}:cluster/${hostConfig.cluster}`,
        },
      },
    }),
  );
  computerWorkerFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["iam:PassRole"],
      resources: [ownerConfig.taskRoleArn, ownerConfig.executionRoleArn],
      conditions: {
        StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" },
      },
    }),
  );
  return { scopedRole, supervisorRole };
}

