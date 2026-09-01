import assert from "node:assert/strict";
import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Template } from "aws-cdk-lib/assertions";
import { describe, it } from "node:test";
import {
  CHATTICUS_CLOUD_ENVIRONMENTS,
  ChatticusCloudEnvironment,
  WEB_CLOUDFRONT_ENABLED,
  WEB_STACK_IDS,
} from "../lib/environments";
import { WebStack } from "../lib/web-stack";

function synthWebStack(environmentName: ChatticusCloudEnvironment): Template {
  const app = new cdk.App();
  const deps = new cdk.Stack(app, "Deps");
  const hostedZone = route53.HostedZone.fromHostedZoneAttributes(deps, "Zone", {
    hostedZoneId: "Z1234567890ABC",
    zoneName: "chattic.us",
  });
  const siteCertificate = acm.Certificate.fromCertificateArn(
    deps,
    "Cert",
    "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000",
  );
  const frontDoor = new lambda.Function(deps, "FrontDoor", {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200 });"),
  });
  const frontDoorFunctionUrl = frontDoor.addFunctionUrl({
    authType: lambda.FunctionUrlAuthType.NONE,
  });
  const invokeSecret = new secretsmanager.Secret(deps, "InvokeSecret");

  const stack = new WebStack(app, WEB_STACK_IDS[environmentName], {
    chatticusEnvironment: environmentName,
    hostedZone,
    siteCertificate,
    frontDoorFunctionUrl,
    invokeSecret,
  });

  return Template.fromStack(stack);
}

describe("WebStack CloudFront enabled flag", () => {
  for (const environmentName of CHATTICUS_CLOUD_ENVIRONMENTS) {
    it(`sets Enabled=${WEB_CLOUDFRONT_ENABLED[environmentName]} for ${environmentName}`, () => {
      const template = synthWebStack(environmentName);
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: {
          Enabled: WEB_CLOUDFRONT_ENABLED[environmentName],
        },
      });
    });
  }
});
