import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Template } from "aws-cdk-lib/assertions";
import {
  ChatticusCloudEnvironment,
  WEB_STACK_IDS,
} from "../lib/environments";
import { WebStack } from "../lib/web-stack";

const testEnv = {
  account: "111111111111",
  region: "us-east-1",
};

/** Inline deploy source: no npm ci, no docker, no shared web/node_modules mount. */
export const testWebsiteDeploySource = s3deploy.Source.data(
  "index.html",
  "<!DOCTYPE html><html></html>",
);

export function synthWebStack(
  environmentName: ChatticusCloudEnvironment,
): Template {
  const app = new cdk.App();
  const deps = new cdk.Stack(app, "Deps", { env: testEnv });
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
    env: testEnv,
    chatticusEnvironment: environmentName,
    hostedZone,
    siteCertificate,
    frontDoorFunctionUrl,
    invokeSecret,
    websiteDeploySource: testWebsiteDeploySource,
  });

  return Template.fromStack(stack);
}
