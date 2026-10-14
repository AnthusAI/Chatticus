import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Template } from "aws-cdk-lib/assertions";
import { ControlPlaneStack } from "../lib/control-plane-stack";
import { ChatticusCloudEnvironment } from "../lib/environments";

const [environmentArgument, switchArgument] = process.argv.slice(2);
const environmentName = environmentArgument as ChatticusCloudEnvironment;

const context: Record<string, string> = {
  computerHostStart: "ecs",
  computerEcsCluster: "computers-cluster",
  computerEcsSubnets: "subnet-aaa,subnet-bbb",
  computerEcsSecurityGroups: "sg-111",
  computerEcrRepositoryUri: "111111111111.dkr.ecr.us-east-1.amazonaws.com/computer",
  computerOwnerTaskDefinition: "arn:aws:ecs:us-east-1:111111111111:task-definition/ChatticusComputerOwner:3",
  computerOwnerTaskRoleArn: "arn:aws:iam::111111111111:role/owner-task",
  computerOwnerExecutionRoleArn: "arn:aws:iam::111111111111:role/owner-execution",
  computerSnapshotBucketName: "chatticus-snapshots-bucket",
};
if (switchArgument === "with-switch") {
  context.ownerBrokerFault = "deny_supervisor_renewal";
  context.ownerBrokerCredentialSeconds = "900";
}

function asRecords(value: unknown): Record<string, any>[] {
  return Object.values(value as Record<string, Record<string, any>>);
}

try {
  const app = new cdk.App({ context });
  const support = new cdk.Stack(app, "Support", { env: { account: "111111111111", region: "us-east-1" } });
  const messagingTable = new dynamodb.Table(support, "Messaging", {
    partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
  });
  const stack = new ControlPlaneStack(app, "ControlPlane", {
    env: { account: "111111111111", region: "us-east-1" },
    chatticusEnvironment: environmentName,
    messagingTable,
  });
  const template = Template.fromStack(stack).toJSON();
  const resources: Record<string, Record<string, any>> = template.Resources;
  const brokerFunction = asRecords(resources).find(
    (resource) =>
      resource.Type === "AWS::Lambda::Function" && String(resource.Properties?.Description ?? "").includes("credential broker"),
  );
  const brokerRoleLogicalId: string | undefined = brokerFunction?.Properties.Role["Fn::GetAtt"][0];
  const brokerStatements = asRecords(resources)
    .filter(
      (resource) =>
        resource.Type === "AWS::IAM::Policy" && (resource.Properties.Roles ?? []).some((role: any) => role.Ref === brokerRoleLogicalId),
    )
    .flatMap((resource) => resource.Properties.PolicyDocument.Statement);
  const roleNamed = (prefix: string) =>
    Object.entries(resources).find(([logicalId, resource]) => resource.Type === "AWS::IAM::Role" && logicalId.startsWith(prefix));
  const supervisorRole = roleNamed("ComputerSupervisorRole");
  const scopedRole = roleNamed("ComputerOwnerScopedRole");
  process.stdout.write(
    `\nHARNESS_RESULT ${JSON.stringify({
      outcome: "synthesized",
      templateText: JSON.stringify(template),
      brokerExists: brokerFunction !== undefined,
      brokerEnvironment: brokerFunction?.Properties.Environment.Variables ?? null,
      brokerRoleLogicalId: brokerRoleLogicalId ?? null,
      brokerStatements,
      supervisorTrust: supervisorRole?.[1].Properties.AssumeRolePolicyDocument.Statement ?? null,
      supervisorMaxSessionDuration: supervisorRole?.[1].Properties.MaxSessionDuration ?? null,
      scopedTrust: scopedRole?.[1].Properties.AssumeRolePolicyDocument.Statement ?? null,
      scopedMaxSessionDuration: scopedRole?.[1].Properties.MaxSessionDuration ?? null,
      roleLogicalIds: {
        scoped: scopedRole?.[0] ?? null,
        supervisor: supervisorRole?.[0] ?? null,
      },
    })}\n`,
  );
} catch (error) {
  process.stdout.write(`\nHARNESS_RESULT ${JSON.stringify({ outcome: "failed", message: error instanceof Error ? error.message : String(error) })}\n`);
}
