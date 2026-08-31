import * as cdk from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
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
  thinTurnParameterPrefix,
} from "./environments";

const STRIP_ACCEPT_ENCODING_FUNCTION = `function handler(event) {
  var request = event.request;
  if (request.headers["accept-encoding"]) {
    delete request.headers["accept-encoding"];
  }
  return request;
}`;

const LAMBDA_WEB_ADAPTER_LAYER_VERSION = 28;
const OPENAI_PARAMETER_NAME = "/amplify/shared/papyrus/OPENAI_API_KEY";

/**
 * Zero-idle computerless turn: DynamoDB, SQS, Lambda Web Adapter SSE, CloudFront.
 *
 * Do not put a load balancer in front of this stack.
 */
export interface ThinTurnStackProps extends cdk.StackProps {
  chatticusEnvironment: ChatticusCloudEnvironment;
}

export class ThinTurnStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ThinTurnStackProps) {
    super(scope, id, props);

    const environmentName = props.chatticusEnvironment;
    const parameterPrefix = thinTurnParameterPrefix(environmentName);
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

    const openaiParameter = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      "OpenAiKey",
      { parameterName: OPENAI_PARAMETER_NAME },
    );

    const httpCode = lambda.Code.fromAsset(pythonRoot, {
      bundling: {
        image: lambda.Runtime.PYTHON_3_12.bundlingImage,
        command: [
          "bash",
          "-c",
          [
            "pip install . fastapi uvicorn 'pydantic>=2' httpx python-dotenv -t /asset-output",
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
                  "fastapi uvicorn 'pydantic>=2' httpx python-dotenv",
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
      OPENAI_MODEL: "gpt-5.6-luna",
      OPENAI_API_KEY_PARAMETER: OPENAI_PARAMETER_NAME,
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
      },
      code: httpCode,
    });

    const deadlineFunction = new lambda.Function(this, "TurnDeadline", {
      functionName: turnDeadlineFunctionName,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "chatticus.deadline.lambda_handler.handler",
      architecture: lambda.Architecture.X86_64,
      memorySize: 256,
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
          `arn:aws:ssm:${this.region}:${this.account}:parameter${OPENAI_PARAMETER_NAME}`,
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

    const cloudFrontUrlParameterName = `${parameterPrefix}/cloudfront-url`;

    const workerFunction = new lambda.Function(this, "ComputerlessWorker", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "chatticus.worker.lambda_handler.handler",
      architecture: lambda.Architecture.X86_64,
      memorySize: 512,
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
          `arn:aws:ssm:${this.region}:${this.account}:parameter${OPENAI_PARAMETER_NAME}`,
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
      timeout: cdk.Duration.seconds(60),
      description:
        "SQS computer-queue worker: nack without a host; never fake tool.result.",
      environment: {
        ...sharedEnv,
        CHATTICUS_WORKER_KIND: "computer",
        CHATTICUS_INVOKE_KEY: invokeSecret.secretValue.unsafeUnwrap(),
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

    const stripAcceptEncoding = new cloudfront.Function(this, "StripAcceptEncoding", {
      code: cloudfront.FunctionCode.fromInline(STRIP_ACCEPT_ENCODING_FUNCTION),
      comment: "Strip Accept-Encoding so the Lambda origin emits identity encoding.",
    });

    const originReadTimeoutSeconds = 60;
    const distribution = new cloudfront.Distribution(this, "FrontDoorDistribution", {
      comment: `Chatticus ${environmentName} thin-turn front door (per-request, no idle floor).`,
      defaultBehavior: {
        origin: new origins.FunctionUrlOrigin(functionUrl, {
          readTimeout: cdk.Duration.seconds(originReadTimeoutSeconds),
          responseCompletionTimeout: cdk.Duration.seconds(900),
          customHeaders: {
            "X-Chatticus-Invoke-Key": invokeSecret.secretValue.unsafeUnwrap(),
          },
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        functionAssociations: [
          {
            function: stripAcceptEncoding,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
    });

    const cloudFrontUrl = `https://${distribution.distributionDomainName}`;

    new ssm.StringParameter(this, "CloudFrontUrlParameter", {
      parameterName: cloudFrontUrlParameterName,
      stringValue: cloudFrontUrl,
      description: `CloudFront origin for the ${environmentName} thin-turn front door.`,
    });
    new ssm.StringParameter(this, "InvokeKeySecretArnParameter", {
      parameterName: `${parameterPrefix}/invoke-key-secret-arn`,
      stringValue: invokeSecret.secretArn,
      description: `Invoke-key secret ARN for the ${environmentName} thin-turn front door.`,
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
    new cdk.CfnOutput(this, "FunctionUrl", { value: functionUrl.url });
    new cdk.CfnOutput(this, "CloudFrontUrl", { value: cloudFrontUrl });
    new cdk.CfnOutput(this, "InvokeKeySecretArn", { value: invokeSecret.secretArn });
    new cdk.CfnOutput(this, "OriginReadTimeoutSeconds", {
      value: String(originReadTimeoutSeconds),
    });

    const githubProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      "GitHubOidc",
      `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
    );
    const acceptanceRole = new iam.Role(this, "GithubAcceptance", {
      roleName: `chatticus-${environmentName}-github-acceptance`,
      description:
        `GitHub Actions named-environment acceptance for ${environmentName}. ` +
        "Look up the thin-turn origin and consume SQS for the named exercise.",
      assumedBy: new iam.WebIdentityPrincipal(
        githubProvider.openIdConnectProviderArn,
        {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          },
          StringLike: {
            "token.actions.githubusercontent.com:job_workflow_ref": [
              "AnthusAI/Chattic.us/.github/workflows/acceptance.yml@refs/heads/develop",
              "AnthusAI/Chattic.us/.github/workflows/acceptance.yml@refs/heads/main",
            ],
          },
        },
      ),
    });
    turnQueue.grantConsumeMessages(acceptanceRole);
    computerTurnQueue.grantConsumeMessages(acceptanceRole);
    acceptanceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${parameterPrefix}/*`,
        ],
      }),
    );
    acceptanceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cloudformation:DescribeStacks"],
        resources: [
          `arn:aws:cloudformation:${this.region}:${this.account}:stack/${this.stackName}/*`,
        ],
      }),
    );
    new cdk.CfnOutput(this, "GithubAcceptanceRoleArn", {
      value: acceptanceRole.roleArn,
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
