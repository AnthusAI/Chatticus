import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Template } from "aws-cdk-lib/assertions";
import { describe, it } from "node:test";
import { ComputerStack, OWNER_TASK_DEFINITION_FAMILY } from "../lib/computer-stack";
import { ControlPlaneStack } from "../lib/control-plane-stack";
import { ChatticusCloudEnvironment } from "../lib/environments";
import { OWNER_ROLE_POLICY_FILE, SUPERVISOR_ROLE_POLICY_FILE } from "../lib/owner-role-policy";

const ENV = { account: "111111111111", region: "us-east-1" };

const HOST_CONTEXT: Record<string, string> = {
  computerHostStart: "ecs",
  computerEcsCluster: "computers-cluster",
  computerEcsSubnets: "subnet-aaa,subnet-bbb",
  computerEcsSecurityGroups: "sg-111",
  computerEcrRepositoryUri: "111111111111.dkr.ecr.us-east-1.amazonaws.com/computer",
};

const OWNER_CONTEXT: Record<string, string> = {
  ...HOST_CONTEXT,
  computerOwnerTaskDefinition: `arn:aws:ecs:us-east-1:111111111111:task-definition/${OWNER_TASK_DEFINITION_FAMILY}:3`,
  computerOwnerTaskRoleArn: "arn:aws:iam::111111111111:role/owner-task",
  computerOwnerExecutionRoleArn: "arn:aws:iam::111111111111:role/owner-execution",
  computerSnapshotBucketName: "chatticus-snapshots-bucket",
};

function synthComputers(): Template {
  const app = new cdk.App();
  const support = new cdk.Stack(app, "Support", { env: ENV });
  const snapshotBucket = new s3.Bucket(support, "Snapshots");
  return Template.fromStack(new ComputerStack(app, "Computers", { env: ENV, snapshotBucket }));
}

function synthControlPlane(
  environmentName: ChatticusCloudEnvironment,
  context: Record<string, string>,
): Template {
  const app = new cdk.App({ context });
  const support = new cdk.Stack(app, "Support", { env: ENV });
  const messagingTable = new dynamodb.Table(support, "Messaging", {
    partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
  });
  const stack = new ControlPlaneStack(app, "ControlPlane", {
    env: ENV,
    chatticusEnvironment: environmentName,
    messagingTable,
  });
  return Template.fromStack(stack);
}

function resourcesOfType(template: Template, type: string): Record<string, Record<string, any>> {
  return template.findResources(type) as Record<string, Record<string, any>>;
}

function functionVariables(template: Template, fragment: string): Record<string, any> {
  return functionProperties(template, fragment).Environment.Variables;
}

function functionProperties(template: Template, fragment: string): Record<string, any> {
  const matches = Object.values(resourcesOfType(template, "AWS::Lambda::Function")).filter((resource) =>
    String(resource.Properties.Description ?? "").includes(fragment),
  );
  assert.equal(matches.length, 1, `exactly one function described by ${fragment}`);
  return matches[0]!.Properties;
}

function policiesAttachedTo(template: Template, rolePattern: RegExp): Record<string, any>[] {
  return Object.values(resourcesOfType(template, "AWS::IAM::Policy")).filter((policy) =>
    (policy.Properties.Roles ?? []).some((role: any) => rolePattern.test(role.Ref ?? "")),
  );
}

function statementsOf(policies: Record<string, any>[]): Record<string, any>[] {
  return policies.flatMap((policy) => policy.Properties.PolicyDocument.Statement);
}

function roleLogicalId(template: Template, pattern: RegExp): string {
  const matches = Object.keys(resourcesOfType(template, "AWS::IAM::Role")).filter((id) => pattern.test(id));
  assert.equal(matches.length, 1, `exactly one role matching ${pattern}`);
  return matches[0]!;
}

function actionsOf(statement: Record<string, any>): string[] {
  return ([] as string[]).concat(statement.Action);
}

