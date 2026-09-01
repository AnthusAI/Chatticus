#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { ComputerStack } from "../lib/computer-stack";
import { DnsStack } from "../lib/dns-stack";
import { AuthStack } from "../lib/auth-stack";
import {
  AUTH_STACK_IDS,
  CHATTICUS_CLOUD_ENVIRONMENTS,
  THIN_TURN_STACK_IDS,
  WEB_STACK_IDS,
} from "../lib/environments";
import { readBudgetsConfig } from "../lib/budgets-config";
import { BudgetsStack } from "../lib/budgets-stack";
import { GitHubDeployStack } from "../lib/github-deploy-stack";
import { SnapshotStack } from "../lib/snapshot-stack";
import { ThinTurnStack } from "../lib/thin-turn-stack";
import { WebStack } from "../lib/web-stack";

const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
};

const budgetsConfig = readBudgetsConfig(app);

const snapshots = new SnapshotStack(app, "ChatticusSnapshots", {
  env,
  description: "Canonical S3 store for Chatticus computer snapshots.",
});

if (budgetsConfig) {
  new BudgetsStack(app, "ChatticusBudgets", {
    env,
    monthlyLimitUsd: budgetsConfig.monthlyLimitUsd,
    notificationEmails: budgetsConfig.notificationEmails,
    description: "Account-level AWS spend budget and alerts.",
  });
}

new ComputerStack(app, "ChatticusComputers", {
  env,
  description: "ECS cluster, ECR, and Fargate task definition for computer hosts.",
  snapshotBucket: snapshots.bucket,
});

const dns = new DnsStack(app, "ChatticusDns", {
  env,
  description: "Route 53 hosted zone and ACM certificate for chattic.us.",
});

new GitHubDeployStack(app, "ChatticusGitHubDeploy", {
  env,
  description:
    "GitHub Actions OIDC IAM role for CDK deploy workflows (phase-1 ThinTurn development).",
});

for (const environmentName of CHATTICUS_CLOUD_ENVIRONMENTS) {
  const thinTurn = new ThinTurnStack(app, THIN_TURN_STACK_IDS[environmentName], {
    env,
    chatticusEnvironment: environmentName,
    description:
      `Zero-idle computerless turn (${environmentName}): DynamoDB, SQS, ` +
      "Lambda SSE front door.",
  });

  const web = new WebStack(app, WEB_STACK_IDS[environmentName], {
    env,
    chatticusEnvironment: environmentName,
    hostedZone: dns.hostedZone,
    siteCertificate: dns.siteCertificate,
    frontDoorFunctionUrl: thinTurn.frontDoorFunctionUrl,
    invokeSecret: thinTurn.invokeSecret,
    description:
      `Next.js UI (${environmentName}) on CloudFront with same-origin /api/* ` +
      "proxy to the thin-turn function URL.",
  });
  web.addDependency(thinTurn);

  new AuthStack(app, AUTH_STACK_IDS[environmentName], {
    env,
    chatticusEnvironment: environmentName,
    hostedZone: dns.hostedZone,
    siteCertificate: dns.siteCertificate,
    description:
      `Cognito user pool (${environmentName}) with Google federation and ` +
      "custom auth domain for SPA authorization code + PKCE.",
  });
}
