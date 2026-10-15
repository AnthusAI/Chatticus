import assert from "node:assert/strict";
import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Template } from "aws-cdk-lib/assertions";
import { describe, it } from "node:test";
import {
  AccountGitHubDeployStack,
  COMPUTER_IMAGE_PUSH_ACTIONS,
} from "../lib/account-github-deploy-stack";
import { computerRepositoryNamePrefix, ComputerStack } from "../lib/computer-stack";

const ENV = { account: "222222222222", region: "us-east-1" };

interface Statement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: unknown;
}

function synthAccountDeploy(githubEnvironment: "development" | "staging" | "production"): Template {
  const app = new cdk.App();
  return Template.fromStack(
    new AccountGitHubDeployStack(app, "ChatticusAccountDeploy", { env: ENV, githubEnvironment }),
  );
}

function allowStatements(template: Template): Statement[] {
  const policies = template.findResources("AWS::IAM::Policy");
  return Object.values(policies).flatMap(
    (policy) => (policy.Properties as { PolicyDocument: { Statement: Statement[] } }).PolicyDocument.Statement,
  );
}

function actionsOf(statement: Statement): string[] {
  return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
}

function resourceArn(statement: Statement): string {
  return JSON.stringify(statement.Resource);
}

describe("AccountGitHubDeployStack computer image publishing", () => {
  const statements = allowStatements(synthAccountDeploy("development"));
  const pushStatement = statements.find((statement) => statement.Sid === "ComputerImagePush");

  it("grants the ECR login token on every resource and nothing else on every resource", () => {
    const wildcard = statements.filter((statement) => JSON.stringify(statement.Resource) === '"*"');
    assert.equal(wildcard.length, 1);
    assert.deepEqual(actionsOf(wildcard[0]), ["ecr:GetAuthorizationToken"]);
  });

  it("grants exactly the push actions on the Computers repository of this account only", () => {
    assert.ok(pushStatement);
    assert.equal(pushStatement.Effect, "Allow");
    assert.deepEqual(actionsOf(pushStatement).sort(), [...COMPUTER_IMAGE_PUSH_ACTIONS].sort());
    const arn = resourceArn(pushStatement);
    assert.match(arn, /arn:/);
    assert.match(arn, /:ecr:us-east-1:222222222222:repository\/chatticuscomputers-computerimage\*/);
    assert.ok(!Array.isArray(pushStatement.Resource));
    assert.equal(arn.includes('"*"'), false);
  });

  it("scopes no ECR action to any other repository", () => {
    for (const statement of statements) {
      if (!actionsOf(statement).some((action) => action.startsWith("ecr:"))) continue;
      if (statement.Sid === "EcrLoginToken") continue;
      assert.equal(statement.Sid, "ComputerImagePush");
    }
  });

  it("reads only the ChatticusComputers stack outputs", () => {
    const describe = statements.find((statement) => statement.Sid === "ComputerStackOutputs");
    assert.ok(describe);
    assert.deepEqual(actionsOf(describe), ["cloudformation:DescribeStacks"]);
    assert.match(resourceArn(describe), /:cloudformation:us-east-1:222222222222:stack\/ChatticusComputers\/\*/);
  });

  it("grants no image publishing in the staging or production accounts", () => {
    for (const environment of ["staging", "production"] as const) {
      const other = allowStatements(synthAccountDeploy(environment));
      assert.equal(
        other.some((statement) => actionsOf(statement).some((action) => action.startsWith("ecr:"))),
        false,
        environment,
      );
    }
  });

  it("creates no IAM user (access keys are guarded repository-wide by no-iam-access-keys)", () => {
    synthAccountDeploy("development").resourceCountIs("AWS::IAM::User", 0);
  });
});

describe("computer repository name prefix", () => {
  it("matches the name CloudFormation generates for the synthesized repository", () => {
    const app = new cdk.App();
    const support = new cdk.Stack(app, "Support", { env: ENV });
    const stack = new ComputerStack(app, "ChatticusComputers", {
      env: ENV,
      chatticusEnvironment: "development",
      snapshotBucket: new s3.Bucket(support, "Snapshots"),
    });
    const repositories = Template.fromStack(stack).findResources("AWS::ECR::Repository");
    const logicalIds = Object.keys(repositories);
    assert.equal(logicalIds.length, 1);
    assert.ok(`${stack.stackName}-${logicalIds[0]}`.toLowerCase().startsWith(computerRepositoryNamePrefix("development")));
    assert.equal(
      (repositories[logicalIds[0]].Properties as { RepositoryName?: string }).RepositoryName,
      undefined,
    );
  });
});
