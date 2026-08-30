#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { ComputerStack } from "../lib/computer-stack";
import { SnapshotStack } from "../lib/snapshot-stack";

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
