import assert from "node:assert/strict";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, it } from "node:test";
import {
  BUDGETS_OWNER_STACK_ID,
  readBudgetsConfig,
} from "../lib/budgets-config";
import { ChatticusBudgets } from "../lib/chatticus-budgets";
import { SnapshotStack } from "../lib/snapshot-stack";

const testEnv = {
  account: "111111111111",
  region: "us-east-1",
};

function synthChatticusBudgets(monthlyLimitUsd = 250, email = "owner@example.com") {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack", { env: testEnv });
  new ChatticusBudgets(stack, "Budgets", {
    monthlyLimitUsd,
    notificationEmails: [email],
  });
  return Template.fromStack(stack);
}

function synthSnapshotStack(budgetsConfig?: {
  monthlyLimitUsd: number;
  notificationEmails: string[];
}) {
  const app = new cdk.App();
  const stack = new SnapshotStack(app, "TestSnapshots", {
    env: testEnv,
    budgetsConfig,
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

describe("readBudgetsConfig", () => {
  it("returns undefined when both parameters are unset", () => {
    const app = new cdk.App();
    assert.equal(readBudgetsConfig(app), undefined);
  });

  it("throws when only monthly limit is set", () => {
    const app = new cdk.App({
      context: { budgetsMonthlyLimitUsd: "100" },
    });
    assertThrowsMessage(
      () => readBudgetsConfig(app),
      BUDGETS_OWNER_STACK_ID,
      "budgetsNotificationEmail",
    );
  });

  it("throws when only notification email is set", () => {
    const app = new cdk.App({
      context: { budgetsNotificationEmail: "owner@example.com" },
    });
    assertThrowsMessage(() => readBudgetsConfig(app), "budgetsMonthlyLimitUsd");
  });
});

describe("ChatticusBudgets", () => {
  it("creates budget notifications at 50/80/100 actual plus forecasted", () => {
    const template = synthChatticusBudgets();
    template.resourceCountIs("AWS::Budgets::Budget", 1);
    template.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: {
        BudgetName: "chatticus-monthly-aws",
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
    const template = synthChatticusBudgets(180, "alerts@example.com");
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

describe("SnapshotStack budgets", () => {
  it("creates no budget when budgetsConfig is omitted", () => {
    const template = synthSnapshotStack();
    template.resourceCountIs("AWS::Budgets::Budget", 0);
  });

  it("creates one budget when budgetsConfig is provided", () => {
    const template = synthSnapshotStack({
      monthlyLimitUsd: 120,
      notificationEmails: ["owner@example.com"],
    });
    template.resourceCountIs("AWS::Budgets::Budget", 1);
    template.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: {
        BudgetName: "chatticus-monthly-aws",
        BudgetLimit: {
          Amount: 120,
          Unit: "USD",
        },
      },
    });
  });
});
