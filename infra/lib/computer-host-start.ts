import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { ChatticusCloudEnvironment } from "./environments";

export interface ComputerHostStartEcsConfig {
  readonly cluster: string;
  readonly taskDefinition: string;
  readonly subnets: string[];
  readonly securityGroups: string[];
  readonly executionRoleArn: string;
  readonly taskRoleArn: string;
  readonly computerRepositoryName: string;
  readonly computerRepositoryArn: string;
  readonly computerImageUri: string;
}

/** Longest session the scoped owner role may be assumed for, in seconds. */
export const OWNER_SCOPED_ROLE_MAX_SESSION_SECONDS = 3600;

/** Container command the starter runs in the owner task definition. */
export const OWNER_CONTAINER_COMMAND = "node /opt/chatticus/host/owner.mjs";

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
  const taskDefinition = contextString(scope, "computerEcsTaskDefinition");
  const subnets = contextCsv(scope, "computerEcsSubnets");
  const executionRoleArn = contextString(scope, "computerEcsExecutionRoleArn");
  const taskRoleArn = contextString(scope, "computerEcsTaskRoleArn");
  const repositoryUri = contextString(scope, "computerEcrRepositoryUri");
  if (
    !cluster ||
    !taskDefinition ||
    subnets.length === 0 ||
    !executionRoleArn ||
    !taskRoleArn ||
    !repositoryUri
  ) {
    return undefined;
  }
  const repository = computerRepositoryArn(scope, repositoryUri);
  return {
    cluster,
    taskDefinition,
    subnets,
    securityGroups: contextCsv(scope, "computerEcsSecurityGroups"),
    executionRoleArn,
    taskRoleArn,
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

/**
 * Read ChatticusComputers outputs and the Fargate service network at synth
 * time so ``cdk deploy ChatticusWeb`` cannot restack ThinTurn onto the no-op
 * starter. Does not deploy Computers. Staging and production stay no-op.
 */
function lookupComputersHostStart(
  scope: Construct,
): ComputerHostStartEcsConfig | undefined {
  const region =
    cdk.Stack.of(scope).region ||
    process.env.AWS_DEFAULT_REGION ||
    process.env.AWS_REGION ||
    "us-east-1";
  try {
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
    const cluster = outputs.ComputerClusterName;
    const taskDefinition = outputs.ComputerTaskDefinitionArn;
    const service = outputs.ComputerServiceName;
    const repositoryUri = outputs.ComputerRepositoryUri;
    if (!cluster || !taskDefinition || !service || !repositoryUri) {
      return undefined;
    }
    const described = awsJson([
      "ecs",
      "describe-services",
      "--cluster",
      cluster,
      "--services",
      service,
      "--region",
      region,
      "--output",
      "json",
    ]) as {
      services?: Array<{
        networkConfiguration?: {
          awsvpcConfiguration?: {
            subnets?: string[];
            securityGroups?: string[];
          };
        };
      }>;
    };
    const network =
      described.services?.[0]?.networkConfiguration?.awsvpcConfiguration;
    const subnets = network?.subnets || [];
    const securityGroups = network?.securityGroups || [];
    const roles = awsJson([
      "ecs",
      "describe-task-definition",
      "--task-definition",
      taskDefinition,
      "--region",
      region,
      "--query",
      "{executionRoleArn:taskDefinition.executionRoleArn,taskRoleArn:taskDefinition.taskRoleArn}",
      "--output",
      "json",
    ]) as { executionRoleArn?: string; taskRoleArn?: string };
    if (
      subnets.length === 0 ||
      !roles.executionRoleArn ||
      !roles.taskRoleArn
    ) {
      return undefined;
    }
    const repository = computerRepositoryArn(scope, repositoryUri);
    return {
      cluster,
      taskDefinition,
      subnets,
      securityGroups,
      executionRoleArn: roles.executionRoleArn,
      taskRoleArn: roles.taskRoleArn,
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
 * Starter-side ECS wiring only: environment variables, ecs:RunTask,
 * ecs:TagResource, iam:PassRole and sts:AssumeRole. Grants the computer's
 * task role nothing.
 */
export function wireComputerStarterEcsRunTask(
  computerWorkerFunction: lambda.Function,
  stack: cdk.Stack,
  config: ComputerHostStartEcsConfig,
): void {
  const environment: Record<string, string> = {
    CHATTICUS_HOST_STARTER: "ecs",
    CHATTICUS_ECS_CLUSTER: config.cluster,
    CHATTICUS_ECS_TASK_DEFINITION: config.taskDefinition,
    CHATTICUS_ECS_SUBNETS: config.subnets.join(","),
    CHATTICUS_ECS_CONTAINER_NAME: "computer",
    CHATTICUS_ECS_HOST_COMMAND: "node /opt/chatticus/host/host-worker.mjs",
  };
  if (contextString(stack, "computerHostCommand") === "default") {
    delete environment.CHATTICUS_ECS_HOST_COMMAND;
  }
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

  const taskDefinitionFamily = config.taskDefinition.includes("/")
    ? config.taskDefinition.split("/").pop()!.split(":")[0]
    : config.taskDefinition.split(":")[0];
  const taskDefinitionArn = `arn:aws:ecs:${stack.region}:${stack.account}:task-definition/${taskDefinitionFamily}:*`;
  const clusterArn = `arn:aws:ecs:${stack.region}:${stack.account}:cluster/${config.cluster}`;

  computerWorkerFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["ecs:RunTask"],
      resources: [taskDefinitionArn],
      conditions: {
        ArnEquals: {
          "ecs:cluster": clusterArn,
        },
      },
    }),
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
      actions: ["iam:PassRole"],
      resources: [config.executionRoleArn, config.taskRoleArn],
      conditions: {
        StringEquals: {
          "iam:PassedToService": "ecs-tasks.amazonaws.com",
        },
      },
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
  const region =
    cdk.Stack.of(scope).region ||
    process.env.AWS_DEFAULT_REGION ||
    process.env.AWS_REGION ||
    "us-east-1";
  try {
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

/**
 * Wires the starter to the Pi session owner task definition and returns the
 * scoped role. The role is the permission ceiling: DynamoDB read and write on
 * the Messaging and Conversations tables and their indexes, S3 read and write
 * on the Pi sessions bucket and the snapshot bucket, nothing else. Only the
 * starter's execution role may assume it, for at most one hour, and the starter
 * narrows each session with a session policy. The owner task role itself stays
 * empty.
 */
export function wireComputerStarterOwnerRunTask(
  computerWorkerFunction: lambda.Function,
  stack: cdk.Stack,
  hostConfig: ComputerHostStartEcsConfig,
  ownerConfig: ComputerOwnerStartConfig,
  storage: ComputerOwnerStorage,
): iam.Role {
  const scopedRole = new iam.Role(stack, "ComputerOwnerScopedRole", {
    assumedBy: computerWorkerFunction.role!,
    maxSessionDuration: cdk.Duration.seconds(OWNER_SCOPED_ROLE_MAX_SESSION_SECONDS),
    description:
      "Ceiling for one Pi session owner: the starter assumes it with a per-session policy.",
  });
  storage.messagingTable.grantReadWriteData(scopedRole);
  storage.conversationsTable.grantReadWriteData(scopedRole);
  storage.piSessionsBucket.grantReadWrite(scopedRole);
  s3.Bucket.fromBucketName(
    stack,
    "ComputerOwnerSnapshotBucket",
    ownerConfig.snapshotBucketName,
  ).grantReadWrite(scopedRole);

  const environment: Record<string, string> = {
    CHATTICUS_OWNER_TASK_DEFINITION: ownerConfig.taskDefinition,
    CHATTICUS_OWNER_CONTAINER_NAME: "computer",
    CHATTICUS_OWNER_COMMAND: OWNER_CONTAINER_COMMAND,
    CHATTICUS_OWNER_SCOPED_ROLE_ARN: scopedRole.roleArn,
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
  scopedRole.grantAssumeRole(computerWorkerFunction.grantPrincipal);
  return scopedRole;
}
