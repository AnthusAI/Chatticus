import assert from "node:assert/strict";
import { Match } from "aws-cdk-lib/assertions";
import { describe, it } from "node:test";
import { CHATTICUS_CLOUD_ENVIRONMENTS } from "../lib/environments";
import { synthThinTurnStack } from "./thin-turn-stack-harness";

describe("ThinTurnStack daily budget rollup", () => {
  const topicArn = "arn:aws:sns:us-east-1:111111111111:chatticus-budgets-alerts";
  const template = synthThinTurnStack("development", {
    budgetsAlertsTopicArn: topicArn,
    budgetsMonthlyLimitUsd: 120,
  });

  it("creates a scheduled daily rollup Lambda with Cost Explorer access", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Handler: "index.handler",
      FunctionName: "chatticus-development-daily-budget-rollup",
      Environment: {
        Variables: Match.objectLike({
          CHATTICUS_BUDGETS_MONTHLY_LIMIT_USD: "120",
          CHATTICUS_BUDGETS_ALERTS_TOPIC_ARN: topicArn,
        }),
      },
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["ce:GetCostAndUsage", "ce:ListCostAllocationTags"]),
            Effect: "Allow",
          }),
        ]),
      },
    });
  });

  it("lets the rollup assume a customer organization role to read its spend", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Resource: "arn:aws:iam::*:role/ChatticusOrganizationComputerRole",
          }),
        ]),
      },
      Roles: Match.arrayWith([Match.objectLike({ Ref: Match.stringLikeRegexp("DailyBudgetRollupServiceRole") })]),
    });
  });

  it("schedules one daily EventBridge Scheduler rollup", () => {
    template.hasResourceProperties("AWS::Scheduler::Schedule", {
      ScheduleExpression: "cron(0 6 * * ? *)",
    });
  });

  it("references its schedule group so CloudFormation creates the group first", () => {
    // A literal group name gives CloudFormation no dependency edge, so it tried to
    // create the schedule before the group and failed with NotFound (chatticus-26f253).
    const groups = template.findResources("AWS::Scheduler::ScheduleGroup", {
      Properties: { Name: "chatticus-development-budget-rollup" },
    });
    const schedules = template.findResources("AWS::Scheduler::Schedule", {
      Properties: { ScheduleExpression: "cron(0 6 * * ? *)" },
    });
    const groupIds = Object.keys(groups);
    assert.equal(groupIds.length, 1);
    assert.equal(Object.keys(schedules).length, 1);
    assert.deepEqual(Object.values(schedules)[0].Properties.GroupName, { Ref: groupIds[0] });
  });

  it("records AWS Budgets alerts without republishing rollup messages", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Handler: "index.handler",
      Description: "Record AWS Budgets SNS alerts on durable account rollup rows.",
    });
    template.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "lambda",
    });
  });
});

describe("ThinTurnStack data retention", () => {
  const retainedResources: Array<[string, string]> = [
    ["AWS::DynamoDB::Table", "Messaging4C94D7F8"],
    ["AWS::SecretsManager::Secret", "InvokeKey" + "581783BE"],
    ["AWS::SecretsManager::Secret", "OperatorKey" + "D7C0C4F2"],
  ];

  for (const environmentName of CHATTICUS_CLOUD_ENVIRONMENTS) {
    describe(environmentName, () => {
      const template = synthThinTurnStack(environmentName);
      const parameterPrefix = `/chatticus/${environmentName}/thin-turn`;

      for (const [resourceType, logicalId] of retainedResources) {
        it(`keeps ${logicalId} under its logical id with Retain policies`, () => {
          const resource = template.findResources(resourceType)[logicalId];
          assert.ok(resource, `expected ${logicalId} to exist`);
          assert.equal(resource.DeletionPolicy, "Retain");
          assert.equal(resource.UpdateReplacePolicy, "Retain");
        });
      }

      it("leaves the table unnamed and protects it in place", () => {
        const table = template.findResources("AWS::DynamoDB::Table")["Messaging4C94D7F8"];
        assert.equal(table.Properties.TableName, undefined);
        assert.equal(table.Properties.DeletionProtectionEnabled, true);
        assert.deepEqual(table.Properties.PointInTimeRecoverySpecification, {
          PointInTimeRecoveryEnabled: true,
        });
      });

      for (const holder of ["invoke", "operator"]) {
        it(`retains the ${holder} secret ARN SSM parameter`, () => {
          const matches = Object.values(
            template.findResources("AWS::SSM::Parameter", {
              Properties: { Name: `${parameterPrefix}/${holder}-key-secret-arn` },
            }),
          );
          assert.equal(matches.length, 1);
          assert.equal(matches[0].DeletionPolicy, "Retain");
          assert.equal(matches[0].UpdateReplacePolicy, "Retain");
        });
      }
    });
  }
});

describe("ThinTurnStack without budget context", () => {
  it("has no Lambda function at all", () => {
    const template = synthThinTurnStack("development");
    template.resourceCountIs("AWS::Lambda::Function", 0);
    template.resourceCountIs("AWS::SNS::Subscription", 0);
    template.resourceCountIs("AWS::Scheduler::ScheduleGroup", 0);
  });
});

const BUDGET_CONTEXT = {
  budgetsAlertsTopicArn: "arn:aws:sns:us-east-1:111111111111:chatticus-budgets-alerts",
  budgetsMonthlyLimitUsd: 120,
};