describe("ChatticusComputers owner task definition", () => {
  const computers = synthComputers();
  const ownerRoleId = roleLogicalId(computers, /^ComputerOwnerTaskRole/);
  const definitions = Object.values(resourcesOfType(computers, "AWS::ECS::TaskDefinition"));

  it("gives the owner task role no policies of any kind", () => {
    const role = resourcesOfType(computers, "AWS::IAM::Role")[ownerRoleId]!;
    assert.equal(role.Properties.Policies, undefined);
    assert.equal(role.Properties.ManagedPolicyArns, undefined);
    assert.equal(role.Properties.PermissionsBoundary, undefined);
    for (const type of ["AWS::IAM::Policy", "AWS::IAM::ManagedPolicy"]) {
      for (const resource of Object.values(resourcesOfType(computers, type))) {
        const attached = JSON.stringify(resource.Properties.Roles ?? []);
        assert.ok(!attached.includes(ownerRoleId), `${type} must not attach to the owner task role`);
      }
    }
  });

  it("lets only ECS tasks assume the owner task role", () => {
    const role = resourcesOfType(computers, "AWS::IAM::Role")[ownerRoleId]!;
    assert.deepEqual(role.Properties.AssumeRolePolicyDocument.Statement, [
      { Action: "sts:AssumeRole", Effect: "Allow", Principal: { Service: "ecs-tasks.amazonaws.com" } },
    ]);
  });

  it("defines exactly one task definition, the owner, at 256 CPU and 512 MiB on ARM64 with the owner task role", () => {
    assert.equal(definitions.length, 1);
    const owner = definitions[0]!;
    assert.equal(owner.Properties.Family, OWNER_TASK_DEFINITION_FAMILY);
    assert.deepEqual(owner.Properties.TaskRoleArn, { "Fn::GetAtt": [ownerRoleId, "Arn"] });
    assert.equal(owner.Properties.Cpu, "256");
    assert.equal(owner.Properties.Memory, "512");
    assert.deepEqual(owner.Properties.RuntimePlatform, { CpuArchitecture: "ARM64", OperatingSystemFamily: "LINUX" });
    const container = owner.Properties.ContainerDefinitions[0];
    assert.equal(container.Name, "computer");
    assert.match(JSON.stringify(container.Image), /ComputerImage/);
    assert.match(JSON.stringify(container.Image), /:dev/);
    assert.equal(container.LogConfiguration.Options["awslogs-stream-prefix"], "computer-owner");
  });

  it("runs an init process and gives the supervisor ninety seconds to publish after SIGTERM", () => {
    const container = definitions[0]!.Properties.ContainerDefinitions[0];
    assert.equal(container.LinuxParameters.InitProcessEnabled, true);
    assert.equal(container.StopTimeout, 90);
  });

  it("holds no snapshot grant for any task role and no legacy host service, task definition or role", () => {
    computers.resourceCountIs("AWS::ECS::Service", 0);
    assert.deepEqual(Object.keys(resourcesOfType(computers, "AWS::IAM::Role")).filter((id) => /^ComputerTaskRole/.test(id)), []);
    for (const policy of Object.values(resourcesOfType(computers, "AWS::IAM::Policy"))) {
      assert.ok(!JSON.stringify(policy.Properties.PolicyDocument).includes("s3:"), "no role of the Computers stack reads or writes S3");
    }
    assert.ok(!JSON.stringify(computers.toJSON()).includes("host-worker"));
  });

  it("exports the owner task definition, both owner roles, the snapshot bucket name and the network the starter runs in", () => {
    const outputs = Object.keys((computers.toJSON().Outputs ?? {}) as Record<string, unknown>).sort();
    assert.deepEqual(outputs, [
      "ComputerClusterName",
      "ComputerOwnerExecutionRoleArn",
      "ComputerOwnerTaskDefinitionArn",
      "ComputerOwnerTaskRoleArn",
      "ComputerRepositoryUri",
      "ComputerSecurityGroupId",
      "ComputerSnapshotBucketName",
      "ComputerSubnetIds",
    ]);
  });

  it("creates no IAM users or access keys", () => {
    computers.resourceCountIs("AWS::IAM::User", 0);
    computers.resourceCountIs(["AWS::IAM::Access", "Key"].join(""), 0);
  });
});

