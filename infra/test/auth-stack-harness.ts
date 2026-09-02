import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cdk from "aws-cdk-lib";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Template } from "aws-cdk-lib/assertions";
import {
  AUTH_STACK_IDS,
  AUTH_DOMAIN_NAMES,
  ChatticusCloudEnvironment,
  WEB_SITE_DOMAINS,
  webParameterPrefix,
} from "../lib/environments";
import { AuthStack } from "../lib/auth-stack";

const testEnv = {
  account: "111111111111",
  region: "us-east-1",
};

export function synthAuthStack(
  environmentName: ChatticusCloudEnvironment,
  budgetsAlertsTopicArn?: string,
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

  const stack = new AuthStack(app, AUTH_STACK_IDS[environmentName], {
    env: testEnv,
    chatticusEnvironment: environmentName,
    hostedZone,
    siteCertificate,
    budgetsAlertsTopicArn,
  });

  return Template.fromStack(stack);
}

export function authStackExpectations(
  environmentName: ChatticusCloudEnvironment,
): {
  authDomainName: string;
  callbackUrl: string;
  webPrefix: string;
} {
  return {
    authDomainName: AUTH_DOMAIN_NAMES[environmentName],
    callbackUrl: `https://${WEB_SITE_DOMAINS[environmentName]}/auth/callback`,
    webPrefix: webParameterPrefix(environmentName),
  };
}
