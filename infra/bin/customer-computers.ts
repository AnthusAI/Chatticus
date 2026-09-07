#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { CustomerComputersStack } from "../lib/customer-computers-stack";

const app = new cdk.App();

new CustomerComputersStack(app, "ChatticusComputers", {
  description:
    "Customer-account ECS cluster and Fargate task definition for computer hosts.",
});
