import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as path from "path";
import { Construct } from "constructs";
import {
  ChatticusCloudEnvironment,
  thinTurnExportName,
  thinTurnParameterPrefix,
} from "./environments";
import { CHATTICUS_LOG_RETENTION } from "./log-retention";

/**
 * Permanent data-owning stack: the Messaging table, the invoke and operator
 * secrets with their SSM parameters, and the Node budget jobs.
 *
 * Every data resource is retained. The conversation compute lives in the
 * control-plane stack; nothing here serves a request.
 */
export interface ThinTurnStackProps extends cdk.StackProps {
  chatticusEnvironment: ChatticusCloudEnvironment;
  /** When set, budget alert recorder and rollup threshold SNS use this topic. */
  budgetsAlertsTopicArn?: string;
  /** Account monthly AWS budget limit; required for the daily rollup Lambda. */
  budgetsMonthlyLimitUsd?: number;
}

export class ThinTurnStack extends cdk.Stack {
  readonly messagingTable: dynamodb.ITable;
  readonly invokeSecret: secretsmanager.ISecret;
  readonly operatorSecret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: ThinTurnStackProps) {
    super(scope, id, props);

    const environmentName = props.chatticusEnvironment;
    const parameterPrefix = thinTurnParameterPrefix(environmentName);

    const table = new dynamodb.Table(this, "Messaging", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expires_at",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    this.messagingTable = table;

    const invokeSecret = new secretsmanager.Secret(this, "InvokeKey", {
      description: `Shared invoke key for the Chatticus ${environmentName} thin-turn front door.`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      generateSecretString: {
        passwordLength: 32,
        excludePunctuation: true,
      },
    });
    this.invokeSecret = invokeSecret;

    const operatorSecret = new secretsmanager.Secret(this, "OperatorKey", {
      description: `Operator bearer credential for the Chatticus ${environmentName} thin-turn front door.`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      generateSecretString: {
        passwordLength: 32,
        excludePunctuation: true,
      },
    });
    this.operatorSecret = operatorSecret;

    if (props.budgetsMonthlyLimitUsd !== undefined) {
      const budgetsAlertsTopicArn = props.budgetsAlertsTopicArn;
      const budgetJobsRoot = path.join(__dirname, "../../conversation/src/budget");
      const budgetJobBundling: lambdaNodejs.BundlingOptions = {
        target: "node22",
        sourceMap: true,
        externalModules: [],
      };
      const budgetJobEnv: Record<string, string> = {
        CHATTICUS_ENVIRONMENT: environmentName,
        CHATTICUS_MESSAGING_TABLE: table.tableName,
      };
      const rollupFunctionName = `chatticus-${environmentName}-daily-budget-rollup`;
      const rollupScheduleGroupName = `chatticus-${environmentName}-budget-rollup`;
      const rollupSchedulerRoleName = `chatticus-${environmentName}-budget-rollup-scheduler`;
      const rollupScheduleGroup = new scheduler.CfnScheduleGroup(
        this,
        "BudgetRollupGroup",
        { name: rollupScheduleGroupName },
      );
      const rollupFunction = new lambdaNodejs.NodejsFunction(this, "DailyBudgetRollup", {
        functionName: rollupFunctionName,
        entry: path.join(budgetJobsRoot, "rollup-handler.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.X86_64,
        bundling: budgetJobBundling,
        memorySize: 256,
        logRetention: CHATTICUS_LOG_RETENTION,
        timeout: cdk.Duration.seconds(120),
        description:
          "EventBridge Scheduler target: daily AWS and vendor budget rollup.",
        environment: {
          ...budgetJobEnv,
          CHATTICUS_BUDGETS_MONTHLY_LIMIT_USD: String(props.budgetsMonthlyLimitUsd),
          ...(budgetsAlertsTopicArn
            ? { CHATTICUS_BUDGETS_ALERTS_TOPIC_ARN: budgetsAlertsTopicArn }
            : {}),
        },
      });
      table.grantReadWriteData(rollupFunction);
      rollupFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ce:GetCostAndUsage", "ce:GetTags", "ce:ListCostAllocationTags"],
          resources: ["*"],
        }),
      );
      rollupFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["sts:AssumeRole"],
          resources: ["arn:aws:iam::*:role/ChatticusOrganizationComputerRole"],
        }),
      );
      if (budgetsAlertsTopicArn) {
        rollupFunction.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ["sns:Publish"],
            resources: [budgetsAlertsTopicArn],
          }),
        );
      }
      const rollupSchedulerRole = new iam.Role(this, "BudgetRollupSchedulerRole", {
        roleName: rollupSchedulerRoleName,
        assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
      });
      rollupFunction.grantInvoke(rollupSchedulerRole);
      new scheduler.CfnSchedule(this, "DailyBudgetRollupSchedule", {
        name: `chatticus-${environmentName}-daily-budget-rollup`,
        groupName: rollupScheduleGroup.ref,
        scheduleExpression: "cron(0 6 * * ? *)",
        scheduleExpressionTimezone: "UTC",
        flexibleTimeWindow: { mode: "OFF" },
        target: {
          arn: rollupFunction.functionArn,
          roleArn: rollupSchedulerRole.roleArn,
        },
      });
      rollupScheduleGroup.node.addDependency(rollupFunction);

      if (budgetsAlertsTopicArn) {
        const budgetsAlertsTopic = sns.Topic.fromTopicArn(
          this,
          "BudgetsAlertsTopic",
          budgetsAlertsTopicArn,
        );
        const alertRecorderFunction = new lambdaNodejs.NodejsFunction(this, "BudgetAlertRecorder", {
          entry: path.join(budgetJobsRoot, "alert-recorder-handler.ts"),
          handler: "handler",
          runtime: lambda.Runtime.NODEJS_22_X,
          architecture: lambda.Architecture.X86_64,
          bundling: budgetJobBundling,
          memorySize: 256,
          logRetention: CHATTICUS_LOG_RETENTION,
          timeout: cdk.Duration.seconds(30),
          description:
            "Record AWS Budgets SNS alerts on durable account rollup rows.",
          environment: budgetJobEnv,
        });
        table.grantReadWriteData(alertRecorderFunction);
        budgetsAlertsTopic.addSubscription(
          new subscriptions.LambdaSubscription(alertRecorderFunction),
        );
      }
    }

    const invokeKeySecretArnParameter = new ssm.StringParameter(
      this,
      "InvokeKeySecretArnParameter",
      {
        parameterName: `${parameterPrefix}/invoke-key-secret-arn`,
        stringValue: invokeSecret.secretArn,
        description: `Invoke-key secret ARN for the ${environmentName} thin-turn front door.`,
      },
    );
    invokeKeySecretArnParameter.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    const operatorKeySecretArnParameter = new ssm.StringParameter(
      this,
      "OperatorKeySecretArnParameter",
      {
        parameterName: `${parameterPrefix}/operator-key-secret-arn`,
        stringValue: operatorSecret.secretArn,
        description: `Operator-key secret ARN for the ${environmentName} thin-turn front door.`,
      },
    );
    operatorKeySecretArnParameter.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    new cdk.CfnOutput(this, "ChatticusEnvironment", { value: environmentName });
    new cdk.CfnOutput(this, "MessagingTableName", { value: table.tableName });
    new cdk.CfnOutput(this, "InvokeKeySecretArn", {
      value: invokeSecret.secretArn,
      exportName: thinTurnExportName(environmentName, "invoke-key-secret-arn"),
    });
    new cdk.CfnOutput(this, "InvokeKeySecretArnOutput", {
      value: invokeSecret.secretArn,
    });
    new cdk.CfnOutput(this, "OperatorKeySecretArn", {
      value: operatorSecret.secretArn,
      exportName: thinTurnExportName(environmentName, "operator-key-secret-arn"),
    });
    new cdk.CfnOutput(this, "OperatorKeySecretArnOutput", {
      value: operatorSecret.secretArn,
    });
  }
}
