#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { ComputerStack } from "../lib/computer-stack";
import { DnsStack } from "../lib/dns-stack";
import {
  CHATTICUS_CLOUD_ENVIRONMENTS,
  MARKETING_STACK_ID,
  THIN_TURN_STACK_IDS,
  WEB_STACK_IDS,
} from "../lib/environments";
import { MarketingWebStack } from "../lib/marketing-stack";
import { SnapshotStack } from "../lib/snapshot-stack";
import { ThinTurnStack } from "../lib/thin-turn-stack";
import { WebStack } from "../lib/web-stack";

const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
};

const snapshots = new SnapshotStack(app, "ChatticusSnapshots", {
  env,
  description: "Canonical S3 store for Chatticus computer snapshots.",
});

new ComputerStack(app, "ChatticusComputers", {
  env,
  description: "ECS cluster, ECR, and Fargate task definition for computer hosts.",
  snapshotBucket: snapshots.bucket,
});

const dns = new DnsStack(app, "ChatticusDns", {
  env,
  description: "Route 53 hosted zone and ACM certificate for chattic.us.",
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
}

new MarketingWebStack(app, MARKETING_STACK_ID, {
  env,
  hostedZone: dns.hostedZone,
  siteCertificate: dns.siteCertificate,
  description: "Public marketing site at chattic.us; www redirects to apex.",
});
