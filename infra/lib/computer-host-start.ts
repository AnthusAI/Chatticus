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

/**
 * Development-only ECS host start wiring from CDK context.
 *
 * Pass ``-c computerHostStart=ecs`` plus cluster/task/network/role values at
 * deploy time. Staging and production stay on the no-op starter.
 */
export function computerHostStartEcsConfig(
  scope: Construct,
  environmentName: ChatticusCloudEnvironment,
): ComputerHostStartEcsConfig | undefined {
  if (environmentName !== "development") {
    return undefined;
  }
  if (contextString(scope, "computerHostStart") !== "ecs") {
    return undefined;
  }

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
  };
  if (config.securityGroups.length > 0) {
    environment.CHATTICUS_ECS_SECURITY_GROUPS = config.securityGroups.join(",");
  }
  for (const [key, value] of Object.entries(environment)) {
    computerWorkerFunction.addEnvironment(key, value);
  }

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

  const hostTaskRole = iam.Role.fromRoleArn(
    stack,
    "ImportedComputerHostTaskRole",
    config.taskRoleArn,
    { mutable: true },
  );
  table.grantReadWriteData(hostTaskRole);
  computerTurnQueue.grantConsumeMessages(hostTaskRole);
}
