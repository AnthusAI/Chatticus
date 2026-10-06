import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as path from "path";
import { Construct } from "constructs";
import { ChatticusCloudEnvironment } from "./environments";
import { CHATTICUS_LOG_RETENTION } from "./log-retention";

const CREATE_REQUIRE_BANNER =
  'import { createRequire as topLevelCreateRequire } from "module"; ' +
  "const require = topLevelCreateRequire(import.meta.url);";

const DEAD_LETTER_MAX_RECEIVE_COUNT = 5;

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
 * The new conversation infrastructure, deployed unrouted: the Pi session table
 * and bucket, the three job queues with dead-letter queues, and the FrontDoor,
 * TurnExecutor, TurnProbe and ComputerStarter Lambdas. CloudFront still points
 * at the Python front door; nothing here is attached to it.
 */
export class ControlPlaneStack extends cdk.Stack {
  readonly conversationsTable: dynamodb.Table;
  readonly piSessionsBucket: s3.Bucket;
  readonly turnRunsQueue: sqs.Queue;
  readonly turnProbesQueue: sqs.Queue;
  readonly computerStartJobsQueue: sqs.Queue;
  readonly frontDoorFunction: lambdaNodejs.NodejsFunction;
  readonly frontDoorFunctionUrl: lambda.FunctionUrl;
  readonly turnExecutorFunction: lambdaNodejs.NodejsFunction;
  readonly turnProbeFunction: lambdaNodejs.NodejsFunction;
  readonly computerStarterFunction: lambdaNodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: ControlPlaneStackProps) {
    super(scope, id, props);

    const environmentName = props.chatticusEnvironment;
    const isDevelopment = environmentName === "development";
    const dataRetention = isDevelopment ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    const messagingTable = props.messagingTable;

    const conversationsTable = new dynamodb.Table(this, "Conversations", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: dataRetention,
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
      versioned: false,
      removalPolicy: dataRetention,
      autoDeleteObjects: isDevelopment,
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

    const frontDoorFunction = nodeFunction(
      "FrontDoor",
      "front-door.ts",
      512,
      900,
      "TypeScript front door: Hono with turn-scoped SSE through a RESPONSE_STREAM Function URL.",
      sharedEnvironment,
    );
    messagingTable.grantReadWriteData(frontDoorFunction);
    conversationsTable.grantReadData(frontDoorFunction);
    piSessionsBucket.grantRead(frontDoorFunction);
    turnRunsQueue.grantSendMessages(frontDoorFunction);
    turnProbesQueue.grantSendMessages(frontDoorFunction);
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
      sharedEnvironment,
    );
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
      { ...sharedEnvironment, CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID: this.account },
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
}