const KEPT_LOGICAL_IDS = [
  "Messaging4C94D7F8",
  "InvokeKey" + "581783BE",
  "OperatorKey" + "D7C0C4F2",
  "InvokeKeySecretArnParameter" + "774B7228",
  "OperatorKeySecretArnParameter" + "8FF1C056",
  "BudgetRollupGroup",
  "DailyBudgetRollup1695A8BE",
  "BudgetRollupSchedulerRole1B54F783",
  "DailyBudgetRollupSchedule",
  "BudgetAlertRecorder40165C31",
  "BudgetAlertRecorderBudgetsAlertsTopicC225071F",
];

const DELETED_LOGICAL_ID_PREFIXES = [
  "FrontDoor",
  "ComputerWorker",
  "ComputerlessWorker",
  "TurnDeadline",
  "TurnJobs",
  "ComputerTurnJobs",
  "FunctionUrlParameter",
  "TurnQueueUrlParameter",
  "TurnQueueArnParameter",
  "ComputerTurnQueueUrlParameter",
  "ComputerTurnQueueArnParameter",
  "ImportedComputerHostTaskRole",
];

describe("ThinTurnStack shrunk to its data and budget jobs", () => {
  for (const environmentName of CHATTICUS_CLOUD_ENVIRONMENTS) {
    describe(environmentName, () => {
      const template = synthThinTurnStack(environmentName, BUDGET_CONTEXT);
      const resources = template.toJSON().Resources as Record<string, { Type: string }>;
      const logicalIds = Object.keys(resources);

      it("keeps every data and budget resource under its original logical id", () => {
        for (const kept of KEPT_LOGICAL_IDS) {
          assert.ok(logicalIds.includes(kept), `expected ${kept}`);
        }
      });

      it("keeps both secret ARN parameters", () => {
        const names = Object.values(
          template.findResources("AWS::SSM::Parameter"),
        ).map((resource) => JSON.stringify(resource.Properties.Name));
        assert.deepEqual(names.sort(), [
          JSON.stringify(`/chatticus/${environmentName}/thin-turn/invoke-key-secret-arn`),
          JSON.stringify(`/chatticus/${environmentName}/thin-turn/operator-key-secret-arn`),
        ]);
      });

      it("keeps the budget rollup, its schedule, the recorder and the topic subscription", () => {
        template.resourceCountIs("AWS::SNS::Subscription", 1);
        template.resourceCountIs("AWS::Scheduler::Schedule", 1);
        const functionNames = Object.values(
          template.findResources("AWS::Lambda::Function"),
        ).map((resource) => resource.Properties.FunctionName);
        assert.ok(functionNames.includes(`chatticus-${environmentName}-daily-budget-rollup`));
      });

      it("keeps the physical names of the budget schedule group and role", () => {
        template.hasResourceProperties("AWS::Scheduler::ScheduleGroup", {
          Name: `chatticus-${environmentName}-budget-rollup`,
        });
        template.hasResourceProperties("AWS::IAM::Role", {
          RoleName: `chatticus-${environmentName}-budget-rollup-scheduler`,
        });
      });

      it("has no deleted Python-era logical id", () => {
        for (const prefix of DELETED_LOGICAL_ID_PREFIXES) {
          assert.deepEqual(
            logicalIds.filter((id) => id.startsWith(prefix)),
            [],
            `${prefix} must be gone`,
          );
        }
      });

      it("has only the two Node budget Lambda functions plus the CDK log retention helper", () => {
        const functions = Object.entries(template.findResources("AWS::Lambda::Function"));
        const own = functions.filter(([logicalId]) => !logicalId.startsWith("LogRetention"));
        assert.deepEqual(
          own.map(([logicalId]) => logicalId).sort(),
          ["BudgetAlertRecorder40165C31", "DailyBudgetRollup1695A8BE"],
        );
        for (const [, lambdaFunction] of own) {
          assert.equal(lambdaFunction.Properties.Runtime, "nodejs22.x");
        }
        assert.equal(functions.length, 3);
        assert.equal(/python/i.test(JSON.stringify(template.toJSON())), false);
      });

      it("has no queue, no function URL, no event source mapping and no layer", () => {
        template.resourceCountIs("AWS::SQS::Queue", 0);
        template.resourceCountIs("AWS::Lambda::Url", 0);
        template.resourceCountIs("AWS::Lambda::EventSourceMapping", 0);
        assert.equal(JSON.stringify(template.toJSON()).includes("LambdaAdapterLayer"), false);
      });

      it("has only the budget schedule group", () => {
        const groups = Object.values(template.findResources("AWS::Scheduler::ScheduleGroup"));
        assert.equal(groups.length, 1);
        assert.equal(groups[0].Properties.Name, `chatticus-${environmentName}-budget-rollup`);
      });

      it("keeps only the two secret ARN exports", () => {
        const exportNames = Object.values(
          (template.toJSON().Outputs ?? {}) as Record<string, any>,
        )
          .map((output) => output.Export?.Name as string | undefined)
          .filter((name): name is string => name !== undefined)
          .sort();
        assert.deepEqual(exportNames, [
          `Chatticus-${environmentName}-thin-turn-invoke-key-secret-arn`,
          `Chatticus-${environmentName}-thin-turn-operator-key-secret-arn`,
        ]);
      });
    });
  }
});
