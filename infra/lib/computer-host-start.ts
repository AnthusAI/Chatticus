import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { ChatticusCloudEnvironment } from "./environments";

export interface ComputerHostStartEcsConfig {
  readonly cluster: string;
  readonly taskDefinition: string;
  readonly subnets: string[];
  readonly securityGroups: string[];
  readonly executionRoleArn: string;
  readonly taskRoleArn: string;
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

function configFromContext(
  scope: Construct,
): ComputerHostStartEcsConfig | undefined {
  const cluster = contextString(scope, "computerEcsCluster");
  const taskDefinition = contextString(scope, "computerEcsTaskDefinition");
  const subnets = contextCsv(scope, "computerEcsSubnets");
  const executionRoleArn = contextString(scope, "computerEcsExecutionRoleArn");
  const taskRoleArn = contextString(scope, "computerEcsTaskRoleArn");
  if (
    !cluster ||
    !taskDefinition ||
    subnets.length === 0 ||
    !executionRoleArn ||
    !taskRoleArn
  ) {
    return undefined;
  }
  return {
    cluster,
    taskDefinition,
    subnets,
    securityGroups: contextCsv(scope, "computerEcsSecurityGroups"),
    executionRoleArn,
    taskRoleArn,
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
    if (!cluster || !taskDefinition || !service) {
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
    return {
      cluster,
      taskDefinition,
      subnets,
      securityGroups,
      executionRoleArn: roles.executionRoleArn,
      taskRoleArn: roles.taskRoleArn,
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

export function wireComputerWorkerEcsHostStart(
  computerWorkerFunction: lambda.Function,
  stack: cdk.Stack,
  config: ComputerHostStartEcsConfig,
  table: dynamodb.ITable,
  computerTurnQueue: sqs.IQueue,
): void {
  const environment: Record<string, string> = {
    CHATTICUS_HOST_STARTER: "ecs",
    CHATTICUS_ECS_CLUSTER: config.cluster,
    CHATTICUS_ECS_TASK_DEFINITION: config.taskDefinition,
    CHATTICUS_ECS_SUBNETS: config.subnets.join(","),
    CHATTICUS_ECS_CONTAINER_NAME: "computer",
    CHATTICUS_ECS_HOST_COMMAND: "python -m chatticus.computer_host_worker",
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

  const hostTaskRole = iam.Role.fromRoleArn(
    stack,
    "ImportedComputerHostTaskRole",
    config.taskRoleArn,
    { mutable: true },
  );
  table.grantReadWriteData(hostTaskRole);
  computerTurnQueue.grantConsumeMessages(hostTaskRole);
}
