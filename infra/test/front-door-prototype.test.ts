import assert from "node:assert/strict";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, it } from "node:test";
import { FrontDoorPrototype } from "../lib/front-door-prototype";

describe("FrontDoorPrototype", () => {
  it("is an arm64 Node 22 function behind a RESPONSE_STREAM Function URL", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "PrototypeStack", {
      env: { account: "111111111111", region: "us-east-1" },
    });
    new FrontDoorPrototype(stack, "FrontDoorPrototype");
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      Timeout: 900,
      MemorySize: 512,
    });
    template.hasResourceProperties("AWS::Lambda::Url", {
      InvokeMode: "RESPONSE_STREAM",
      AuthType: "NONE",
    });
    assert.deepEqual(Object.keys(template.findResources("AWS::CloudFront::Distribution")), []);
  });
});
