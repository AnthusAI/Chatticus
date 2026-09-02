import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import {
  ChatticusCloudEnvironment,
  THIN_TURN_STACK_IDS,
} from "../lib/environments";
import { ThinTurnStack } from "../lib/thin-turn-stack";

const testEnv = {
  account: "111111111111",
  region: "us-east-1",
};

export function synthThinTurnStack(
  environmentName: ChatticusCloudEnvironment,
): Template {
  const app = new cdk.App();
  const stack = new ThinTurnStack(app, THIN_TURN_STACK_IDS[environmentName], {
    env: testEnv,
    chatticusEnvironment: environmentName,
  });
  return Template.fromStack(stack);
}
