import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { GeneratedSecureString } from "../lib/generated-secure-string";

function synthesize(): { template: Template; construct: GeneratedSecureString } {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "Test", { env: { account: "111111111111", region: "us-east-1" } });
  const construct = new GeneratedSecureString(stack, "Key", {
    parameterName: "/chatticus/development/thin-turn/operator-key",
    valueLength: 32,
    description: "A generated key.",
  });
  return { template: Template.fromStack(stack), construct };
}

type Statement = { Action: string | string[]; Effect: string; Resource: unknown };

function writerStatements(template: Template): Statement[] {
  return Object.values(template.findResources("AWS::IAM::Policy"))
    .filter((policy) => JSON.stringify(policy.Properties.Roles).includes("KeyWriterServiceRole"))
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement as Statement[]);
}

describe("GeneratedSecureString", () => {
  const { template, construct } = synthesize();
  const serialized = JSON.stringify(template.toJSON());

  it("is a Provider-framework custom resource that is retained and names the parameter and its length only", () => {
    const [resource] = Object.values(template.findResources("Custom::GeneratedSecureString"));
    assert.deepEqual(resource.Properties, {
      ServiceToken: resource.Properties.ServiceToken,
      ParameterName: "/chatticus/development/thin-turn/operator-key",
      ValueLength: 32,
      Description: "A generated key.",
    });
    assert.equal(resource.DeletionPolicy, "Retain");
    assert.equal(resource.UpdateReplacePolicy, "Retain");
    assert.match(JSON.stringify(resource.Properties.ServiceToken), /ProviderframeworkonEvent/);
  });

  it("is not an AwsCustomResource and holds no generated value, no SecureString parameter and no dynamic reference", () => {
    assert.equal(serialized.includes("Custom::AWS"), false);
    assert.equal(serialized.includes("ssm-secure"), false);
    assert.equal(template.findResources("AWS::SSM::Parameter") && Object.keys(template.findResources("AWS::SSM::Parameter")).length, 0);
  });

  it("lets the writer put only the one parameter and needs no KMS grant with the default aws/ssm key", () => {
    const statements = writerStatements(template);
    assert.equal(statements.length, 1);
    assert.deepEqual(statements[0].Action, "ssm:PutParameter");
    assert.equal(statements[0].Effect, "Allow");
    assert.match(JSON.stringify(statements[0].Resource), /parameter\/chatticus\/development\/thin-turn\/operator-key/);
    assert.equal(serialized.includes("kms:"), false);
    assert.equal(serialized.includes("secretsmanager:"), false);
  });

  it("exposes the parameter name and an ARN that names the parameter exactly", () => {
    assert.equal(construct.parameterName, "/chatticus/development/thin-turn/operator-key");
    assert.match(JSON.stringify(cdk.Stack.of(construct).resolve(construct.parameterArn)), /parameter\/chatticus\/development\/thin-turn\/operator-key/);
  });
});
