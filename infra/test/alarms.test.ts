import assert from "node:assert/strict";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, it } from "node:test";
import { ControlPlaneStack } from "../lib/control-plane-stack";
import {
  CHATTICUS_CLOUD_ENVIRONMENTS,
  ChatticusCloudEnvironment,
  THIN_TURN_STACK_IDS,
} from "../lib/environments";
import { ThinTurnStack } from "../lib/thin-turn-stack";

const ENV = { account: "111111111111", region: "us-east-1" };
const EMAIL_PATTERN = /[A-Za-z0-9._+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+/;
const CONTEXT_EMAIL = "owner-alerts@example.test";

function synthControlPlane(
  environmentName: ChatticusCloudEnvironment,
  context: Record<string, string> = {},
): Template {
  const app = new cdk.App({ context: { computerHostStart: "noop", ...context } });
  const thinTurn = new ThinTurnStack(app, THIN_TURN_STACK_IDS[environmentName], {
    env: ENV,
    chatticusEnvironment: environmentName,
  });
  const stack = new ControlPlaneStack(app, "ControlPlane", {
    env: ENV,
    chatticusEnvironment: environmentName,
    messagingTable: thinTurn.messagingTable,
  });
  return Template.fromStack(stack);
}

function alarmsOf(template: Template): Record<string, Record<string, any>> {
  const resources = template.findResources("AWS::CloudWatch::Alarm");
  const byName: Record<string, Record<string, any>> = {};
  for (const resource of Object.values(resources)) {
    byName[resource.Properties.AlarmName] = resource.Properties;
  }
  return byName;
}

const CONTROL_PLANE_ALARM_SUFFIXES = [
  "frontdoor-errors",
  "turnexecutor-errors",
  "turnprobe-errors",
  "computerstarter-errors",
  "frontdoor-5xx",
  "lambda-throttles",
  "turnruns-dead-letter",
  "turnprobes-dead-letter",
  "computerstartjobs-dead-letter",
  "turnruns-oldest-message-age",
  "conversations-table-throttles",
  "messaging-table-throttles",
];

describe("production alarms", () => {
  for (const environmentName of CHATTICUS_CLOUD_ENVIRONMENTS) {
    describe(environmentName, () => {
      const controlPlane = synthControlPlane(environmentName);
      const alarms = alarmsOf(controlPlane);

      it("names every control plane alarm with the environment prefix", () => {
        for (const suffix of CONTROL_PLANE_ALARM_SUFFIXES) {
          assert.ok(
            alarms[`chatticus-${environmentName}-${suffix}`],
            `alarm chatticus-${environmentName}-${suffix} exists`,
          );
        }
        for (const name of Object.keys(alarms)) {
          assert.ok(name.startsWith(`chatticus-${environmentName}-`), `${name} is prefixed`);
        }
      });

      it("wires every control plane alarm to the notification topic and nothing else", () => {
        for (const [name, alarm] of Object.entries(alarms)) {
          assert.equal(alarm.AlarmActions.length, 1, `${name} has one alarm action`);
          assert.ok(alarm.AlarmActions[0].Ref, `${name} targets the topic of its own stack`);
          assert.equal(alarm.TreatMissingData, "notBreaching", `${name} treats missing data as healthy`);
          assert.ok(
            String(alarm.AlarmDescription).includes("Look at"),
            `${name} says what to look at`,
          );
        }
      });

      it("alarms on any Lambda error over five minutes", () => {
        controlPlane.hasResourceProperties("AWS::CloudWatch::Alarm", {
          AlarmName: `chatticus-${environmentName}-frontdoor-errors`,
          Namespace: "AWS/Lambda",
          MetricName: "Errors",
          Statistic: "Sum",
          Period: 300,
          Threshold: 0,
          ComparisonOperator: "GreaterThanThreshold",
        });
      });

      it("alarms on a dead-letter queue holding any message", () => {
        controlPlane.hasResourceProperties("AWS::CloudWatch::Alarm", {
          AlarmName: `chatticus-${environmentName}-turnruns-dead-letter`,
          Namespace: "AWS/SQS",
          MetricName: "ApproximateNumberOfMessagesVisible",
          Threshold: 1,
          ComparisonOperator: "GreaterThanOrEqualToThreshold",
        });
      });

      it("alarms when the oldest turn job is older than fifteen minutes", () => {
        controlPlane.hasResourceProperties("AWS::CloudWatch::Alarm", {
          AlarmName: `chatticus-${environmentName}-turnruns-oldest-message-age`,
          MetricName: "ApproximateAgeOfOldestMessage",
          Threshold: 900,
        });
      });

      it("covers the FrontDoor function URL 5xx metric", () => {
        controlPlane.hasResourceProperties("AWS::CloudWatch::Alarm", {
          AlarmName: `chatticus-${environmentName}-frontdoor-5xx`,
          Namespace: "AWS/Lambda",
          MetricName: "Url5xxCount",
        });
      });

      it("lets CloudWatch publish to the topic of its own account", () => {
        controlPlane.hasResourceProperties("AWS::SNS::TopicPolicy", {
          PolicyDocument: {
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: "sns:Publish",
                Principal: { Service: "cloudwatch.amazonaws.com" },
              }),
            ]),
          },
        });
      });
    });
  }

  describe("with the owner on the notification topic", () => {
    it("subscribes the email from the budgets notification context only", () => {
      const template = synthControlPlane("production", {
        budgetsNotificationEmail: CONTEXT_EMAIL,
      });
      template.hasResourceProperties("AWS::SNS::Subscription", {
        Protocol: "email",
        Endpoint: CONTEXT_EMAIL,
        TopicArn: Match.anyValue(),
      });
    });

    it("synthesizes no email address and no subscription without the context", () => {
      const template = synthControlPlane("production");
      template.resourceCountIs("AWS::SNS::Subscription", 0);
      assert.doesNotMatch(JSON.stringify(template.toJSON()), EMAIL_PATTERN);
    });
  });
});
