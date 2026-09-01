import assert from "node:assert/strict";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, it } from "node:test";
import {
  BUDGETS_OWNER_STACK_ID,
  readBudgetsConfig,
} from "../lib/budgets-config";
import { BudgetsStack } from "../lib/budgets-stack";
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

function synthBudgetsStack(
  monthlyLimitUsd = 120,
  notificationEmails: string[] = ["owner@example.com"],
) {
  const app = new cdk.App();
  const stack = new BudgetsStack(app, "TestBudgets", {
    env: testEnv,
    monthlyLimitUsd,
    notificationEmails,
  });
  return Template.fromStack(stack);
}

function synthSnapshotStack() {
  const app = new cdk.App();
  const stack = new SnapshotStack(app, "TestSnapshots", { env: testEnv });
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
    template.hasResource("AWS::Budgets::Budget", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
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
    template.hasResource("AWS::SNS::Topic", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
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

describe("BudgetsStack", () => {
  it("creates one budget and stack outputs", () => {
    const template = synthBudgetsStack();
    template.resourceCountIs("AWS::Budgets::Budget", 1);
    template.resourceCountIs("AWS::SNS::Topic", 1);
    template.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: {
        BudgetName: "chatticus-monthly-aws",
        BudgetLimit: {
          Amount: 120,
          Unit: "USD",
        },
      },
    });
    template.hasOutput("BudgetsAlertsTopicArn", {});
    template.hasOutput("BudgetsMonthlyLimitUsd", {
      Value: "120",
    });
  });
});

describe("SnapshotStack", () => {
  it("creates no budget resources", () => {
    const template = synthSnapshotStack();
    template.resourceCountIs("AWS::Budgets::Budget", 0);
    template.resourceCountIs("AWS::SNS::Topic", 0);
  });
});

describe("chatticus app budgets registration", () => {
  it("omits ChatticusBudgets when budget context is unset", () => {
    const app = new cdk.App();
    readBudgetsConfig(app);
    assert.equal(readBudgetsConfig(app), undefined);
    if (readBudgetsConfig(app)) {
      new BudgetsStack(app, "ChatticusBudgets", {
        env: testEnv,
        monthlyLimitUsd: 1,
        notificationEmails: ["owner@example.com"],
      });
    }
    const assembly = app.synth();
    assert.equal(
      assembly.stacks.some((stack) => stack.stackName === "ChatticusBudgets"),
      false,
    );
  });

  it("includes ChatticusBudgets when both budget context flags are set", () => {
    const app = new cdk.App({
      context: {
        budgetsMonthlyLimitUsd: "50",
        budgetsNotificationEmail: "owner@example.com",
      },
    });
    const budgetsConfig = readBudgetsConfig(app);
    assert.ok(budgetsConfig);
    new BudgetsStack(app, "ChatticusBudgets", {
      env: testEnv,
      monthlyLimitUsd: budgetsConfig.monthlyLimitUsd,
      notificationEmails: budgetsConfig.notificationEmails,
    });
    const assembly = app.synth();
    assert.ok(
      assembly.stacks.some((stack) => stack.stackName === "ChatticusBudgets"),
    );
  });
});
