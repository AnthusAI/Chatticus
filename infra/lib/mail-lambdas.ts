import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaDestinations from "aws-cdk-lib/aws-lambda-destinations";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { ALARM_PERIOD, createChatticusAlarm } from "./alarms";
import { CREATE_REQUIRE_BANNER } from "./control-plane-stack";
import {
  CHANNELS_EVENT_BUS_NAME,
  CHANNELS_EVENT_SOURCE,
  CHANNELS_MESSAGE_CREATED_DETAIL_TYPE,
  channelsCorrelatorSecretParameterName,
  type ChatticusCloudEnvironment,
} from "./environments";
import { CHATTICUS_LOG_RETENTION } from "./log-retention";

/** How many times the platform runs a failed asynchronous invocation again before the event goes to the dead-letter queue. */
export const MAIL_FUNCTION_RETRY_ATTEMPTS = 2;

/** How long the platform keeps trying a failed asynchronous invocation; the status function rejects notifications older than two hours. */
export const MAIL_FUNCTION_MAXIMUM_EVENT_AGE = cdk.Duration.hours(1);

/** What the mail functions need from the application stacks of the same environment. */
export interface MailApplicationResources {
  readonly messagingTable: dynamodb.ITable;
  readonly conversationsTable: dynamodb.ITable;
  readonly piSessionsBucket: s3.IBucket;
  readonly turnRunsQueue: sqs.IQueue;
  readonly turnProbesQueue: sqs.IQueue;
  readonly alarmTopic: sns.ITopic;
  /** The base URL of the web app, used in the link of a reply that was cut. */
  readonly webAppBaseUrl: string;
}

export interface MailLambdasProps {
  readonly environmentName: ChatticusCloudEnvironment;
  readonly mailDomain: string;
  readonly rawMailBucket: s3.IBucket;
  readonly rawMailKeyPrefix: string;
  readonly eventsTopic: sns.ITopic;
  readonly configurationSetName: string;
  readonly application: MailApplicationResources;
}

/**
 * The three functions of mail: the ingress function that the receipt rule invokes after storing a message, the delivery
 * function that the event bus invokes for each reply owed, and the status function subscribed to the configuration set's
 * topic. Each has its own role with exactly the permissions its code uses, its own dead-letter queue, and alarms on its
 * errors and on its dead letters that notify the environment's alarm topic.
 *
 * Failed asynchronous invocations are run again twice by the platform, then land in the function's dead-letter queue with
 * the error. A message that can never be admitted is counted by the code and does not fail an invocation, so only a real
 * failure reaches the queue.
 */
export class MailLambdas extends Construct {
  readonly ingressFunction: lambdaNodejs.NodejsFunction;
  readonly deliveryFunction: lambdaNodejs.NodejsFunction;
  readonly statusFunction: lambdaNodejs.NodejsFunction;
  readonly deadLetterQueues: Record<"ingress" | "delivery" | "status", sqs.Queue>;

