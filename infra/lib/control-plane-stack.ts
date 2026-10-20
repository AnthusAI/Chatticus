import { KanbusApi } from "@kanbus/cdk";
import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as path from "path";
import { Construct } from "constructs";
import {
  ALARM_PERIOD,
  ChatticusAlarmTopic,
  FRONT_DOOR_5XX_THRESHOLD,
  TURN_QUEUE_OLDEST_MESSAGE_SECONDS,
  createChatticusAlarm,
} from "./alarms";
import { readAlarmNotificationEmail } from "./budgets-config";
import {
  ChatticusCloudEnvironment,
  KANBUS_BOARD_ENVIRONMENTS,
  integrationTestParameterPrefix,
  invokeKeySecretArnParameterName,
  operatorKeySecretArnParameterName,
  openAiApiKeyParameterName,
  signupModeForEnvironment,
  webParameterPrefix,
} from "./environments";
import {
  computerHostStartEcsConfig,
  computerOwnerStartConfig,
  wireComputerStarterEcsRunTask,
  wireComputerStarterOwnerRunTask,
} from "./computer-host-start";
import { CHATTICUS_LOG_RETENTION } from "./log-retention";
import { frontDoorSnapshotPolicyStatements } from "./owner-role-policy";

const CREATE_REQUIRE_BANNER =
  'import { createRequire as topLevelCreateRequire } from "module"; ' +
  "const require = topLevelCreateRequire(import.meta.url);";

const DEAD_LETTER_MAX_RECEIVE_COUNT = 5;

/** Days an archived bot board is kept before the Kanbus sweeper purges it; docs/BOT_BOARDS.md section 11 (f). */
const KANBUS_ARCHIVE_RETENTION_DAYS = 30;

/** Length of the generated model gateway signing key; the token code requires at least 32. */
export const MODEL_GATEWAY_SIGNING_KEY_LENGTH = 64;

/** Local secondary indexes of the Pi session table; mirrors PI_SESSION_TABLE_KEYS in conversation/src/storage/table-definition.ts. */
export const CONVERSATIONS_TABLE_LOCAL_SECONDARY_INDEXES = [
  { indexName: "l1-index", attributeName: "l1" },
  { indexName: "l2-index", attributeName: "l2" },
  { indexName: "l3-index", attributeName: "l3" },
] as const;

/** Properties of the TypeScript conversation control plane stack. */
export interface ControlPlaneStackProps extends cdk.StackProps {
  chatticusEnvironment: ChatticusCloudEnvironment;
  /** The existing Messaging table of the thin-turn stack, shared unchanged. */
  messagingTable: dynamodb.ITable;
}

/**
 * The conversation infrastructure: the Pi session table and bucket, the three
 * job queues with dead-letter queues, and the FrontDoor, TurnExecutor,
 * TurnProbe and ComputerStarter Lambdas. CloudFront fronts /api/* with the
 * FrontDoor function URL.
 */
const OWNER_BROKER_FAULT_CONTEXT_VALUES = ["none", "deny_supervisor_renewal", "deny_turn_renewal"];
const OWNER_BROKER_CREDENTIAL_SECONDS_MINIMUM = 900;
const OWNER_BROKER_CREDENTIAL_SECONDS_MAXIMUM = 3600;

/**
 * The development fault switch of the owner credential broker (docs/OWNER_CREDENTIAL_RENEWAL.md, R22, gates G1 and G2).
 * The CDK context ownerBrokerFault and ownerBrokerCredentialSeconds is accepted for the development environment only:
 * any value for another environment fails synthesis and names the switch. The two broker variables it returns are the only
 * place infra/lib names them, and nothing is returned unless a context value asks for a fault.
 */
