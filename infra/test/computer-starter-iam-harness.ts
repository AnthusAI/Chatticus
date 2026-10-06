import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Template } from "aws-cdk-lib/assertions";
import { ControlPlaneStack } from "../lib/control-plane-stack";

const ecsContext: Record<string, string> = {
  computerHostStart: "ecs",
  computerEcsCluster: "computers-cluster",
  computerEcsTaskDefinition: "arn:aws:ecs:us-east-1:111111111111:task-definition/computer:7",
  computerEcsSubnets: "subnet-aaa,subnet-bbb",
  computerEcsSecurityGroups: "sg-111",
  computerEcsExecutionRoleArn: "arn:aws:iam::111111111111:role/computer-execution",
  computerEcsTaskRoleArn: "arn:aws:iam::111111111111:role/computer-task",
  computerEcrRepositoryUri: "111111111111.dkr.ecr.us-east-1.amazonaws.com/computer",
};

const app = new cdk.App({ context: ecsContext });
const support = new cdk.Stack(app, "Support", { env: { account: "111111111111", region: "us-east-1" } });
const messagingTable = new dynamodb.Table(support, "Messaging", {
  partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
  sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
});
const stack = new ControlPlaneStack(app, "ControlPlane", {
  env: { account: "111111111111", region: "us-east-1" },
  chatticusEnvironment: "development",
  messagingTable,
});
const template = Template.fromStack(stack).toJSON();

const starterFunction = Object.values<any>(template.Resources).find(
  (resource) =>
    resource.Type === "AWS::Lambda::Function" &&
    String(resource.Properties?.Description ?? "").includes("ComputerStartJobs consumer"),
);
const roleLogicalId: string = starterFunction.Properties.Role["Fn::GetAtt"][0];
const statements = Object.values<any>(template.Resources)
  .filter(
    (resource) =>
      resource.Type === "AWS::IAM::Policy" &&
      (resource.Properties.Roles ?? []).some((role: any) => role.Ref === roleLogicalId),
  )
  .flatMap((resource) => resource.Properties.PolicyDocument.Statement);

process.stdout.write(JSON.stringify({ statements, environment: starterFunction.Properties.Environment.Variables }));