  constructor(scope: Construct, id: string, props: MailLambdasProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    const { application, environmentName } = props;
    const correlatorSecretParameterName = channelsCorrelatorSecretParameterName(environmentName);
    const correlatorSecretArn = stack.formatArn({
      service: "ssm",
      resource: "parameter",
      resourceName: correlatorSecretParameterName.replace(/^\//, ""),
    });
    const identityArn = stack.formatArn({ service: "ses", resource: "identity", resourceName: props.mailDomain });
    const configurationSetArn = stack.formatArn({ service: "ses", resource: "configuration-set", resourceName: props.configurationSetName });

    const commonEnvironment: Record<string, string> = {
      CHATTICUS_ENVIRONMENT: environmentName,
      CHATTICUS_MESSAGING_TABLE: application.messagingTable.tableName,
      CHATTICUS_CHANNELS_MAIL_DOMAIN: props.mailDomain,
      CHATTICUS_CHANNELS_CORRELATOR_SECRET_PARAMETER_NAME: correlatorSecretParameterName,
      CHATTICUS_CHANNELS_EVENT_BUS_NAME: CHANNELS_EVENT_BUS_NAME,
      CHATTICUS_CHANNELS_KILL_SWITCH: "released",
      CHATTICUS_CHANNELS_CONFIGURATION_SET_NAME: props.configurationSetName,
      CHATTICUS_CHANNELS_WEB_APP_BASE_URL: application.webAppBaseUrl,
    };
    const storeEnvironment: Record<string, string> = {
      CHATTICUS_CONVERSATIONS_TABLE: application.conversationsTable.tableName,
      CHATTICUS_PI_SESSIONS_BUCKET: application.piSessionsBucket.bucketName,
    };

    const lambdasRoot = path.join(__dirname, "../../conversation/src/lambdas");
    const deadLetterQueues = {} as Record<"ingress" | "delivery" | "status", sqs.Queue>;
    const mailFunction = (
      key: "ingress" | "delivery" | "status",
      functionId: string,
      entryFile: string,
      memorySize: number,
      timeoutSeconds: number,
      description: string,
      environment: Record<string, string>,
    ): lambdaNodejs.NodejsFunction => {
      const deadLetterQueue = new sqs.Queue(this, `${functionId}DeadLetter`, {
        retentionPeriod: cdk.Duration.days(14),
        enforceSSL: true,
      });
      deadLetterQueues[key] = deadLetterQueue;
      const target = new lambdaNodejs.NodejsFunction(this, functionId, {
        entry: path.join(lambdasRoot, entryFile),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize,
        timeout: cdk.Duration.seconds(timeoutSeconds),
        logRetention: CHATTICUS_LOG_RETENTION,
        description,
        environment: { ...commonEnvironment, ...environment },
        retryAttempts: MAIL_FUNCTION_RETRY_ATTEMPTS,
        maxEventAge: MAIL_FUNCTION_MAXIMUM_EVENT_AGE,
        onFailure: new lambdaDestinations.SqsDestination(deadLetterQueue),
        bundling: {
          format: lambdaNodejs.OutputFormat.ESM,
          target: "node22",
          mainFields: ["module", "main"],
          sourceMap: true,
          banner: CREATE_REQUIRE_BANNER,
          externalModules: [],
        },
      });
      application.messagingTable.grantReadWriteData(target);
      target.addToRolePolicy(new iam.PolicyStatement({ actions: ["ssm:GetParameter"], resources: [correlatorSecretArn] }));
      return target;
    };

    this.ingressFunction = mailFunction(
      "ingress",
      "MailIngress",
      "mail-ingress.ts",
      1024,
      120,
      "SES receipt rule action: reads the stored raw message and admits it as an inbound channel message.",
      {
        ...storeEnvironment,
        CHATTICUS_TURN_RUNS_QUEUE_URL: application.turnRunsQueue.queueUrl,
        CHATTICUS_TURN_PROBES_QUEUE_URL: application.turnProbesQueue.queueUrl,
        CHATTICUS_CHANNELS_RAW_MAIL_BUCKET: props.rawMailBucket.bucketName,
      },
    );
    application.conversationsTable.grantReadData(this.ingressFunction);
    application.piSessionsBucket.grantRead(this.ingressFunction);
    application.turnRunsQueue.grantSendMessages(this.ingressFunction);
    application.turnProbesQueue.grantSendMessages(this.ingressFunction);
    this.ingressFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["s3:GetObject"], resources: [props.rawMailBucket.arnForObjects(`${props.rawMailKeyPrefix}*`)] }),
    );

    this.deliveryFunction = mailFunction(
      "delivery",
      "MailDelivery",
      "mail-delivery.ts",
      512,
      60,
      "EventBridge rule target: sends one owed reply through SES.",
      storeEnvironment,
    );
    application.conversationsTable.grantReadData(this.deliveryFunction);
    application.piSessionsBucket.grantRead(this.deliveryFunction);
    this.deliveryFunction.addToRolePolicy(new iam.PolicyStatement({ actions: ["ses:SendEmail"], resources: [identityArn, configurationSetArn] }));

    this.statusFunction = mailFunction(
      "status",
      "MailStatus",
      "mail-status.ts",
      256,
      30,
      "SNS subscriber of the SES configuration set: verifies each notification and records delivery status.",
      { CHATTICUS_CHANNELS_MAIL_EVENTS_TOPIC_ARN: props.eventsTopic.topicArn },
    );

    props.eventsTopic.addSubscription(new snsSubscriptions.LambdaSubscription(this.statusFunction));

    new events.Rule(this, "ChannelMessageCreatedRule", {
      description: "Announcements of replies owed to external transports go to the mail delivery function.",
      eventBus: events.EventBus.fromEventBusName(this, "DefaultEventBus", CHANNELS_EVENT_BUS_NAME),
      eventPattern: { source: [CHANNELS_EVENT_SOURCE], detailType: [CHANNELS_MESSAGE_CREATED_DETAIL_TYPE] },
      targets: [new eventsTargets.LambdaFunction(this.deliveryFunction, { retryAttempts: 2, maxEventAge: MAIL_FUNCTION_MAXIMUM_EVENT_AGE })],
    });

    this.deadLetterQueues = deadLetterQueues;
    const sum = { period: ALARM_PERIOD, statistic: "Sum" };
    const maximum = { period: ALARM_PERIOD, statistic: "Maximum" };
    const watched: ReadonlyArray<readonly [string, "ingress" | "delivery" | "status", lambdaNodejs.NodejsFunction, string]> = [
      ["MailIngress", "ingress", this.ingressFunction, "mailingress"],
      ["MailDelivery", "delivery", this.deliveryFunction, "maildelivery"],
      ["MailStatus", "status", this.statusFunction, "mailstatus"],
    ];
    for (const [functionId, key, target, suffix] of watched) {
      createChatticusAlarm(this, `${functionId}ErrorsAlarm`, {
        environmentName,
        nameSuffix: `${suffix}-errors`,
        metric: target.metricErrors(sum),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        summary: `The ${functionId} Lambda of the ${environmentName} mail stack raised errors in the last five minutes.`,
        lookAt: `the CloudWatch log group of the ${functionId} function for the error, and its dead-letter queue.`,
        topic: application.alarmTopic,
      });
      createChatticusAlarm(this, `${functionId}DeadLetterAlarm`, {
        environmentName,
        nameSuffix: `${suffix}-dead-letter`,
        metric: deadLetterQueues[key].metricApproximateNumberOfMessagesVisible(maximum),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        summary: `An invocation of ${functionId} in ${environmentName} failed after its retries and landed in its dead-letter queue; mail or a delivery status may be unprocessed.`,
        lookAt: `the ${functionId} dead-letter queue messages in SQS, which carry the event and the error; the raw mail stays in the archive for 30 days, so an inbound message can be replayed.`,
        topic: application.alarmTopic,
      });
    }
  }
}
