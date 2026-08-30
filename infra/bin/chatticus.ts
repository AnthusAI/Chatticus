#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { ComputerStack } from "../lib/computer-stack";
import {
  CHATTICUS_CLOUD_ENVIRONMENTS,
  THIN_TURN_STACK_IDS,
} from "../lib/environments";
import { SnapshotStack } from "../lib/snapshot-stack";
import { ThinTurnStack } from "../lib/thin-turn-stack";

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

for (const environmentName of CHATTICUS_CLOUD_ENVIRONMENTS) {
  new ThinTurnStack(app, THIN_TURN_STACK_IDS[environmentName], {
    env,
    chatticusEnvironment: environmentName,
    description:
      `Zero-idle computerless turn (${environmentName}): DynamoDB, SQS, ` +
      "Lambda SSE front door, CloudFront.",
  });
}
