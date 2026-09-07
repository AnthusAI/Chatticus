import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { CustomerComputersStack } from "../lib/customer-computers-stack";

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
              Name: "CHATTICUS_TENANT_ID",
              Value: { Ref: "TenantId" },
            },
          ]),
        }),
      ]),
    });
    template.hasParameter("TenantId", { Type: "String" });
    const parameters = template.toJSON().Parameters ?? {};
    assert.equal(Object.keys(parameters).length, 1);
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
      pullResources.some((resource) => String(resource).includes(":repository/")),
      true,
    );
    assert.equal(
      pullResources.some((resource) => String(resource) === "*"),
      false,
    );
    template.hasOutput("ComputerRepositoryUri", {});
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
  });
});
