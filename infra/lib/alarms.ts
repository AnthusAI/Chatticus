import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import { Construct } from "constructs";
import { ChatticusCloudEnvironment } from "./environments";

/** Five minutes: the period of every Chatticus alarm metric. */
export const ALARM_PERIOD = cdk.Duration.minutes(5);

/** The oldest queued turn job tolerated before the queue is called backed up. */
export const TURN_QUEUE_OLDEST_MESSAGE_SECONDS = 900;

/** FrontDoor function URL 5xx responses in one period before the alarm fires; a single stray response does not page. */
export const FRONT_DOOR_5XX_THRESHOLD = 3;

export interface ChatticusAlarmTopicProps {
  readonly environmentName: ChatticusCloudEnvironment;
  readonly notificationEmail?: string;
}

/**
 * The SNS topic every Chatticus alarm of one environment notifies.
 *
 * CloudWatch of the same account may publish to it. When an address is given
 * it is subscribed by email and AWS sends a confirmation message the owner
 * must accept; the address reaches this construct only through CDK context.
 */
export class ChatticusAlarmTopic extends Construct {
  readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: ChatticusAlarmTopicProps) {
    super(scope, id);
    this.topic = new sns.Topic(this, "Topic", {
      topicName: `chatticus-${props.environmentName}-alarms`,
      displayName: `Chatticus ${props.environmentName} alarms`,
    });
    this.topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowCloudWatchAlarmsOfThisAccountToPublish",
        principals: [new iam.ServicePrincipal("cloudwatch.amazonaws.com")],
        actions: ["sns:Publish"],
        resources: [this.topic.topicArn],
        conditions: {
          StringEquals: { "aws:SourceAccount": cdk.Stack.of(this).account },
        },
      }),
    );
    if (props.notificationEmail !== undefined) {
      this.topic.addSubscription(new subscriptions.EmailSubscription(props.notificationEmail));
    }
  }
}

export interface ChatticusAlarmProps {
  readonly environmentName: ChatticusCloudEnvironment;
  readonly nameSuffix: string;
  readonly metric: cloudwatch.IMetric;
  readonly threshold: number;
  readonly comparisonOperator: cloudwatch.ComparisonOperator;
  readonly summary: string;
  readonly lookAt: string;
  readonly topic: sns.ITopic;
}

/**
 * One alarm of the single Chatticus alarm code path: named with the
 * environment, one evaluation period, missing data healthy, notifying the
 * environment topic with a description that says what to look at.
 */
export function createChatticusAlarm(
  scope: Construct,
  id: string,
  props: ChatticusAlarmProps,
): cloudwatch.Alarm {
  const alarm = new cloudwatch.Alarm(scope, id, {
    alarmName: `chatticus-${props.environmentName}-${props.nameSuffix}`,
    alarmDescription: `${props.summary} Look at: ${props.lookAt}`,
    metric: props.metric,
    threshold: props.threshold,
    comparisonOperator: props.comparisonOperator,
    evaluationPeriods: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  alarm.addAlarmAction(new cloudwatchActions.SnsAction(props.topic));
  return alarm;
}
