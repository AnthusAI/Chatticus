import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { CustomerComputersStack } from "../lib/customer-computers-stack";

function iamResourceTargetsEcrRepository(resource: unknown): boolean {
  const serialized = JSON.stringify(resource);
  return (
    serialized.includes("ComputerImage")
    || serialized.includes("Fn::GetAtt")
    || serialized.includes(":repository/")
  );
}

function iamResourceIsWildcard(resource: unknown): boolean {
  return resource === "*";
}

describe("CustomerComputersStack", () => {
  it("creates Fargate wiring with customer ECR and no snapshot bucket", () => {
    const app = new cdk.App();
    const stack = new CustomerComputersStack(app, "TestCustomerComputers");
    const template = Template.fromStack(stack);

    template.resourceCountIs("AWS::S3::Bucket", 0);
    template.resourceCountIs("AWS::ECR::Repository", 1);
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            { Name: "CHATTICUS_LIVE_ROOT", Value: "/var/lib/chatticus/computer" },
            {
              Name: "CHATTICUS_SNAPSHOT_BUCKET",
              Value: { Ref: "SnapshotBucketName" },
            },
            {
              Name: "CHATTICUS_TENANT_ID",
              Value: { Ref: "TenantId" },
            },
          ]),
        }),
      ]),
    });
    template.hasParameter("TenantId", { Type: "String" });
    template.hasParameter("SnapshotBucketName", { Type: "String" });
    const parameters = template.toJSON().Parameters ?? {};
    assert.equal(Object.keys(parameters).length, 2);
    assert.equal("AnthusComputerImageUri" in parameters, false);
    assert.equal("BootstrapVersion" in parameters, false);
    const rules = template.toJSON().Rules;
    assert.equal(rules === undefined || !("CheckBootstrapVersion" in rules), true);
    const templateJson = JSON.stringify(template.toJSON());
    assert.equal(templateJson.includes("AWS::SSM::Parameter::Value"), false);
    assert.equal(templateJson.includes("/cdk-bootstrap/"), false);
    const executionPolicies = template.findResources("AWS::IAM::Policy", {
      Properties: {
        PolicyName: Match.stringLikeRegexp("^ComputerTaskExecutionRoleDefaultPolicy"),
      },
    });
    assert.equal(Object.keys(executionPolicies).length, 1);
    const executionPolicy = Object.values(executionPolicies)[0] as {
      Properties: {
        PolicyDocument: {
          Statement: Array<{ Action: string | string[]; Resource: string | string[] }>;
        };
      };
    };
    const ecrStatements = executionPolicy.Properties.PolicyDocument.Statement.filter(
      (statement) => {
        const actions = Array.isArray(statement.Action)
          ? statement.Action
          : [statement.Action];
        return actions.includes("ecr:GetAuthorizationToken")
          || actions.includes("ecr:BatchGetImage");
      },
    );
    assert.equal(ecrStatements.length >= 1, true);
    const authStatement = ecrStatements.find((statement) => {
      const actions = Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action];
      return actions.includes("ecr:GetAuthorizationToken");
    });
    assert.ok(authStatement);
    assert.equal(authStatement?.Resource, "*");
    const pullStatement = ecrStatements.find((statement) => {
      const actions = Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action];
      return actions.includes("ecr:BatchGetImage");
    });
    assert.ok(pullStatement);
    const pullResources = Array.isArray(pullStatement?.Resource)
      ? pullStatement?.Resource
      : [pullStatement?.Resource];
    assert.equal(
      pullResources.some(iamResourceTargetsEcrRepository),
      true,
    );
    assert.equal(
      pullResources.some(iamResourceIsWildcard),
      false,
    );
    template.hasOutput("ComputerRepositoryUri", {});
    template.hasOutput("ComputerClusterName", {});
    template.hasOutput("ComputerTaskDefinitionArn", {});
    template.hasOutput("ComputerServiceName", {});
    template.hasOutput("ComputerPublicSubnetIds", {});
    template.hasOutput("ComputerSecurityGroupId", {});
    const taskPolicies = template.findResources("AWS::IAM::Policy", {
      Properties: Match.objectLike({
        PolicyName: Match.stringLikeRegexp("^ComputerTaskRoleDefaultPolicy"),
      }),
    });
    assert.equal(Object.keys(taskPolicies).length, 1);
    const taskPolicy = Object.values(taskPolicies)[0] as {
      Properties: {
        PolicyDocument: {
          Statement: Array<{ Action: string | string[]; Resource: unknown; Sid?: string }>;
        };
      };
    };
    const snapshotStatements = taskPolicy.Properties.PolicyDocument.Statement.filter(
      (statement) => statement.Sid === "SnapshotReadWrite",
    );
    assert.equal(snapshotStatements.length, 1);
    const snapshotStatement = snapshotStatements[0];
    const actions = Array.isArray(snapshotStatement.Action)
      ? snapshotStatement.Action
      : [snapshotStatement.Action];
    assert.deepEqual(actions.sort(), ["s3:GetObject", "s3:PutObject"]);
    assert.equal(actions.includes("s3:ListBucket"), false);
    assert.equal(actions.includes("s3:CreateBucket"), false);
    const resources = Array.isArray(snapshotStatement.Resource)
      ? snapshotStatement.Resource
      : [snapshotStatement.Resource];
    assert.equal(resources.length, 1);
    const resource = resources[0];
    if (typeof resource === "string") {
      assert.match(resource, /\$\{SnapshotBucketName\}|\$\{Bucket\}/);
    } else {
      assert.equal(typeof resource, "object");
      const fnSub = (resource as Record<string, unknown>)["Fn::Sub"];
      assert.ok(fnSub);
    }
  });
});