function ownerBrokerFaultVariablesFromContext(scope: Construct, environmentName: ChatticusCloudEnvironment): Record<string, string> {
  const faultContext = scope.node.tryGetContext("ownerBrokerFault");
  const secondsContext = scope.node.tryGetContext("ownerBrokerCredentialSeconds");
  if (faultContext === undefined && secondsContext === undefined) return {};
  if (environmentName !== "development") {
    throw new Error(
      `The broker fault switch (ownerBrokerFault, ownerBrokerCredentialSeconds) exists in the development environment only; it is set for ${environmentName}.`,
    );
  }
  const variables: Record<string, string> = {};
  if (faultContext !== undefined) {
    const fault = String(faultContext);
    if (!OWNER_BROKER_FAULT_CONTEXT_VALUES.includes(fault)) {
      throw new Error(`ownerBrokerFault must be one of ${OWNER_BROKER_FAULT_CONTEXT_VALUES.join(", ")}.`);
    }
    if (fault !== "none") variables.CHATTICUS_OWNER_BROKER_FAULT = fault;
  }
  if (secondsContext !== undefined) {
    const secondsText = String(secondsContext);
    const seconds = Number(secondsText);
    if (
      !/^\d+$/.test(secondsText) ||
      seconds < OWNER_BROKER_CREDENTIAL_SECONDS_MINIMUM ||
      seconds > OWNER_BROKER_CREDENTIAL_SECONDS_MAXIMUM
    ) {
      throw new Error(
        `ownerBrokerCredentialSeconds must be a whole number from ${OWNER_BROKER_CREDENTIAL_SECONDS_MINIMUM} to ${OWNER_BROKER_CREDENTIAL_SECONDS_MAXIMUM}.`,
      );
    }
    variables.CHATTICUS_OWNER_BROKER_CREDENTIAL_SECONDS = secondsText;
  }
  return variables;
}

export class ControlPlaneStack extends cdk.Stack {
  readonly conversationsTable: dynamodb.Table;
  readonly piSessionsBucket: s3.Bucket;
  readonly turnRunsQueue: sqs.Queue;
  readonly turnProbesQueue: sqs.Queue;
  readonly computerStartJobsQueue: sqs.Queue;
  /** The topic every alarm of this environment notifies. */
  readonly alarmTopic: sns.Topic;
  readonly frontDoorFunction: lambdaNodejs.NodejsFunction;
  readonly frontDoorFunctionUrl: lambda.FunctionUrl;
  readonly turnExecutorFunction: lambdaNodejs.NodejsFunction;
  readonly turnProbeFunction: lambdaNodejs.NodejsFunction;
  readonly computerStarterFunction: lambdaNodejs.NodejsFunction;
  /** Development only: signs the per-turn model gateway tokens. */
  readonly modelGatewaySigningKeySecret?: secretsmanager.Secret;
  /** Development only, and only once ChatticusComputers has the owner task: the assumable ceiling for one Pi session owner. */
  readonly computerOwnerScopedRole?: iam.Role;
  /** Development only, with the scoped role: the assumable ceiling for the supervisor of the organization computer. */
  readonly computerSupervisorRole?: iam.Role;
  /** Development only, with the scoped role: the only principal that assumes the two owner roles; the Front Door invokes it. */
  readonly ownerCredentialBrokerFunction?: lambdaNodejs.NodejsFunction;
  /** Only in the environments of KANBUS_BOARD_ENVIRONMENTS: this environment's own Kanbus board service. */
  readonly kanbusApi?: KanbusApi;

