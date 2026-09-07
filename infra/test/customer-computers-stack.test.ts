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
    template.hasOutput("ComputerClusterName", {});
    template.hasOutput("ComputerTaskDefinitionArn", {});
    template.hasOutput("ComputerServiceName", {});
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
