import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import { Construct } from "constructs";

const DEFAULT_ACTUAL_THRESHOLDS = [50, 80, 100] as const;
const DEFAULT_FORECASTED_THRESHOLD = 100;
const DEFAULT_BUDGET_NAME = "chatticus-monthly-aws";

export interface ChatticusBudgetsProps {
  readonly monthlyLimitUsd: number;
  readonly notificationEmails: readonly string[];
  readonly actualThresholds?: readonly number[];
  readonly includeForecastedOverage?: boolean;
  readonly budgetName?: string;
  readonly displayName?: string;
}

/**
 * Account-level AWS spend budget for a Chatticus deployment account.
 *
 * OpenAI hard caps are console-only and are not modeled here.
 */
export class ChatticusBudgets extends Construct {
  readonly alertsTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: ChatticusBudgetsProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const {
      monthlyLimitUsd,
      notificationEmails,
      actualThresholds = DEFAULT_ACTUAL_THRESHOLDS,
      includeForecastedOverage = true,
      budgetName = DEFAULT_BUDGET_NAME,
      displayName = "Chatticus AWS spend alerts",
    } = props;

    this.alertsTopic = new sns.Topic(this, "Alerts", {
      displayName,
    });
    this.alertsTopic.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    for (const email of notificationEmails) {
      this.alertsTopic.addSubscription(new subscriptions.EmailSubscription(email));
    }
    this.alertsTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AWSBudgetsSNSPublishingPermissions",
        principals: [new iam.ServicePrincipal("budgets.amazonaws.com")],
        actions: ["sns:Publish"],
        resources: [this.alertsTopic.topicArn],
        conditions: {
          StringEquals: {
            "aws:SourceAccount": stack.account,
          },
          ArnLike: {
            "aws:SourceArn": `arn:aws:budgets::${stack.account}:*`,
          },
        },
      }),
    );

    const snsSubscriber = {
      subscriptionType: "SNS",
      address: this.alertsTopic.topicArn,
    };

    const notifications: budgets.CfnBudget.NotificationWithSubscribersProperty[] =
      actualThresholds.map((threshold) => ({
        notification: {
          comparisonOperator: "GREATER_THAN",
          notificationType: "ACTUAL",
          threshold,
          thresholdType: "PERCENTAGE",
        },
        subscribers: [snsSubscriber],
      }));

    if (includeForecastedOverage) {
      notifications.push({
        notification: {
          comparisonOperator: "GREATER_THAN",
          notificationType: "FORECASTED",
          threshold: DEFAULT_FORECASTED_THRESHOLD,
          thresholdType: "PERCENTAGE",
        },
        subscribers: [snsSubscriber],
      });
    }

    const monthlyAccountBudget = new budgets.CfnBudget(this, "MonthlyAccountBudget", {
      budget: {
        budgetName,
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: {
          amount: monthlyLimitUsd,
          unit: "USD",
        },
      },
      notificationsWithSubscribers: notifications,
    });
    monthlyAccountBudget.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
  }
}