  constructor(scope: Construct, id: string, props: ControlPlaneStackProps) {
    super(scope, id, props);

    const environmentName = props.chatticusEnvironment;
    const isDevelopment = environmentName === "development";
    const dataRetention = isDevelopment ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    const messagingTable = props.messagingTable;
    const ownerBrokerFaultVariables = ownerBrokerFaultVariablesFromContext(this, environmentName);

    const conversationsTable = new dynamodb.Table(this, "Conversations", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    for (const index of CONVERSATIONS_TABLE_LOCAL_SECONDARY_INDEXES) {
      conversationsTable.addLocalSecondaryIndex({
        indexName: index.indexName,
        sortKey: { name: index.attributeName, type: dynamodb.AttributeType.STRING },
        projectionType: dynamodb.ProjectionType.ALL,
      });
    }
    this.conversationsTable = conversationsTable;

    const piSessionsBucket = new s3.Bucket(this, "PiSessions", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: dataRetention,
      autoDeleteObjects: isDevelopment,
    });
    piSessionsBucket.addLifecycleRule({
      noncurrentVersionExpiration: cdk.Duration.days(30),
    });
    this.piSessionsBucket = piSessionsBucket;

    const queueWithDeadLetter = (queueId: string, visibilityTimeoutSeconds: number): sqs.Queue => {
      const deadLetterQueue = new sqs.Queue(this, `${queueId}DeadLetter`, {
        retentionPeriod: cdk.Duration.days(14),
        removalPolicy: dataRetention,
      });
      return new sqs.Queue(this, queueId, {
        visibilityTimeout: cdk.Duration.seconds(visibilityTimeoutSeconds),
        removalPolicy: dataRetention,
        deadLetterQueue: {
          queue: deadLetterQueue,
          maxReceiveCount: DEAD_LETTER_MAX_RECEIVE_COUNT,
        },
      });
    };
    const turnRunsQueue = queueWithDeadLetter("TurnRuns", 1800);
    const turnProbesQueue = queueWithDeadLetter("TurnProbes", 360);
    const computerStartJobsQueue = queueWithDeadLetter("ComputerStartJobs", 360);
    this.turnRunsQueue = turnRunsQueue;
    this.turnProbesQueue = turnProbesQueue;
    this.computerStartJobsQueue = computerStartJobsQueue;

    const openAiParameterName = openAiApiKeyParameterName(environmentName);
    const openAiParameter = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      "OpenAiKey",
      { parameterName: openAiParameterName },
    );
    const openAiEnvironment = { OPENAI_API_KEY_PARAMETER: openAiParameterName };
    const grantOpenAiKeyRead = (target: lambdaNodejs.NodejsFunction): void => {
      openAiParameter.grantRead(target);
      target.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: [
            `arn:aws:ssm:${this.region}:${this.account}:parameter${openAiParameterName}`,
          ],
        }),
      );
    };

    const sharedEnvironment: Record<string, string> = {
      CHATTICUS_ENVIRONMENT: environmentName,
      CHATTICUS_MESSAGING_TABLE: messagingTable.tableName,
      CHATTICUS_CONVERSATIONS_TABLE: conversationsTable.tableName,
      CHATTICUS_PI_SESSIONS_BUCKET: piSessionsBucket.bucketName,
      CHATTICUS_TURN_RUNS_QUEUE_URL: turnRunsQueue.queueUrl,
      CHATTICUS_TURN_PROBES_QUEUE_URL: turnProbesQueue.queueUrl,
      CHATTICUS_COMPUTER_STARTS_QUEUE_URL: computerStartJobsQueue.queueUrl,
    };

    const lambdasRoot = path.join(__dirname, "../../conversation/src/lambdas");
    const nodeFunction = (
      functionId: string,
      entryFile: string,
      memorySize: number,
      timeoutSeconds: number,
      description: string,
      environment: Record<string, string>,
    ): lambdaNodejs.NodejsFunction =>
      new lambdaNodejs.NodejsFunction(this, functionId, {
        entry: path.join(lambdasRoot, entryFile),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize,
        timeout: cdk.Duration.seconds(timeoutSeconds),
        logRetention: CHATTICUS_LOG_RETENTION,
        description,
        environment,
        bundling: {
          format: lambdaNodejs.OutputFormat.ESM,
          target: "node22",
          mainFields: ["module", "main"],
          sourceMap: true,
          banner: CREATE_REQUIRE_BANNER,
          externalModules: [],
        },
      });

    const webPrefix = webParameterPrefix(environmentName);
    const integrationPrefix = integrationTestParameterPrefix(environmentName);
    const cognitoUserPoolIdParameterName = `${webPrefix}/cognito-user-pool-id`;
    const cognitoAppClientIdParameterName = `${webPrefix}/cognito-app-client-id`;
    const integrationTestEnabled = environmentName !== "production";
    const parameterArn = (parameterName: string): string =>
      `arn:aws:ssm:${this.region}:${this.account}:parameter${parameterName}`;

    const integrationTestAllowedRoleArn = this.node.tryGetContext("integrationTestAllowedRoleArn");
    if (
      integrationTestEnabled &&
      typeof integrationTestAllowedRoleArn === "string" &&
      integrationTestAllowedRoleArn !== ""
    ) {
      new ssm.StringParameter(this, "IntegrationTestAllowedRoleArnParameter", {
        parameterName: `${integrationPrefix}/allowed-role-arn`,
        stringValue: integrationTestAllowedRoleArn,
        description: `Allowed IAM role for ${environmentName} integration-test session exchange.`,
      });
    }

    const invokeKeySecretArn = ssm.StringParameter.valueForStringParameter(
      this,
      invokeKeySecretArnParameterName(environmentName),
    );
    const operatorKeySecretArn = ssm.StringParameter.valueForStringParameter(
      this,
      operatorKeySecretArnParameterName(environmentName),
    );

    const frontDoorFunction = nodeFunction(
      "FrontDoor",
      "front-door.ts",
      512,
      900,
      "TypeScript front door: Hono with turn-scoped SSE through a RESPONSE_STREAM Function URL.",
      {
        ...sharedEnvironment,
        ...openAiEnvironment,
        CHATTICUS_SIGNUP_MODE: signupModeForEnvironment(environmentName),
        CHATTICUS_COGNITO_USER_POOL_ID_PARAMETER: cognitoUserPoolIdParameterName,
        CHATTICUS_COGNITO_APP_CLIENT_ID_PARAMETER: cognitoAppClientIdParameterName,
        CHATTICUS_INVOKE_KEY_SECRET_ARN: invokeKeySecretArn,
        CHATTICUS_OPERATOR_KEY_SECRET_ARN: operatorKeySecretArn,
        CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID: this.account,
        ...(integrationTestEnabled ? { CHATTICUS_INTEGRATION_TEST_ENABLED: "true" } : {}),
      },
    );
    grantOpenAiKeyRead(frontDoorFunction);
    frontDoorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          parameterArn(cognitoUserPoolIdParameterName),
          parameterArn(cognitoAppClientIdParameterName),
          ...(integrationTestEnabled ? [parameterArn(`${integrationPrefix}/*`)] : []),
        ],
      }),
    );
    frontDoorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [invokeKeySecretArn, operatorKeySecretArn],
      }),
    );
    frontDoorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: ["arn:aws:iam::*:role/ChatticusOrganizationComputerRole"],
      }),
    );
    messagingTable.grantReadWriteData(frontDoorFunction);
    conversationsTable.grantReadData(frontDoorFunction);
    piSessionsBucket.grantRead(frontDoorFunction);
    turnRunsQueue.grantSendMessages(frontDoorFunction);
    turnProbesQueue.grantSendMessages(frontDoorFunction);
    computerStartJobsQueue.grantSendMessages(frontDoorFunction);
    this.frontDoorFunction = frontDoorFunction;
    this.frontDoorFunctionUrl = frontDoorFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });

    const turnExecutorFunction = nodeFunction(
      "TurnExecutor",
      "turn-executor.ts",
      1024,
      300,
      "SQS TurnRuns consumer: the Pi session owner for one turn.",
      { ...sharedEnvironment, ...openAiEnvironment },
    );
    grantOpenAiKeyRead(turnExecutorFunction);
    messagingTable.grantReadWriteData(turnExecutorFunction);
    conversationsTable.grantReadWriteData(turnExecutorFunction);
    piSessionsBucket.grantReadWrite(turnExecutorFunction);
    turnRunsQueue.grantSendMessages(turnExecutorFunction);
    turnProbesQueue.grantSendMessages(turnExecutorFunction);
    computerStartJobsQueue.grantSendMessages(turnExecutorFunction);
    turnExecutorFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(turnRunsQueue, { batchSize: 1 }),
    );
    this.turnExecutorFunction = turnExecutorFunction;

    const turnProbeFunction = nodeFunction(
      "TurnProbe",
      "turn-probe.ts",
      256,
      60,
      "SQS TurnProbes consumer: deadline checks and turn recovery.",
      sharedEnvironment,
    );
    messagingTable.grantReadWriteData(turnProbeFunction);
    conversationsTable.grantReadData(turnProbeFunction);
    piSessionsBucket.grantRead(turnProbeFunction);
    turnRunsQueue.grantSendMessages(turnProbeFunction);
    turnProbesQueue.grantSendMessages(turnProbeFunction);
    computerStartJobsQueue.grantSendMessages(turnProbeFunction);
    turnProbeFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(turnProbesQueue, { batchSize: 1 }),
    );
    this.turnProbeFunction = turnProbeFunction;

    const computerStarterFunction = nodeFunction(
      "ComputerStarter",
      "computer-starter.ts",
      256,
      60,
      "SQS ComputerStartJobs consumer: starts the computer host for a parked turn.",
      {
        ...sharedEnvironment,
        CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID: this.account,
        CHATTICUS_FRONT_DOOR_URL: this.frontDoorFunctionUrl.url,
        CHATTICUS_INVOKE_KEY_SECRET_ARN: invokeKeySecretArn,
      },
    );
    computerStarterFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [invokeKeySecretArn],
      }),
    );
    messagingTable.grantReadWriteData(computerStarterFunction);
    turnRunsQueue.grantSendMessages(computerStarterFunction);
    turnProbesQueue.grantSendMessages(computerStarterFunction);
    computerStarterFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: ["arn:aws:iam::*:role/ChatticusOrganizationComputerRole"],
      }),
    );
    computerStarterFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(computerStartJobsQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );
    this.computerStarterFunction = computerStarterFunction;

    if (KANBUS_BOARD_ENVIRONMENTS.includes(environmentName)) {
      const kanbusApi = new KanbusApi(this, "Kanbus", {
        environmentName,
        archiveRetentionDays: KANBUS_ARCHIVE_RETENTION_DAYS,
        servicePrincipals: [
          { role: frontDoorFunction.role!, tenants: "*", provision: true, delegateActor: true },
          { role: turnExecutorFunction.role!, tenants: "*", provision: false, delegateActor: true },
        ],
      });
      for (const target of [frontDoorFunction, turnExecutorFunction]) {
        target.addEnvironment("CHATTICUS_KANBUS_API_URL", kanbusApi.serviceApiUrl!);
      }
      this.kanbusApi = kanbusApi;
    }

    if (isDevelopment) {
      const modelGatewaySigningKeySecret = new secretsmanager.Secret(
        this,
        "ModelGatewaySigningKey",
        {
          description:
            "Signs the short-lived per-turn tokens the model gateway accepts. Read by the FrontDoor, the ComputerStarter and the OwnerCredentialBroker only.",
          removalPolicy: cdk.RemovalPolicy.DESTROY,
          generateSecretString: {
            passwordLength: MODEL_GATEWAY_SIGNING_KEY_LENGTH,
            excludePunctuation: true,
          },
        },
      );
      modelGatewaySigningKeySecret.grantRead(frontDoorFunction);
      modelGatewaySigningKeySecret.grantRead(computerStarterFunction);
      for (const target of [frontDoorFunction, computerStarterFunction]) {
        target.addEnvironment(
          "CHATTICUS_MODEL_GATEWAY_SIGNING_KEY_SECRET_ARN",
          modelGatewaySigningKeySecret.secretArn,
        );
      }
      this.modelGatewaySigningKeySecret = modelGatewaySigningKeySecret;
    }
    const computerHostStart = computerHostStartEcsConfig(this, environmentName);
    if (computerHostStart !== undefined) {
      wireComputerStarterEcsRunTask(
        computerStarterFunction,
        cdk.Stack.of(this),
        computerHostStart,
      );
      const computerOwnerStart = computerOwnerStartConfig(this, environmentName);
      if (computerOwnerStart !== undefined) {
        const signingKeySecret = this.modelGatewaySigningKeySecret;
        if (signingKeySecret === undefined) {
          throw new Error("The owner credential broker needs the model gateway signing key, which exists in development only.");
        }
        const credentialBrokerFunction = nodeFunction(
          "OwnerCredentialBroker",
          "owner-credential-broker.ts",
          256,
          15,
          "Owner credential broker: the only principal that assumes the supervisor and per-turn roles and signs the owner tokens.",
          {
            CHATTICUS_MODEL_GATEWAY_SIGNING_KEY_SECRET_ARN: signingKeySecret.secretArn,
            CHATTICUS_ENVIRONMENT: environmentName,
            ...ownerBrokerFaultVariables,
          },
        );
        credentialBrokerFunction.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ["secretsmanager:GetSecretValue"],
            resources: [signingKeySecret.secretArn],
          }),
        );
        const ownerRoles = wireComputerStarterOwnerRunTask(
          computerStarterFunction,
          cdk.Stack.of(this),
          computerHostStart,
          computerOwnerStart,
          { messagingTable, conversationsTable, piSessionsBucket },
          credentialBrokerFunction,
        );
        this.computerOwnerScopedRole = ownerRoles.scopedRole;
        this.computerSupervisorRole = ownerRoles.supervisorRole;
        this.ownerCredentialBrokerFunction = credentialBrokerFunction;
        credentialBrokerFunction.grantInvoke(frontDoorFunction);
        frontDoorFunction.addEnvironment(
          "CHATTICUS_OWNER_CREDENTIAL_BROKER_FUNCTION_NAME",
          credentialBrokerFunction.functionName,
        );
        const snapshotBucketArn = `arn:aws:s3:::${computerOwnerStart.snapshotBucketName}`;
        for (const statement of frontDoorSnapshotPolicyStatements({ snapshotBucketArn })) {
          frontDoorFunction.addToRolePolicy(statement);
        }
        frontDoorFunction.addEnvironment("CHATTICUS_SNAPSHOT_BUCKET", computerOwnerStart.snapshotBucketName);
      }
    }

    if (Object.keys(ownerBrokerFaultVariables).length > 0 && this.ownerCredentialBrokerFunction === undefined) {
      throw new Error("The broker fault switch is set but the owner credential broker is not wired in this stack.");
    }

    const alarmTopic = new ChatticusAlarmTopic(this, "AlarmNotifications", {
      environmentName,
      notificationEmail: readAlarmNotificationEmail(this),
    }).topic;
    this.alarmTopic = alarmTopic;
    this.addAlarms(environmentName, alarmTopic, messagingTable, conversationsTable, [
      ["FrontDoor", "frontdoor", frontDoorFunction],
      ["TurnExecutor", "turnexecutor", turnExecutorFunction],
      ["TurnProbe", "turnprobe", turnProbeFunction],
      ["ComputerStarter", "computerstarter", computerStarterFunction],
      ...(this.ownerCredentialBrokerFunction
        ? ([["OwnerCredentialBroker", "ownercredentialbroker", this.ownerCredentialBrokerFunction]] as const)
        : []),
    ]);

    new cdk.CfnOutput(this, "ControlPlaneFunctionUrl", {
      value: this.frontDoorFunctionUrl.url,
    });
    new cdk.CfnOutput(this, "ConversationsTableName", {
      value: conversationsTable.tableName,
    });
    new cdk.CfnOutput(this, "PiSessionsBucketName", {
      value: piSessionsBucket.bucketName,
    });
  }

  private addAlarms(
    environmentName: ChatticusCloudEnvironment,
    topic: sns.ITopic,
    messagingTable: dynamodb.ITable,
    conversationsTable: dynamodb.ITable,
    functions: ReadonlyArray<readonly [string, string, lambdaNodejs.NodejsFunction]>,
  ): void {
    const sum = { period: ALARM_PERIOD, statistic: "Sum" };
    const maximum = { period: ALARM_PERIOD, statistic: "Maximum" };

    for (const [functionId, suffix, target] of functions) {
      createChatticusAlarm(this, `${functionId}ErrorsAlarm`, {
        environmentName,
        nameSuffix: `${suffix}-errors`,
        metric: target.metricErrors(sum),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        summary: `The ${functionId} Lambda of the ${environmentName} control plane raised errors in the last five minutes.`,
        lookAt: `the CloudWatch log group of the ${functionId} function for stack traces, and the Errors graph of the function.`,
        topic,
      });
    }

    const frontDoorFunction = functions[0][2];
    createChatticusAlarm(this, "FrontDoor5xxAlarm", {
      environmentName,
      nameSuffix: "frontdoor-5xx",
      metric: new cloudwatch.Metric({
        namespace: "AWS/Lambda",
        metricName: "Url5xxCount",
        dimensionsMap: { FunctionName: frontDoorFunction.functionName },
        ...sum,
      }),
      threshold: FRONT_DOOR_5XX_THRESHOLD,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      summary: `The ${environmentName} front door answered users with server errors (HTTP 5xx).`,
      lookAt: "the FrontDoor function logs for the failing request, and whether OpenAI or DynamoDB is degraded.",
      topic,
    });

    const throttleMetrics: Record<string, cloudwatch.IMetric> = {};
    functions.forEach(([, , target], position) => {
      throttleMetrics[`throttles${position}`] = target.metricThrottles(sum);
    });
    createChatticusAlarm(this, "LambdaThrottlesAlarm", {
      environmentName,
      nameSuffix: "lambda-throttles",
      metric: new cloudwatch.MathExpression({
        expression: Object.keys(throttleMetrics).join(" + "),
        usingMetrics: throttleMetrics,
        period: ALARM_PERIOD,
        label: "Control plane Lambda throttles",
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      summary: `A ${environmentName} control plane Lambda was throttled in the last five minutes.`,
      lookAt: "the Throttles graph per function, and the account concurrency limit in Service Quotas.",
      topic,
    });

    const queues: ReadonlyArray<readonly [string, string, sqs.Queue]> = [
      ["TurnRuns", "turnruns", this.turnRunsQueue],
      ["TurnProbes", "turnprobes", this.turnProbesQueue],
      ["ComputerStartJobs", "computerstartjobs", this.computerStartJobsQueue],
    ];
    for (const [queueId, suffix, queue] of queues) {
      const deadLetterQueue = queue.deadLetterQueue?.queue;
      if (deadLetterQueue === undefined) {
        throw new Error(`The ${queueId} queue has no dead-letter queue to alarm on.`);
      }
      createChatticusAlarm(this, `${queueId}DeadLetterAlarm`, {
        environmentName,
        nameSuffix: `${suffix}-dead-letter`,
        metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible(maximum),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        summary: `A ${queueId} job in ${environmentName} failed five times and landed in its dead-letter queue.`,
        lookAt: `the ${queueId} dead-letter queue messages in SQS, and the consumer Lambda logs for the failure; redrive after fixing.`,
        topic,
      });
    }

    createChatticusAlarm(this, "TurnRunsOldestMessageAlarm", {
      environmentName,
      nameSuffix: "turnruns-oldest-message-age",
      metric: this.turnRunsQueue.metricApproximateAgeOfOldestMessage(maximum),
      threshold: TURN_QUEUE_OLDEST_MESSAGE_SECONDS,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      summary: `A ${environmentName} turn job has waited more than fifteen minutes; turns are backing up.`,
      lookAt: "the TurnExecutor function concurrency and errors, and the TurnRuns queue depth in SQS.",
      topic,
    });

    const tables: ReadonlyArray<readonly [string, string, dynamodb.ITable]> = [
      ["Conversations", "conversations", conversationsTable],
      ["Messaging", "messaging", messagingTable],
    ];
    for (const [tableId, suffix, table] of tables) {
      createChatticusAlarm(this, `${tableId}TableThrottlesAlarm`, {
        environmentName,
        nameSuffix: `${suffix}-table-throttles`,
        metric: new cloudwatch.MathExpression({
          expression: "reads + writes",
          usingMetrics: {
            reads: table.metric("ReadThrottleEvents", sum),
            writes: table.metric("WriteThrottleEvents", sum),
          },
          period: ALARM_PERIOD,
          label: `${tableId} table throttled requests`,
        }),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        summary: `The ${environmentName} ${tableId} DynamoDB table throttled requests in the last five minutes.`,
        lookAt: `the ${tableId} table metrics for throttled reads and writes, and for a hot partition key.`,
        topic,
      });
    }
  }
}