describe("ControlPlane model gateway signing key", () => {
  const template = synthControlPlane("development", { computerHostStart: "noop" });
  const secretId = Object.keys(resourcesOfType(template, "AWS::SecretsManager::Secret")).find((id) =>
    id.startsWith("ModelGatewaySigningKey"),
  )!;

  it("generates a long key without punctuation", () => {
    const secret = resourcesOfType(template, "AWS::SecretsManager::Secret")[secretId]!;
    assert.ok(secret.Properties.GenerateSecretString.PasswordLength >= 32);
    assert.equal(secret.Properties.GenerateSecretString.ExcludePunctuation, true);
    assert.equal(secret.DeletionPolicy, "Delete");
  });

  it("is readable by exactly the FrontDoor and the ComputerStarter roles when no owner is wired", () => {
    const readers = readersOf(template, secretId);
    assert.equal(readers.length, 2);
    assert.match(readers[0]!, /^ComputerStarterServiceRole/);
    assert.match(readers[1]!, /^FrontDoorServiceRole/);
  });

  it("is readable by exactly the FrontDoor, the ComputerStarter and the OwnerCredentialBroker roles when the owner is wired", () => {
    const owner = synthControlPlane("development", OWNER_CONTEXT);
    const ownerSecretId = Object.keys(resourcesOfType(owner, "AWS::SecretsManager::Secret")).find((id) =>
      id.startsWith("ModelGatewaySigningKey"),
    )!;
    const readers = readersOf(owner, ownerSecretId);
    assert.equal(readers.length, 3);
    assert.match(readers[0]!, /^ComputerStarterServiceRole/);
    assert.match(readers[1]!, /^FrontDoorServiceRole/);
    assert.match(readers[2]!, /^OwnerCredentialBrokerServiceRole/);
  });

  it("tells exactly the FrontDoor and the ComputerStarter which secret it is", () => {
    for (const fragment of ["TypeScript front door", "ComputerStartJobs consumer"]) {
      assert.deepEqual(functionVariables(template, fragment).CHATTICUS_MODEL_GATEWAY_SIGNING_KEY_SECRET_ARN, {
        Ref: secretId,
      });
    }
    for (const fragment of ["TurnRuns consumer", "TurnProbes consumer"]) {
      assert.equal(functionVariables(template, fragment).CHATTICUS_MODEL_GATEWAY_SIGNING_KEY_SECRET_ARN, undefined);
    }
  });

  it("is not created outside development", () => {
    for (const environmentName of ["staging", "production"] as const) {
      const other = synthControlPlane(environmentName, { computerHostStart: "noop" });
      assert.ok(!JSON.stringify(other.toJSON()).includes("ModelGatewaySigningKey"));
      assert.equal(
        functionVariables(other, "TypeScript front door").CHATTICUS_MODEL_GATEWAY_SIGNING_KEY_SECRET_ARN,
        undefined,
      );
    }
  });
});

function readersOf(template: Template, secretId: string): string[] {
  return Object.values(resourcesOfType(template, "AWS::IAM::Policy"))
    .filter((policy) => JSON.stringify(policy.Properties.PolicyDocument).includes(`"Ref":"${secretId}"`))
    .flatMap((policy) => policy.Properties.Roles.map((role: any) => role.Ref as string))
    .sort();
}

