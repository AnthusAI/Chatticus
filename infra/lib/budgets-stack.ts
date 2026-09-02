import * as cdk from "aws-cdk-lib";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";
import { BudgetsConfig } from "./budgets-config";
import { ChatticusBudgets } from "./chatticus-budgets";

export interface BudgetsStackProps extends cdk.StackProps, BudgetsConfig {}

/**
 * Account-level AWS spend budget and alert topic for a Chatticus deployment
 * account. Deploy only via deploy-chatticus-budgets.sh with both budget env
 * vars set.
 */
export class BudgetsStack extends cdk.Stack {
  readonly alertsTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: BudgetsStackProps) {
    super(scope, id, props);

    const budgets = new ChatticusBudgets(this, "Budgets", {
      monthlyLimitUsd: props.monthlyLimitUsd,
      notificationEmails: props.notificationEmails,
    });
    this.alertsTopic = budgets.alertsTopic;

    new cdk.CfnOutput(this, "BudgetsAlertsTopicArn", {
      value: budgets.alertsTopic.topicArn,
      description: "SNS topic for account-level AWS spend budget alerts.",
    });
    new cdk.CfnOutput(this, "BudgetsMonthlyLimitUsd", {
      value: String(props.monthlyLimitUsd),
      description: "Configured monthly AWS spend budget limit (USD).",
    });
  }
}
