import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { Construct } from "constructs";
import {
  computerHostStartEcsConfig,
  wireComputerWorkerEcsHostStart,
} from "./computer-host-start";
import {
  ChatticusCloudEnvironment,
  integrationTestParameterPrefix,
  openAiApiKeyParameterName,
  signupModeForEnvironment,
  thinTurnExportName,
  thinTurnParameterPrefix,
  webParameterPrefix,
} from "./environments";
import { CHATTICUS_LOG_RETENTION } from "./log-retention";

const LAMBDA_WEB_ADAPTER_LAYER_VERSION = 28;

/**
 * Zero-idle computerless turn: DynamoDB, SQS, Lambda Web Adapter SSE.
 *
 * The public CloudFront distribution lives in the web stack; this stack
 * exports the Lambda function URL for the /api/* origin.
 *
 * Do not put a load balancer in front of this stack.
 */
export interface ThinTurnStackProps extends cdk.StackProps {
  chatticusEnvironment: ChatticusCloudEnvironment;
  /** When set, budget alert recorder and rollup threshold SNS use this topic. */
  budgetsAlertsTopicArn?: string;
  /** Account monthly AWS budget limit; required for the daily rollup Lambda. */
  budgetsMonthlyLimitUsd?: number;
}

export class ThinTurnStack extends cdk.Stack {
  readonly frontDoorFunctionUrl: lambda.FunctionUrl;
  readonly invokeSecret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: ThinTurnStackProps) {
    super(scope, id, props);

    const environmentName = props.chatticusEnvironment;
    const parameterPrefix = thinTurnParameterPrefix(environmentName);
    const webPrefix = webParameterPrefix(environmentName);
    const integrationPrefix = integrationTestParameterPrefix(environmentName);
    const openAiParameterName = openAiApiKeyParameterName(environmentName);
    const retainData = environmentName !== "development";
    cdk.Tags.of(this).add("chatticus:environment", environmentName);

    const pythonRoot = path.join(__dirname, "../../python");
    const lambdaWebAdapterLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      "LambdaWebAdapterLayer",
      `arn:aws:lambda:${this.region}:753240598075:layer:LambdaAdapterLayerX86:${LAMBDA_WEB_ADAPTER_LAYER_VERSION}`,
    );

    const dataRetention = retainData
      ? cdk.RemovalPolicy.RETAIN
      : cdk.RemovalPolicy.DESTROY;

    const table = new dynamodb.Table(this, "Messaging", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expires_at",
      removalPolicy: dataRetention,
    });

    const turnQueue = new sqs.Queue(this, "TurnJobs", {
      visibilityTimeout: cdk.Duration.seconds(180),
      removalPolicy: dataRetention,
    });
    const computerTurnQueue = new sqs.Queue(this, "ComputerTurnJobs", {
      visibilityTimeout: cdk.Duration.seconds(180),
      removalPolicy: dataRetention,
    });

    const invokeSecret = new secretsmanager.Secret(this, "InvokeKey", {
      description: `Shared invoke key for the Chatticus ${environmentName} thin-turn front door.`,
      removalPolicy: dataRetention,
      generateSecretString: {
        passwordLength: 32,
        excludePunctuation: true,
      },
    });
    this.invokeSecret = invokeSecret;

    const openaiParameter = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      "OpenAiKey",
      { parameterName: openAiParameterName },
    );

    const httpCode = lambda.Code.fromAsset(pythonRoot, {
      bundling: {
        image: lambda.Runtime.PYTHON_3_12.bundlingImage,
        command: [
          "bash",
          "-c",
          [
            "pip install . fastapi uvicorn 'pydantic>=2' httpx python-dotenv 'PyJWT[crypto]' -t /asset-output",
            "cp lambda/run.sh /asset-output/run.sh",
            "chmod +x /asset-output/run.sh",
          ].join(" && "),
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
                  "fastapi uvicorn 'pydantic>=2' httpx python-dotenv 'PyJWT[crypto]'",
                  `-t ${outputDir}`,
                ].join(" "),
                { cwd: pythonRoot, stdio: "inherit" },
              );
              copyDir(
                path.join(pythonRoot, "src/chatticus"),
                path.join(outputDir, "chatticus"),
              );
              fs.copyFileSync(
                path.join(pythonRoot, "lambda/run.sh"),
                path.join(outputDir, "run.sh"),
              );
              fs.chmodSync(path.join(outputDir, "run.sh"), 0o755);
              return true;
            } catch {
              return false;
            }
          },
        },
      },
    });

    const turnDeadlineScheduleGroupName = `chatticus-${environmentName}-turn-deadlines`;
    const turnDeadlineFunctionName = `chatticus-${environmentName}-turn-deadline`;
    const turnDeadlineSchedulerRoleName = `chatticus-${environmentName}-turn-deadline-scheduler`;
    const turnDeadlineTargetArn = cdk.Stack.of(this).formatArn({
      service: "lambda",
      resource: "function",
      resourceName: turnDeadlineFunctionName,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });
    const turnDeadlineSchedulerRoleArn = `arn:aws:iam::${this.account}:role/${turnDeadlineSchedulerRoleName}`;
    const turnDeadlineScheduleGroup = new scheduler.CfnScheduleGroup(
      this,
      "TurnDeadlineGroup",
      { name: turnDeadlineScheduleGroupName },
    );

    const sharedEnv: Record<string, string> = {
      CHATTICUS_ENVIRONMENT: environmentName,
      CHATTICUS_MESSAGING_TABLE: table.tableName,
      CHATTICUS_TURN_QUEUE_URL: turnQueue.queueUrl,
      CHATTICUS_COMPUTER_TURN_QUEUE_URL: computerTurnQueue.queueUrl,
      CHATTICUS_SIGNUP_MODE: signupModeForEnvironment(environmentName),
      OPENAI_MODEL: "gpt-5.6-luna",
      OPENAI_API_KEY_PARAMETER: openAiParameterName,
    };

    const turnDeadlineSchedulerEnv: Record<string, string> = {
      CHATTICUS_TURN_DEADLINE_SCHEDULE_GROUP: turnDeadlineScheduleGroupName,
      CHATTICUS_TURN_DEADLINE_TARGET_ARN: turnDeadlineTargetArn,
      CHATTICUS_TURN_DEADLINE_ROLE_ARN: turnDeadlineSchedulerRoleArn,
    };

    const httpFunction = new lambda.Function(this, "FrontDoor", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "run.sh",
      architecture: lambda.Architecture.X86_64,
      memorySize: 512,
      logRetention: CHATTICUS_LOG_RETENTION,
      timeout: cdk.Duration.seconds(900),
      layers: [lambdaWebAdapterLayer],
      description: "Per-request Chatticus HTTP front door with turn-scoped SSE.",
      environment: {
        ...sharedEnv,
        ...turnDeadlineSchedulerEnv,
        AWS_LAMBDA_EXEC_WRAPPER: "/opt/bootstrap",
        AWS_LWA_INVOKE_MODE: "response_stream",
        AWS_LWA_PORT: "8080",
        AWS_LWA_READINESS_CHECK_PATH: "/health",
        CHATTICUS_INVOKE_KEY: invokeSecret.secretValue.unsafeUnwrap(),
        ...(environmentName !== "production"
          ? { CHATTICUS_INTEGRATION_TEST_ENABLED: "1" }
          : {}),
      },
      code: httpCode,
    });

    const deadlineFunction = new lambda.Function(this, "TurnDeadline", {
      functionName: turnDeadlineFunctionName,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "chatticus.deadline.lambda_handler.handler",
      architecture: lambda.Architecture.X86_64,
      memorySize: 256,
      logRetention: CHATTICUS_LOG_RETENTION,
      timeout: cdk.Duration.seconds(60),
      description:
        "EventBridge Scheduler target: recover wedged turns without an always-on reaper.",
      environment: { ...sharedEnv, ...turnDeadlineSchedulerEnv },
      code: httpCode,
    });
    table.grantReadWriteData(deadlineFunction);
    turnQueue.grantSendMessages(deadlineFunction);
    computerTurnQueue.grantSendMessages(deadlineFunction);

    const schedulerInvokeRole = new iam.Role(this, "TurnDeadlineSchedulerRole", {
      roleName: turnDeadlineSchedulerRoleName,
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });
    deadlineFunction.grantInvoke(schedulerInvokeRole);

    const turnDeadlineScheduleArn = `arn:aws:scheduler:${this.region}:${this.account}:schedule/${turnDeadlineScheduleGroupName}/*`;
    const manageTurnDeadlineSchedules = new iam.PolicyStatement({
      actions: [
        "scheduler:CreateSchedule",
        "scheduler:UpdateSchedule",
        "scheduler:DeleteSchedule",
        "scheduler:GetSchedule",
      ],
      resources: [turnDeadlineScheduleArn],
    });
    const passSchedulerInvokeRole = new iam.PolicyStatement({
      actions: ["iam:PassRole"],
      resources: [turnDeadlineSchedulerRoleArn],
      conditions: {
        StringEquals: {
          "iam:PassedToService": "scheduler.amazonaws.com",
        },
      },
    });

    table.grantReadWriteData(httpFunction);
    turnQueue.grantSendMessages(httpFunction);
    computerTurnQueue.grantSendMessages(httpFunction);
    openaiParameter.grantRead(httpFunction);
    httpFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${openAiParameterName}`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter${webPrefix}/cognito-user-pool-id`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter${webPrefix}/cognito-app-client-id`,
          ...(environmentName !== "production"
            ? [
                `arn:aws:ssm:${this.region}:${this.account}:parameter${integrationPrefix}/*`,
              ]
            : []),
        ],
      }),
    );
    httpFunction.addToRolePolicy(manageTurnDeadlineSchedules);
    httpFunction.addToRolePolicy(passSchedulerInvokeRole);

    deadlineFunction.addToRolePolicy(manageTurnDeadlineSchedules);
    deadlineFunction.addToRolePolicy(passSchedulerInvokeRole);

    const functionUrl = httpFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
      cors: {
        allowedOrigins: ["*"],
        allowedMethods: [
          lambda.HttpMethod.GET,
          lambda.HttpMethod.POST,
          lambda.HttpMethod.HEAD,
        ],
        allowedHeaders: [
          "content-type",
          "x-tenant-id",
          "x-chatticus-invoke-key",
          "last-event-id",
          "idempotency-key",
          "cache-control",
        ],
        exposedHeaders: ["*"],
      },
    });
    this.frontDoorFunctionUrl = functionUrl;

    const cloudFrontUrlParameterName = `${parameterPrefix}/cloudfront-url`;
    const functionUrlParameterName = `${parameterPrefix}/function-url`;

    const workerFunction = new lambda.Function(this, "ComputerlessWorker", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "chatticus.worker.lambda_handler.handler",
      architecture: lambda.Architecture.X86_64,
      memorySize: 512,
      logRetention: CHATTICUS_LOG_RETENTION,
      timeout: cdk.Duration.seconds(120),
      description: "SQS computerless worker: one OpenAI text loop per turn job.",
      environment: {
        ...sharedEnv,
        CHATTICUS_INVOKE_KEY: invokeSecret.secretValue.unsafeUnwrap(),
      },
      code: httpCode,
    });
    table.grantReadWriteData(workerFunction);
    turnQueue.grantConsumeMessages(workerFunction);
    openaiParameter.grantRead(workerFunction);
    workerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${openAiParameterName}`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter${cloudFrontUrlParameterName}`,
        ],
      }),
    );
    workerFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(turnQueue, { batchSize: 1 }),
    );

    const computerWorkerFunction = new lambda.Function(this, "ComputerWorker", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "chatticus.worker.lambda_handler.handler",
      architecture: lambda.Architecture.X86_64,
      memorySize: 256,
      logRetention: CHATTICUS_LOG_RETENTION,
      timeout: cdk.Duration.seconds(60),
      description:
        "SQS computer-queue worker: nack without a host; never fake tool.result.",
      environment: {
        ...sharedEnv,
        CHATTICUS_WORKER_KIND: "computer",
        CHATTICUS_INVOKE_KEY: invokeSecret.secretValue.unsafeUnwrap(),
        CHATTICUS_FRONT_DOOR_URL: functionUrl.url,
      },
      code: httpCode,
    });
    table.grantReadWriteData(computerWorkerFunction);
    computerTurnQueue.grantConsumeMessages(computerWorkerFunction);
    computerWorkerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${cloudFrontUrlParameterName}`,
        ],
      }),
    );
    computerWorkerFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(computerTurnQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );
    const computerHostStart = computerHostStartEcsConfig(this, environmentName);
    if (computerHostStart !== undefined) {
      wireComputerWorkerEcsHostStart(
        computerWorkerFunction,
        cdk.Stack.of(this),
        computerHostStart,
        table,
        computerTurnQueue,
      );
    }

    if (props.budgetsMonthlyLimitUsd !== undefined) {
      const budgetsAlertsTopicArn = props.budgetsAlertsTopicArn;
      const rollupFunctionName = `chatticus-${environmentName}-daily-budget-rollup`;
      const rollupScheduleGroupName = `chatticus-${environmentName}-budget-rollup`;
      const rollupSchedulerRoleName = `chatticus-${environmentName}-budget-rollup-scheduler`;
      const rollupScheduleGroup = new scheduler.CfnScheduleGroup(
        this,
        "BudgetRollupGroup",
        { name: rollupScheduleGroupName },
      );
      const rollupFunction = new lambda.Function(this, "DailyBudgetRollup", {
        functionName: rollupFunctionName,
        runtime: lambda.Runtime.PYTHON_3_12,
        handler: "chatticus.budget_rollup.lambda_handler.handler",
        architecture: lambda.Architecture.X86_64,
        memorySize: 256,
        logRetention: CHATTICUS_LOG_RETENTION,
        timeout: cdk.Duration.seconds(120),
        description:
          "EventBridge Scheduler target: daily AWS and vendor budget rollup.",
        environment: {
          ...sharedEnv,
          CHATTICUS_BUDGETS_MONTHLY_LIMIT_USD: String(props.budgetsMonthlyLimitUsd),
          ...(budgetsAlertsTopicArn
            ? { CHATTICUS_BUDGETS_ALERTS_TOPIC_ARN: budgetsAlertsTopicArn }
            : {}),
        },
        code: httpCode,
      });
      table.grantReadWriteData(rollupFunction);
      rollupFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ce:GetCostAndUsage", "ce:GetTags"],
          resources: ["*"],
        }),
      );
      if (budgetsAlertsTopicArn) {
        rollupFunction.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ["sns:Publish"],
            resources: [budgetsAlertsTopicArn],
          }),
        );
      }
      const rollupSchedulerRole = new iam.Role(this, "BudgetRollupSchedulerRole", {
        roleName: rollupSchedulerRoleName,
        assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
      });
      rollupFunction.grantInvoke(rollupSchedulerRole);
      new scheduler.CfnSchedule(this, "DailyBudgetRollupSchedule", {
        name: `chatticus-${environmentName}-daily-budget-rollup`,
        groupName: rollupScheduleGroup.name ?? rollupScheduleGroupName,
        scheduleExpression: "cron(0 6 * * ? *)",
        scheduleExpressionTimezone: "UTC",
        flexibleTimeWindow: { mode: "OFF" },
        target: {
          arn: rollupFunction.functionArn,
          roleArn: rollupSchedulerRole.roleArn,
        },
      });
      rollupScheduleGroup.node.addDependency(rollupFunction);

      if (budgetsAlertsTopicArn) {
        const budgetsAlertsTopic = sns.Topic.fromTopicArn(
          this,
          "BudgetsAlertsTopic",
          budgetsAlertsTopicArn,
        );
        const alertRecorderFunction = new lambda.Function(this, "BudgetAlertRecorder", {
          runtime: lambda.Runtime.PYTHON_3_12,
          handler: "chatticus.budget_rollup.alert_recorder.handler",
          architecture: lambda.Architecture.X86_64,
          memorySize: 256,
          logRetention: CHATTICUS_LOG_RETENTION,
          timeout: cdk.Duration.seconds(30),
          description:
            "Record AWS Budgets SNS alerts on durable account rollup rows.",
          environment: sharedEnv,
          code: httpCode,
        });
        table.grantReadWriteData(alertRecorderFunction);
        budgetsAlertsTopic.addSubscription(
          new subscriptions.LambdaSubscription(alertRecorderFunction),
        );
      }
    }

    new ssm.StringParameter(this, "FunctionUrlParameter", {
      parameterName: functionUrlParameterName,
      stringValue: functionUrl.url,
      description: `Lambda function URL for the ${environmentName} thin-turn front door.`,
    });
    new ssm.StringParameter(this, "InvokeKeySecretArnParameter", {
      parameterName: `${parameterPrefix}/invoke-key-secret-arn`,
      stringValue: invokeSecret.secretArn,
      description: `Invoke-key secret ARN for the ${environmentName} thin-turn front door.`,
    });
    new ssm.StringParameter(this, "TurnQueueUrlParameter", {
      parameterName: `${parameterPrefix}/turn-queue-url`,
      stringValue: turnQueue.queueUrl,
      description: `CPU turn queue URL for the ${environmentName} thin turn.`,
    });
    new ssm.StringParameter(this, "TurnQueueArnParameter", {
      parameterName: `${parameterPrefix}/turn-queue-arn`,
      stringValue: turnQueue.queueArn,
      description: `CPU turn queue ARN for the ${environmentName} thin turn.`,
    });
    new ssm.StringParameter(this, "ComputerTurnQueueUrlParameter", {
      parameterName: `${parameterPrefix}/computer-turn-queue-url`,
      stringValue: computerTurnQueue.queueUrl,
      description: `Computer turn queue URL for the ${environmentName} thin turn.`,
    });
    new ssm.StringParameter(this, "ComputerTurnQueueArnParameter", {
      parameterName: `${parameterPrefix}/computer-turn-queue-arn`,
      stringValue: computerTurnQueue.queueArn,
      description: `Computer turn queue ARN for the ${environmentName} thin turn.`,
    });

    new cdk.CfnOutput(this, "ChatticusEnvironment", { value: environmentName });
    new cdk.CfnOutput(this, "MessagingTableName", { value: table.tableName });
    new cdk.CfnOutput(this, "TurnQueueUrl", { value: turnQueue.queueUrl });
    new cdk.CfnOutput(this, "ComputerTurnQueueUrl", {
      value: computerTurnQueue.queueUrl,
    });
    new cdk.CfnOutput(this, "TurnDeadlineScheduleGroup", {
      value: turnDeadlineScheduleGroup.name ?? turnDeadlineScheduleGroupName,
    });
    new cdk.CfnOutput(this, "TurnDeadlineFunctionArn", {
      value: deadlineFunction.functionArn,
    });
    new cdk.CfnOutput(this, "FunctionUrl", {
      value: functionUrl.url,
      exportName: thinTurnExportName(environmentName, "function-url"),
    });
    new cdk.CfnOutput(this, "InvokeKeySecretArn", {
      value: invokeSecret.secretArn,
      exportName: thinTurnExportName(environmentName, "invoke-key-secret-arn"),
    });
    new cdk.CfnOutput(this, "InvokeKeySecretArnOutput", {
      value: invokeSecret.secretArn,
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