describe("ControlPlane credential broker and owner roles", () => {
  const template = synthControlPlane("development", OWNER_CONTEXT);
  const scopedId = roleLogicalId(template, /^ComputerOwnerScopedRole/);
  const supervisorId = roleLogicalId(template, /^ComputerSupervisorRole/);
  const scopedRole = resourcesOfType(template, "AWS::IAM::Role")[scopedId]!;
  const supervisorRole = resourcesOfType(template, "AWS::IAM::Role")[supervisorId]!;
  const brokerRoleId = roleLogicalId(template, /^OwnerCredentialBrokerServiceRole/);
  const starterRoleId = roleLogicalId(template, /^ComputerStarterServiceRole/);
  const frontDoorRoleId = roleLogicalId(template, /^FrontDoorServiceRole/);
  const brokerFunctionId = Object.keys(resourcesOfType(template, "AWS::Lambda::Function")).find((id) =>
    id.startsWith("OwnerCredentialBroker") && !id.includes("LogRetention"),
  )!;
  const brokerProperties = functionProperties(template, "credential broker");
  const scopedStatements = statementsOf(policiesAttachedTo(template, /^ComputerOwnerScopedRole/));
  const supervisorStatements = statementsOf(policiesAttachedTo(template, /^ComputerSupervisorRole/));
  const brokerStatements = statementsOf(policiesAttachedTo(template, /^OwnerCredentialBrokerServiceRole/));
  const starterStatements = statementsOf(policiesAttachedTo(template, /^ComputerStarterServiceRole/));
  const frontDoorStatements = statementsOf(policiesAttachedTo(template, /^FrontDoorServiceRole/));

  const scopedTrust: Record<string, any>[] = scopedRole.Properties.AssumeRolePolicyDocument.Statement;
  const supervisorTrust: Record<string, any>[] = supervisorRole.Properties.AssumeRolePolicyDocument.Statement;

  function assertTrustsOnlyTheBroker(trust: Record<string, any>[], tagKeys: string[]): void {
    for (const statement of trust) {
      assert.equal(statement.Effect, "Allow");
      assert.deepEqual(statement.Principal, { AWS: { "Fn::GetAtt": [brokerRoleId, "Arn"] } });
    }
    const allActions = trust.flatMap(actionsOf);
    assert.deepEqual([...new Set(allActions)].sort(), ["sts:AssumeRole", "sts:TagSession"]);
    const requiredNull = Object.fromEntries(tagKeys.map((key) => [`aws:RequestTag/${key}`, "false"]));
    for (const action of ["sts:AssumeRole", "sts:TagSession"]) {
      const statement = trust.find((candidate) => actionsOf(candidate).includes(action));
      assert.ok(statement, `a trust statement allows ${action}`);
      assert.deepEqual(statement.Condition.Null, requiredNull);
      assert.deepEqual(statement.Condition["ForAllValues:StringEquals"], { "aws:TagKeys": tagKeys });
    }
  }

  it("runs the broker on Node 22 and ARM64 with 256 MB and a fifteen second timeout, with no function URL", () => {
    assert.equal(brokerProperties.Runtime, "nodejs22.x");
    assert.deepEqual(brokerProperties.Architectures, ["arm64"]);
    assert.equal(brokerProperties.MemorySize, 256);
    assert.equal(brokerProperties.Timeout, 15);
    const urls = Object.values(resourcesOfType(template, "AWS::Lambda::Url")).filter((url) =>
      JSON.stringify(url.Properties.TargetFunctionArn).includes(brokerFunctionId),
    );
    assert.equal(urls.length, 0);
  });

  it("gives the broker the signing key secret and the two role ARNs, and nothing else", () => {
    const names = Object.keys(brokerProperties.Environment.Variables).sort();
    assert.deepEqual(names, [
      "CHATTICUS_MODEL_GATEWAY_SIGNING_KEY_SECRET_ARN",
      "CHATTICUS_OWNER_SCOPED_ROLE_ARN",
      "CHATTICUS_OWNER_SUPERVISOR_ROLE_ARN",
    ]);
    assert.deepEqual(brokerProperties.Environment.Variables.CHATTICUS_OWNER_SCOPED_ROLE_ARN, { "Fn::GetAtt": [scopedId, "Arn"] });
    assert.deepEqual(brokerProperties.Environment.Variables.CHATTICUS_OWNER_SUPERVISOR_ROLE_ARN, { "Fn::GetAtt": [supervisorId, "Arn"] });
  });

  it("lets the broker read one secret and assume the two roles with tags, and touch no store, queue or parameter", () => {
    assert.equal(brokerStatements.length, 2);
    const secret = brokerStatements.find((statement) => actionsOf(statement).includes("secretsmanager:GetSecretValue"))!;
    assert.deepEqual(actionsOf(secret), ["secretsmanager:GetSecretValue"]);
    assert.match(JSON.stringify(secret.Resource), /ModelGatewaySigningKey/);
    const assume = brokerStatements.find((statement) => actionsOf(statement).includes("sts:AssumeRole"))!;
    assert.deepEqual(actionsOf(assume).sort(), ["sts:AssumeRole", "sts:TagSession"]);
    assert.deepEqual(assume.Resource, [{ "Fn::GetAtt": [scopedId, "Arn"] }, { "Fn::GetAtt": [supervisorId, "Arn"] }]);
    assert.equal(assume.Condition, undefined);
    const document = JSON.stringify(brokerStatements);
    for (const forbidden of ["dynamodb:", "s3:", "sqs:", "ssm:", "kms:", "lambda:", "iam:", "ecs:"]) {
      assert.ok(!document.includes(forbidden), `broker must not hold ${forbidden}`);
    }
    const role = resourcesOfType(template, "AWS::IAM::Role")[brokerRoleId]!;
    assert.equal(role.Properties.Policies, undefined);
  });

  it("trusts only the broker role for the per-turn role, for at most one hour, with exactly the five tags", () => {
    assert.equal(scopedRole.Properties.MaxSessionDuration, 3600);
    assertTrustsOnlyTheBroker(scopedTrust, ["tenant", "bot", "channel", "computer", "turn"]);
  });

  it("trusts only the broker role for the supervisor role, for at most one hour, with exactly the two tags", () => {
    assert.equal(supervisorRole.Properties.MaxSessionDuration, 3600);
    assertTrustsOnlyTheBroker(supervisorTrust, ["tenant", "computer"]);
  });

  it("trusts neither the starter nor the Front Door with either role", () => {
    for (const trust of [scopedTrust, supervisorTrust]) {
      const document = JSON.stringify(trust);
      assert.ok(!document.includes(starterRoleId));
      assert.ok(!document.includes(frontDoorRoleId));
    }
  });

  it("carries one static policy of DynamoDB and S3 statements for the per-turn role, written with the session tag variables", () => {
    assert.ok(scopedStatements.length > 0);
    for (const statement of scopedStatements) {
      assert.equal(statement.Effect, "Allow");
      for (const action of actionsOf(statement)) {
        assert.match(String(action), /^(dynamodb|s3):[A-Za-z]+$/, `unexpected action ${action}`);
      }
      for (const resource of ([] as unknown[]).concat(statement.Resource)) {
        assert.notEqual(resource, "*");
        assert.ok(!JSON.stringify(resource).includes('"*"'), "no bare wildcard resource");
      }
    }
    const document = JSON.stringify(scopedStatements);
    for (const variable of ["tenant", "bot", "channel", "computer"]) {
      assert.ok(document.includes("${aws:PrincipalTag/" + variable + "}"), `the policy uses the ${variable} tag`);
    }
    assert.ok(!document.includes("Fn::Sub"), "the policy variables are literal text, not a CloudFormation substitution");
    assert.match(document, /Conversations/);
    assert.match(document, /PiSessions/);
    assert.match(document, /Messaging|ImportValue/);
    assert.match(document, /\/index\/\*/);
    for (const forbidden of ["secretsmanager", "ssm:", "kms:", "sts:", "iam:", "sqs:", "dynamodb:Scan", "dynamodb:BatchWriteItem"]) {
      assert.ok(!document.includes(forbidden), `scoped role must not hold ${forbidden}`);
    }
  });

  it("names no tenant-wide key pattern on the Messaging table and lets the roster be read one item at a time only", () => {
    const keyPatterns = scopedStatements.flatMap((statement) =>
      Object.values(statement.Condition ?? {}).flatMap((condition: any) => condition["dynamodb:LeadingKeys"] ?? []),
    );
    assert.ok(keyPatterns.length > 0);
    for (const pattern of keyPatterns) {
      assert.notEqual(pattern, "${aws:PrincipalTag/tenant}#*");
    }
    const rosterStatements = scopedStatements.filter((statement) =>
      Object.values(statement.Condition ?? {}).some((condition: any) =>
        (condition["dynamodb:LeadingKeys"] ?? []).some((pattern: string) => pattern.endsWith("#roster")),
      ),
    );
    assert.equal(rosterStatements.length, 1);
    assert.deepEqual(actionsOf(rosterStatements[0]!), ["dynamodb:GetItem"]);
  });

  it("deploys exactly the statements of the policy file the scenarios evaluate for the per-turn role", () => {
    const fileStatements = JSON.parse(readFileSync(OWNER_ROLE_POLICY_FILE, "utf8")).statements as Record<string, any>[];
    assert.equal(scopedStatements.length, fileStatements.length);
    for (const fileStatement of fileStatements) {
      const deployed = scopedStatements.find((statement) => statement.Sid === fileStatement.Sid);
      assert.ok(deployed, `${fileStatement.Sid} is deployed`);
      assert.deepEqual(actionsOf(deployed), fileStatement.Action);
      assert.deepEqual(deployed.Condition, fileStatement.Condition);
    }
  });

  it("deploys exactly the one statement of the supervisor policy file, scoped to its snapshot prefix by the two tags", () => {
    const fileStatements = JSON.parse(readFileSync(SUPERVISOR_ROLE_POLICY_FILE, "utf8")).statements as Record<string, any>[];
    assert.equal(supervisorStatements.length, fileStatements.length);
    assert.equal(supervisorStatements.length, 1);
    const [deployed] = supervisorStatements;
    assert.deepEqual(actionsOf(deployed!).sort(), ["s3:AbortMultipartUpload", "s3:GetObject", "s3:PutObject"]);
    assert.equal(deployed!.Condition, undefined);
    assert.ok(
      JSON.stringify(deployed!.Resource).includes(
        ":s3:::chatticus-snapshots-bucket/tenants/${aws:PrincipalTag/tenant}/computers/${aws:PrincipalTag/computer}/*",
      ),
    );
    assert.equal(([] as unknown[]).concat(deployed!.Resource).length, 1);
  });

  it("lets the starter run the owner task and pass only the owner roles, and gives it no right to assume any owner role", () => {
    const run = starterStatements.filter(
      (statement) =>
        actionsOf(statement).includes("ecs:RunTask") &&
        JSON.stringify(statement.Resource).includes(OWNER_TASK_DEFINITION_FAMILY),
    );
    assert.equal(run.length, 1);
    assert.equal(
      run[0]!.Resource,
      `arn:aws:ecs:us-east-1:111111111111:task-definition/${OWNER_TASK_DEFINITION_FAMILY}:*`,
    );
    const pass = starterStatements.filter(
      (statement) =>
        actionsOf(statement).includes("iam:PassRole") &&
        JSON.stringify(statement.Resource).includes("owner-task"),
    );
    assert.equal(pass.length, 1);
    assert.deepEqual(pass[0]!.Resource, [
      "arn:aws:iam::111111111111:role/owner-task",
      "arn:aws:iam::111111111111:role/owner-execution",
    ]);
    const stsStatements = starterStatements.filter((statement) => actionsOf(statement).some((action) => action.startsWith("sts:")));
    assert.equal(stsStatements.length, 1);
    assert.deepEqual(actionsOf(stsStatements[0]!), ["sts:AssumeRole"]);
    assert.equal(stsStatements[0]!.Resource, "arn:aws:iam::*:role/ChatticusOrganizationComputerRole");
    assert.ok(!JSON.stringify(starterStatements).includes("sts:TagSession"));
    assert.ok(!JSON.stringify(starterStatements).includes(scopedId));
    assert.ok(!JSON.stringify(starterStatements).includes(supervisorId));
    assert.ok(!JSON.stringify(starterStatements).includes("lambda:InvokeFunction"));
  });

  it("sets the owner environment on the starter, with the supervisor command and without any role ARN", () => {
    const variables = functionVariables(template, "ComputerStartJobs consumer");
    assert.equal(variables.CHATTICUS_OWNER_TASK_DEFINITION, OWNER_CONTEXT.computerOwnerTaskDefinition);
    assert.equal(variables.CHATTICUS_OWNER_CONTAINER_NAME, "computer");
    assert.equal(variables.CHATTICUS_OWNER_COMMAND, "node /opt/chatticus/host/supervisor.mjs");
    assert.equal(variables.CHATTICUS_OWNER_SCOPED_ROLE_ARN, undefined);
    assert.equal(variables.CHATTICUS_OWNER_SUPERVISOR_ROLE_ARN, undefined);
    assert.equal(variables.CHATTICUS_SNAPSHOT_BUCKET, "chatticus-snapshots-bucket");
    for (const name of [
      "CHATTICUS_MESSAGING_TABLE",
      "CHATTICUS_CONVERSATIONS_TABLE",
      "CHATTICUS_PI_SESSIONS_BUCKET",
      "CHATTICUS_MODEL_GATEWAY_SIGNING_KEY_SECRET_ARN",
    ]) {
      assert.ok(variables[name] !== undefined, `starter sets ${name}`);
    }
    assert.equal(variables.CHATTICUS_HOST_STARTER, "ecs");
    assert.equal(variables.CHATTICUS_ECS_CLUSTER, "computers-cluster");
    assert.equal(variables.CHATTICUS_ECS_TASK_DEFINITION, undefined);
    assert.equal(variables.CHATTICUS_ECS_HOST_COMMAND, undefined);
  });

  it("lets the Front Door and no other role invoke the broker, and names it in the Front Door environment", () => {
    const invokers = Object.values(resourcesOfType(template, "AWS::IAM::Policy"))
      .filter((policy) => JSON.stringify(policy.Properties.PolicyDocument).includes("lambda:InvokeFunction"))
      .filter((policy) => JSON.stringify(policy.Properties.PolicyDocument).includes(brokerFunctionId))
      .flatMap((policy) => policy.Properties.Roles.map((role: any) => String(role.Ref)));
    assert.deepEqual(invokers, [frontDoorRoleId]);
    const invoke = frontDoorStatements.filter((statement) => actionsOf(statement).includes("lambda:InvokeFunction"));
    assert.ok(invoke.some((statement) => JSON.stringify(statement.Resource).includes(brokerFunctionId)));
    assert.deepEqual(
      functionVariables(template, "TypeScript front door").CHATTICUS_OWNER_CREDENTIAL_BROKER_FUNCTION_NAME,
      { Ref: brokerFunctionId },
    );
    const permissions = Object.values(resourcesOfType(template, "AWS::Lambda::Permission")).filter((permission) =>
      JSON.stringify(permission.Properties.FunctionName).includes(brokerFunctionId),
    );
    assert.equal(permissions.length, 0);
    for (const fragment of ["ComputerStartJobs consumer", "TurnRuns consumer", "TurnProbes consumer"]) {
      assert.equal(
        functionVariables(template, fragment).CHATTICUS_OWNER_CREDENTIAL_BROKER_FUNCTION_NAME,
        undefined,
      );
    }
  });

  it("wires nothing for the owner until the Computers stack outputs exist, and never outside development", () => {
    const hostOnly = synthControlPlane("development", HOST_CONTEXT);
    const variables = functionVariables(hostOnly, "ComputerStartJobs consumer");
    assert.equal(variables.CHATTICUS_HOST_STARTER, "ecs");
    assert.equal(variables.CHATTICUS_OWNER_TASK_DEFINITION, undefined);
    const staging = synthControlPlane("staging", OWNER_CONTEXT);
    for (const [label, absent] of [["without the owner outputs", hostOnly], ["outside development", staging]] as const) {
      const logicalIds = [
        ...Object.keys(resourcesOfType(absent, "AWS::IAM::Role")),
        ...Object.keys(resourcesOfType(absent, "AWS::Lambda::Function")),
      ];
      for (const name of ["ComputerOwnerScopedRole", "ComputerSupervisorRole", "OwnerCredentialBroker"]) {
        assert.ok(!logicalIds.some((id) => id.startsWith(name)), `${name} is absent ${label}`);
      }
    }
  });

  it("creates no IAM users or access keys", () => {
    template.resourceCountIs("AWS::IAM::User", 0);
    template.resourceCountIs(["AWS::IAM::Access", "Key"].join(""), 0);
  });
});

