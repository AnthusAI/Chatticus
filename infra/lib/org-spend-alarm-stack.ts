import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import { Construct } from "constructs";
import { OrgSpendAlarmConfig } from "./org-spend-alarm-config";

export interface OrgSpendAlarmStackProps extends cdk.StackProps {
  readonly config: OrgSpendAlarmConfig;
}

/**
 * Account-level AWS spend alarm for a Chatticus deployment account.
 *
 * OpenAI hard caps are console-only and are not modeled here.
 */
export class OrgSpendAlarmStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OrgSpendAlarmStackProps) {
    super(scope, id, props);

    const { monthlyUsd, notificationEmail } = props.config;

    const alertsTopic = new sns.Topic(this, "OrgSpendAlerts", {
      displayName: "Chatticus org AWS spend alerts",
    });
    alertsTopic.addSubscription(
      new subscriptions.EmailSubscription(notificationEmail),
    );
    alertsTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AWSBudgetsSNSPublishingPermissions",
        principals: [new iam.ServicePrincipal("budgets.amazonaws.com")],
        actions: ["sns:Publish"],
        resources: [alertsTopic.topicArn],
        conditions: {
          StringEquals: {
            "aws:SourceAccount": this.account,
          },
          ArnLike: {
            "aws:SourceArn": `arn:aws:budgets::${this.account}:*`,
          },
        },
      }),
    );

    const snsSubscriber = {
      subscriptionType: "SNS",
      address: alertsTopic.topicArn,
    };

    const actualThresholds = [50, 80, 100];
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

    notifications.push({
      notification: {
        comparisonOperator: "GREATER_THAN",
        notificationType: "FORECASTED",
        threshold: 100,
        thresholdType: "PERCENTAGE",
      },
      subscribers: [snsSubscriber],
    });

    new budgets.CfnBudget(this, "MonthlyAccountBudget", {
      budget: {
        budgetName: "chatticus-org-monthly-aws",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: {
          amount: monthlyUsd,
          unit: "USD",
        },
      },
      notificationsWithSubscribers: notifications,
    });

    new cdk.CfnOutput(this, "OrgSpendAlertsTopicArn", {
      value: alertsTopic.topicArn,
      description: "SNS topic for account-level AWS spend budget alerts.",
    });

    new cdk.CfnOutput(this, "OrgSpendMonthlyLimitUsd", {
      value: String(monthlyUsd),
      description: "Configured monthly AWS spend budget limit (USD).",
    });
  }
}
