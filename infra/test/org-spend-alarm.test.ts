import assert from "node:assert/strict";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, it } from "node:test";
import {
  ORG_SPEND_ALARM_STACK_ID,
  readOrgSpendAlarmConfig,
} from "../lib/org-spend-alarm-config";
import { OrgSpendAlarmStack } from "../lib/org-spend-alarm-stack";

const testEnv = {
  account: "111111111111",
  region: "us-east-1",
};

function synthOrgSpendAlarmStack(monthlyUsd = 250, email = "owner@example.com") {
  const app = new cdk.App();
  const stack = new OrgSpendAlarmStack(app, "TestOrgSpendAlarm", {
    env: testEnv,
    config: { monthlyUsd, notificationEmail: email },
  });
  return Template.fromStack(stack);
}

function assertThrowsMessage(fn: () => unknown, ...needles: string[]): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof Error);
    for (const needle of needles) {
      assert.match(error.message, new RegExp(needle));
    }
    return true;
  });
}

describe("readOrgSpendAlarmConfig", () => {
  it("returns undefined when both parameters are unset", () => {
    const app = new cdk.App();
    assert.equal(readOrgSpendAlarmConfig(app), undefined);
  });

  it("throws when only monthly USD is set", () => {
    const app = new cdk.App({
      context: { orgSpendMonthlyUsd: "100" },
    });
    assertThrowsMessage(
      () => readOrgSpendAlarmConfig(app),
      ORG_SPEND_ALARM_STACK_ID,
      "orgSpendNotificationEmail",
    );
  });

  it("throws when only notification email is set", () => {
    const app = new cdk.App({
      context: { orgSpendNotificationEmail: "owner@example.com" },
    });
    assertThrowsMessage(
      () => readOrgSpendAlarmConfig(app),
      "orgSpendMonthlyUsd",
    );
  });
});

describe("OrgSpendAlarmStack", () => {
  it("creates budget notifications at 50/80/100 actual plus forecasted", () => {
    const template = synthOrgSpendAlarmStack();
    template.resourceCountIs("AWS::Budgets::Budget", 1);
    template.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: {
        BudgetName: "chatticus-org-monthly-aws",
        BudgetType: "COST",
        TimeUnit: "MONTHLY",
        BudgetLimit: {
          Amount: 250,
          Unit: "USD",
        },
      },
      NotificationsWithSubscribers: [
        {
          Notification: {
            ComparisonOperator: "GREATER_THAN",
            NotificationType: "ACTUAL",
            Threshold: 50,
            ThresholdType: "PERCENTAGE",
          },
        },
        {
          Notification: {
            ComparisonOperator: "GREATER_THAN",
            NotificationType: "ACTUAL",
            Threshold: 80,
            ThresholdType: "PERCENTAGE",
          },
        },
        {
          Notification: {
            ComparisonOperator: "GREATER_THAN",
            NotificationType: "ACTUAL",
            Threshold: 100,
            ThresholdType: "PERCENTAGE",
          },
        },
        {
          Notification: {
            ComparisonOperator: "GREATER_THAN",
            NotificationType: "FORECASTED",
            Threshold: 100,
            ThresholdType: "PERCENTAGE",
          },
        },
      ],
    });
  });

  it("routes budget alerts through SNS to the owner email", () => {
    const template = synthOrgSpendAlarmStack(180, "alerts@example.com");
    template.resourceCountIs("AWS::SNS::Topic", 1);
    template.resourceCountIs("AWS::SNS::Subscription", 1);
    template.hasResourceProperties("AWS::SNS::Subscription", {
      Endpoint: "alerts@example.com",
      Protocol: "email",
    });
    template.hasResourceProperties("AWS::SNS::TopicPolicy", {
      PolicyDocument: {
        Statement: [
          {
            Action: "sns:Publish",
            Effect: "Allow",
            Principal: { Service: "budgets.amazonaws.com" },
            Sid: "AWSBudgetsSNSPublishingPermissions",
          },
        ],
      },
    });
    template.hasResourceProperties("AWS::Budgets::Budget", {
      NotificationsWithSubscribers: Match.arrayWith([
        Match.objectLike({
          Subscribers: [Match.objectLike({ SubscriptionType: "SNS" })],
        }),
      ]),
    });
  });
});