describe("ControlPlane FrontDoor snapshot read grant", () => {
  const template = synthControlPlane("development", OWNER_CONTEXT);
  const frontDoorStatements = statementsOf(policiesAttachedTo(template, /^FrontDoorServiceRole/));
  const snapshotStatements = frontDoorStatements.filter((statement) =>
    JSON.stringify(statement.Resource).includes("chatticus-snapshots-bucket"),
  );

  it("reads only objects under tenants/*/computers/*/ and lists only with that prefix", () => {
    assert.equal(snapshotStatements.length, 2);
    const read = snapshotStatements.find((statement) => actionsOf(statement).includes("s3:GetObject"))!;
    assert.deepEqual(actionsOf(read), ["s3:GetObject"]);
    assert.deepEqual(([] as unknown[]).concat(read.Resource), ["arn:aws:s3:::chatticus-snapshots-bucket/tenants/*/computers/*/*"]);
    const list = snapshotStatements.find((statement) => actionsOf(statement).includes("s3:ListBucket"))!;
    assert.deepEqual(actionsOf(list), ["s3:ListBucket"]);
    assert.deepEqual(([] as unknown[]).concat(list.Resource), ["arn:aws:s3:::chatticus-snapshots-bucket"]);
    assert.deepEqual(list.Condition, { StringLike: { "s3:prefix": ["tenants/*/computers/*/"] } });
  });

  it("never lets the FrontDoor write the snapshot bucket", () => {
    for (const statement of snapshotStatements) {
      for (const action of actionsOf(statement)) {
        assert.ok(!/Put|Delete|Abort|Multipart/.test(String(action)), `unexpected action ${action}`);
      }
    }
  });

  it("tells the FrontDoor which bucket to read", () => {
    assert.equal(functionVariables(template, "TypeScript front door").CHATTICUS_SNAPSHOT_BUCKET, "chatticus-snapshots-bucket");
  });

  it("grants the snapshot bucket to no other role than the FrontDoor, the supervisor role and the per-turn owner role", () => {
    const attached = Object.values(resourcesOfType(template, "AWS::IAM::Policy"))
      .filter((policy) => JSON.stringify(policy.Properties.PolicyDocument).includes(":s3:::chatticus-snapshots-bucket"))
      .flatMap((policy) => policy.Properties.Roles.map((role: any) => String(role.Ref)));
    for (const role of attached) {
      assert.match(role, /^(FrontDoorServiceRole|ComputerSupervisorRole|ComputerOwnerScopedRole)/);
    }
    assert.ok(attached.some((role) => /^ComputerSupervisorRole/.test(role)));
  });
});
