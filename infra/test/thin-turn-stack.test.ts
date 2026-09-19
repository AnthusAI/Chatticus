import assert from "node:assert/strict";
import { Match } from "aws-cdk-lib/assertions";
import { describe, it } from "node:test";
import {
  CHATTICUS_CLOUD_ENVIRONMENTS,
  openAiApiKeyParameterName,
} from "../lib/environments";
import { synthThinTurnStack } from "./thin-turn-stack-harness";

const SHARED_DESK_OPENAI_PARAMETER = "/amplify/shared/papyrus/OPENAI_API_KEY";

function lambdaEnvironment(template: ReturnType<typeof synthThinTurnStack>): string {
  const resources = template.findResources("AWS::Lambda::Function");
  return JSON.stringify(resources);
}

describe("ThinTurnStack OpenAI key", () => {
  for (const environmentName of CHATTICUS_CLOUD_ENVIRONMENTS) {
    describe(environmentName, () => {
      const openAiParameterName = openAiApiKeyParameterName(environmentName);
      const template = synthThinTurnStack(environmentName);

      it("reads the deployment-scoped SSM parameter, not the shared desk key", () => {
        const serialized = lambdaEnvironment(template);
        assert.ok(
          serialized.includes(openAiParameterName),
          `expected ${openAiParameterName} in Lambda environment`,
        );
        assert.equal(
          serialized.includes(SHARED_DESK_OPENAI_PARAMETER),
          false,
          "must not reference the shared desk OpenAI parameter",
        );
      });

      it("sets OPENAI_API_KEY_PARAMETER on front door and worker Lambdas", () => {
        template.hasResourceProperties("AWS::Lambda::Function", {
          Environment: {
            Variables: Match.objectLike({
              OPENAI_API_KEY_PARAMETER: openAiParameterName,
            }),
          },
        });
      });

      it("grants SSM read on the deployment OpenAI parameter", () => {
        template.hasResourceProperties("AWS::IAM::Policy", {
          PolicyDocument: {
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: "ssm:GetParameter",
                Resource: Match.arrayWith([
                  `arn:aws:ssm:us-east-1:111111111111:parameter${openAiParameterName}`,
                ]),
              }),
            ]),
          },
        });
      });

      it("grants Front Door AssumeRole on customer cross-account computer roles", () => {
        template.hasResourceProperties("AWS::IAM::Policy", {
          PolicyDocument: {
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: "sts:AssumeRole",
                Resource: "arn:aws:iam::*:role/ChatticusOrganizationComputerRole",
              }),
            ]),
          },
        });
      });

      it("sets CHATTICUS_SIGNUP_MODE to open on Anthus deployments", () => {
        template.hasResourceProperties("AWS::Lambda::Function", {
          Environment: {
            Variables: Match.objectLike({
              CHATTICUS_SIGNUP_MODE: "open",
            }),
          },
        });
      });
    });
  }
});

describe("ThinTurnStack daily budget rollup", () => {
  const topicArn = "arn:aws:sns:us-east-1:111111111111:chatticus-budgets-alerts";
  const template = synthThinTurnStack("development", {
    budgetsAlertsTopicArn: topicArn,
    budgetsMonthlyLimitUsd: 120,
  });

  it("creates a scheduled daily rollup Lambda with Cost Explorer access", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "chatticus.budget_rollup.lambda_handler.handler",
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
            Action: Match.arrayWith(["ce:GetCostAndUsage"]),
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
      Handler: "chatticus.budget_rollup.alert_recorder.handler",
    });
    template.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "lambda",
    });
  });
});

describe("ThinTurnStack without budget context", () => {
  it("omits daily rollup Lambdas", () => {
    const template = synthThinTurnStack("development");
    const resources = template.findResources("AWS::Lambda::Function");
    const serialized = JSON.stringify(resources);
    assert.equal(serialized.includes("budget_rollup.lambda_handler"), false);
    assert.equal(serialized.includes("budget_rollup.alert_recorder"), false);
  });
});
