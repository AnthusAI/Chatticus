import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { Construct } from "constructs";
import {
  ChatticusCloudEnvironment,
  integrationTestParameterPrefix,
  thinTurnParameterPrefix,
  THIN_TURN_STACK_IDS,
} from "./environments";
import { CHATTICUS_LOG_RETENTION } from "./log-retention";

export interface IntegrationTestStackProps extends cdk.StackProps {
  /** Named environment whose thin-turn stack this runner exercises. */
  integrationTestEnvironment: ChatticusCloudEnvironment;
}

/**
 * Scheduled Lambda smoke tests against one named thin-turn environment.
 *
 * Does not run Fargate computer hosts. Deploy with:
 * ``cdk deploy ChatticusIntegrationTest -c integrationTestEnvironment=development``
 * or ``... integrationTestEnvironment=staging``. Production is not supported.
 */
export class IntegrationTestStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: IntegrationTestStackProps) {
    super(scope, id, props);

    const environmentName = props.integrationTestEnvironment;
    if (environmentName === "production") {
      throw new Error(
        "ChatticusIntegrationTest does not target production in v1.",
      );
    }

    const thinTurnStackName = THIN_TURN_STACK_IDS[environmentName];
    const thinTurnPrefix = thinTurnParameterPrefix(environmentName);
    const integrationPrefix = integrationTestParameterPrefix(environmentName);
    const pythonRoot = path.join(__dirname, "../../python");

    const invokeSecretArnParam = ssm.StringParameter.fromStringParameterName(
      this,
      "InvokeKeySecretArnParam",
      `${thinTurnPrefix}/invoke-key-secret-arn`,
    );
    const invokeSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      "InvokeKeySecret",
      invokeSecretArnParam.stringValue,
    );
    const turnQueueArnParam = ssm.StringParameter.fromStringParameterName(
      this,
      "TurnQueueArnParam",
      `${thinTurnPrefix}/turn-queue-arn`,
    );
    const computerTurnQueueArnParam = ssm.StringParameter.fromStringParameterName(
      this,
      "ComputerTurnQueueArnParam",
      `${thinTurnPrefix}/computer-turn-queue-arn`,
    );

    const runnerFunction = new lambda.Function(this, "Runner", {
      functionName: `chatticus-${environmentName}-integration-test`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "chatticus.integration_test.lambda_handler.handler",
      architecture: lambda.Architecture.X86_64,
      memorySize: 1024,
      logRetention: CHATTICUS_LOG_RETENTION,
      timeout: cdk.Duration.seconds(900),
      description: `Smoke-tier live integration test for the ${environmentName} thin turn.`,
      environment: {
        CHATTICUS_INTEGRATION_TEST_ENVIRONMENT: environmentName,
        CHATTICUS_INTEGRATION_TEST_TENANT_ID: "integration-test",
        CHATTICUS_INTEGRATION_TEST_USER_ID: "integration-test-runner",
      },
      code: lambda.Code.fromAsset(pythonRoot, {
        bundling: {
          image: lambda.Runtime.PYTHON_3_12.bundlingImage,
          command: [
            "bash",
            "-c",
            "pip install . httpx 'PyJWT[crypto]' botocore boto3 -t /asset-output",
          ],
          local: {
            tryBundle(outputDir: string): boolean {
              try {
                execSync(
                  [
                    "pip install",
                    "--platform manylinux2014_x86_64",
                    "--implementation cp",
                    "--python-version 3.12",
                    "--only-binary=:all:",
                    "httpx 'PyJWT[crypto]' botocore boto3",
                    `-t ${outputDir}`,
                  ].join(" "),
                  { cwd: pythonRoot, stdio: "inherit" },
                );
                copyDir(
                  path.join(pythonRoot, "src/chatticus"),
                  path.join(outputDir, "chatticus"),
                );
                return true;
              } catch {
                return false;
              }
            },
          },
        },
      }),
    });

    invokeSecret.grantRead(runnerFunction);
    runnerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${thinTurnPrefix}/*`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter${integrationPrefix}/*`,
        ],
      }),
    );
    runnerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cloudformation:DescribeStacks"],
        resources: [
          `arn:aws:cloudformation:${this.region}:${this.account}:stack/${thinTurnStackName}/*`,
        ],
      }),
    );

    const turnQueue = sqs.Queue.fromQueueArn(
      this,
      "TurnQueue",
      turnQueueArnParam.stringValue,
    );
    turnQueue.grantConsumeMessages(runnerFunction);
    const computerTurnQueue = sqs.Queue.fromQueueArn(
      this,
      "ComputerTurnQueue",
      computerTurnQueueArnParam.stringValue,
    );
    computerTurnQueue.grantConsumeMessages(runnerFunction);

    new ssm.StringParameter(this, "AllowedRoleArnParameter", {
      parameterName: `${integrationPrefix}/allowed-role-arn`,
      stringValue: runnerFunction.role!.roleArn,
      description: `Allowed IAM role for ${environmentName} integration-test session exchange.`,
    });
    new ssm.StringParameter(this, "TenantIdParameter", {
      parameterName: `${integrationPrefix}/tenant-id`,
      stringValue: "integration-test",
      description: `Tenant id for ${environmentName} integration-test bearer tokens.`,
    });
    new ssm.StringParameter(this, "UserIdParameter", {
      parameterName: `${integrationPrefix}/user-id`,
      stringValue: "integration-test-runner",
      description: `User id for ${environmentName} integration-test bearer tokens.`,
    });

    const scheduleGroupName = `chatticus-${environmentName}-integration-test`;
    const scheduleGroup = new scheduler.CfnScheduleGroup(this, "ScheduleGroup", {
      name: scheduleGroupName,
    });
    const schedulerRole = new iam.Role(this, "SchedulerRole", {
      roleName: `chatticus-${environmentName}-integration-test-scheduler`,
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });
    runnerFunction.grantInvoke(schedulerRole);
    new scheduler.CfnSchedule(this, "DailySmokeSchedule", {
      name: `chatticus-${environmentName}-integration-test-smoke`,
      groupName: scheduleGroup.name ?? scheduleGroupName,
      scheduleExpression: "cron(0 7 * * ? *)",
      scheduleExpressionTimezone: "UTC",
      flexibleTimeWindow: { mode: "OFF" },
      target: {
        arn: runnerFunction.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ tier: "smoke" }),
      },
    });
    scheduleGroup.node.addDependency(runnerFunction);

    new cdk.CfnOutput(this, "IntegrationTestEnvironment", {
      value: environmentName,
    });
    new cdk.CfnOutput(this, "IntegrationTestFunctionName", {
      value: runnerFunction.functionName,
    });
    new cdk.CfnOutput(this, "IntegrationTestRoleArn", {
      value: runnerFunction.role!.roleArn,
    });
  }
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}
