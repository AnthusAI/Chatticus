import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { CustomerComputersStack } from "../lib/customer-computers-stack";

describe("CustomerComputersStack", () => {
  it("creates Fargate wiring without S3 or customer ECR", () => {
    const app = new cdk.App();
    const stack = new CustomerComputersStack(app, "TestCustomerComputers");
    const template = Template.fromStack(stack);

    template.resourceCountIs("AWS::S3::Bucket", 0);
    template.resourceCountIs("AWS::ECR::Repository", 0);
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Image: { Ref: "AnthusComputerImageUri" },
          Environment: Match.arrayWith([
            { Name: "CHATTICUS_LIVE_ROOT", Value: "/var/lib/chatticus/computer" },
            {
              Name: "CHATTICUS_TENANT_ID",
              Value: { Ref: "TenantId" },
            },
          ]),
        }),
      ]),
    });
    template.hasParameter("TenantId", { Type: "String" });
    template.hasParameter("AnthusComputerImageUri", { Type: "String" });
    const parameters = template.toJSON().Parameters ?? {};
    assert.equal(Object.keys(parameters).length, 2);
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
          Statement: Array<{ Action: string | string[]; Resource: string }>;
        };
      };
    };
    const ecrStatement = executionPolicy.Properties.PolicyDocument.Statement.find(
      (statement) => {
        const actions = Array.isArray(statement.Action)
          ? statement.Action
          : [statement.Action];
        return actions.includes("ecr:GetAuthorizationToken");
      },
    );
    assert.ok(ecrStatement);
    const ecrActions = Array.isArray(ecrStatement.Action)
      ? ecrStatement.Action
      : [ecrStatement.Action];
    assert.deepEqual(ecrActions.sort(), [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetAuthorizationToken",
      "ecr:GetDownloadUrlForLayer",
    ]);
    assert.equal(ecrStatement.Resource, "*");
    template.hasOutput("ComputerClusterName", {});
    template.hasOutput("ComputerTaskDefinitionArn", {});
    template.hasOutput("ComputerServiceName", {});
    template.hasOutput("ComputerPublicSubnetIds", {});
    template.hasOutput("ComputerSecurityGroupId", {});
    const outputs = template.findOutputs("*");
    assert.equal(
      Object.keys(outputs).some((key) => key.includes("SnapshotBucketName")),
      false,
    );
    assert.equal(
      Object.keys(outputs).some((key) => key.includes("ComputerRepositoryUri")),
      false,
    );
  });
});
