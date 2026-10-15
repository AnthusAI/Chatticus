import { App } from "aws-cdk-lib";
import { PiDurableSpikeStack } from "../lib/stack.ts";

const app = new App();
new PiDurableSpikeStack(app, "ChatticusPiDurableSpike", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-1" },
});
