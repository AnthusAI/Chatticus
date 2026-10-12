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
import { OWNER_ROLE_POLICY_FILE } from "../lib/owner-role-policy";

const ENV = { account: "111111111111", region: "us-east-1" };

const HOST_CONTEXT: Record<string, string> = {
  computerHostStart: "ecs",
  computerEcsCluster: "computers-cluster",
  computerEcsTaskDefinition: "arn:aws:ecs:us-east-1:111111111111:task-definition/computer:7",
  computerEcsSubnets: "subnet-aaa,subnet-bbb",
  computerEcsSecurityGroups: "sg-111",
  computerEcsExecutionRoleArn: "arn:aws:iam::111111111111:role/computer-execution",
  computerEcsTaskRoleArn: "arn:aws:iam::111111111111:role/computer-task",
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
  const matches = Object.values(resourcesOfType(template, "AWS::Lambda::Function")).filter((resource) =>
    String(resource.Properties.Description ?? "").includes(fragment),
  );
  assert.equal(matches.length, 1);
  return matches[0]!.Properties.Environment.Variables;
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

describe("ChatticusComputers owner task definition", () => {
  const computers = synthComputers();
  const ownerRoleId = roleLogicalId(computers, /^ComputerOwnerTaskRole/);
  const hostRoleId = roleLogicalId(computers, /^ComputerTaskRole/);
  const definitions = Object.values(resourcesOfType(computers, "AWS::ECS::TaskDefinition"));
  const owner = definitions.find((definition) => definition.Properties.Family === OWNER_TASK_DEFINITION_FAMILY)!;
  const host = definitions.find((definition) => definition.Properties.Family !== OWNER_TASK_DEFINITION_FAMILY)!;

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

  it("runs the same size, platform, image and container name as the host task with the owner task role", () => {
    assert.ok(owner, "owner task definition exists");
    assert.deepEqual(owner.Properties.TaskRoleArn, { "Fn::GetAtt": [ownerRoleId, "Arn"] });
    assert.equal(owner.Properties.Cpu, "256");
    assert.equal(owner.Properties.Memory, "512");
    assert.deepEqual(owner.Properties.RuntimePlatform, host.Properties.RuntimePlatform);
    const ownerContainer = owner.Properties.ContainerDefinitions[0];
    const hostContainer = host.Properties.ContainerDefinitions[0];
    assert.equal(ownerContainer.Name, "computer");
    assert.deepEqual(ownerContainer.Image, hostContainer.Image);
    assert.match(JSON.stringify(ownerContainer.Image), /ComputerImage/);
    assert.match(JSON.stringify(ownerContainer.Image), /:dev/);
    assert.equal(
      ownerContainer.LogConfiguration.Options["awslogs-group"].Ref,
      hostContainer.LogConfiguration.Options["awslogs-group"].Ref,
    );
  });

  it("leaves the host-worker task definition and role as they were", () => {
    assert.deepEqual(host.Properties.TaskRoleArn, { "Fn::GetAtt": [hostRoleId, "Arn"] });
    assert.match(host.Properties.Family, /^ComputersComputerTask[0-9A-F]{8}$/);
    const hostPolicies = policiesAttachedTo(computers, /^ComputerTaskRole/);
    assert.equal(hostPolicies.length, 1);
    assert.ok(JSON.stringify(statementsOf(hostPolicies)).includes("s3:GetObject"));
  });

  it("exports the owner task definition, both owner roles and the snapshot bucket name", () => {
    const outputs = Object.keys((computers.toJSON().Outputs ?? {}) as Record<string, unknown>);
    for (const name of [
      "ComputerOwnerTaskDefinitionArn",
      "ComputerOwnerTaskRoleArn",
      "ComputerOwnerExecutionRoleArn",
      "ComputerSnapshotBucketName",
      "ComputerTaskDefinitionArn",
    ]) {
      assert.ok(outputs.includes(name), `output ${name}`);
    }
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

  it("is readable by exactly the FrontDoor and the ComputerStarter roles", () => {
    const readers = Object.values(resourcesOfType(template, "AWS::IAM::Policy"))
      .filter((policy) => JSON.stringify(policy.Properties.PolicyDocument).includes(`"Ref":"${secretId}"`))
      .flatMap((policy) => policy.Properties.Roles.map((role: any) => role.Ref as string))
      .sort();
    assert.equal(readers.length, 2);
    assert.match(readers[0]!, /^ComputerStarterServiceRole/);
    assert.match(readers[1]!, /^FrontDoorServiceRole/);
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

describe("ControlPlane owner scoped role", () => {
  const template = synthControlPlane("development", OWNER_CONTEXT);
  const scopedId = roleLogicalId(template, /^ComputerOwnerScopedRole/);
  const scopedRole = resourcesOfType(template, "AWS::IAM::Role")[scopedId]!;
  const starterRoleId = roleLogicalId(template, /^ComputerStarterServiceRole/);
  const scopedStatements = statementsOf(policiesAttachedTo(template, /^ComputerOwnerScopedRole/));
  const starterStatements = statementsOf(policiesAttachedTo(template, /^ComputerStarterServiceRole/));
  const trustStatements: Record<string, any>[] = scopedRole.Properties.AssumeRolePolicyDocument.Statement;

  it("trusts only the ComputerStarter execution role, for at most one hour", () => {
    assert.equal(scopedRole.Properties.MaxSessionDuration, 3600);
    for (const statement of trustStatements) {
      assert.equal(statement.Effect, "Allow");
      assert.deepEqual(statement.Principal, { AWS: { "Fn::GetAtt": [starterRoleId, "Arn"] } });
    }
  });

  it("lets the starter assume the role and tag the session, and only with all five tags and no other", () => {
    const actions = trustStatements.flatMap((statement) => [].concat(statement.Action));
    assert.deepEqual([...new Set(actions)].sort(), ["sts:AssumeRole", "sts:TagSession"]);
    for (const action of ["sts:AssumeRole", "sts:TagSession"]) {
      const statement = trustStatements.find((candidate) => [].concat(candidate.Action).includes(action));
      assert.ok(statement, `a trust statement allows ${action}`);
      assert.deepEqual(statement.Condition.Null, {
        "aws:RequestTag/tenant": "false",
        "aws:RequestTag/bot": "false",
        "aws:RequestTag/channel": "false",
        "aws:RequestTag/computer": "false",
        "aws:RequestTag/turn": "false",
      });
      assert.deepEqual(statement.Condition["ForAllValues:StringEquals"], {
        "aws:TagKeys": ["tenant", "bot", "channel", "computer", "turn"],
      });
    }
  });

  it("carries one static policy of DynamoDB and S3 statements written with the session tag variables", () => {
    assert.ok(scopedStatements.length > 0);
    for (const statement of scopedStatements) {
      assert.equal(statement.Effect, "Allow");
      for (const action of [].concat(statement.Action)) {
        assert.match(String(action), /^(dynamodb|s3):[A-Za-z]+$/, `unexpected action ${action}`);
      }
      for (const resource of [].concat(statement.Resource)) {
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
    assert.match(document, /chatticus-snapshots-bucket/);
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
    assert.deepEqual([].concat(rosterStatements[0]!.Action), ["dynamodb:GetItem"]);
  });

  it("deploys exactly the statements of the policy file the scenarios evaluate", () => {
    const fileStatements = JSON.parse(readFileSync(OWNER_ROLE_POLICY_FILE, "utf8")).statements as Record<string, any>[];
    assert.equal(scopedStatements.length, fileStatements.length);
    for (const fileStatement of fileStatements) {
      const deployed = scopedStatements.find((statement) => statement.Sid === fileStatement.Sid);
      assert.ok(deployed, `${fileStatement.Sid} is deployed`);
      assert.deepEqual([].concat(deployed.Action), fileStatement.Action);
      assert.deepEqual(deployed.Condition, fileStatement.Condition);
    }
  });

  it("lets the starter assume the scoped role with tags, run the owner task and pass only the owner roles", () => {
    const assume = starterStatements.filter(
      (statement) =>
        [].concat(statement.Action).includes("sts:AssumeRole") &&
        JSON.stringify(statement.Resource).includes(scopedId),
    );
    assert.equal(assume.length, 1);
    assert.deepEqual([...[].concat(assume[0]!.Action)].sort(), ["sts:AssumeRole", "sts:TagSession"]);
    const run = starterStatements.filter(
      (statement) =>
        [].concat(statement.Action).includes("ecs:RunTask") &&
        JSON.stringify(statement.Resource).includes(OWNER_TASK_DEFINITION_FAMILY),
    );
    assert.equal(run.length, 1);
    assert.equal(
      run[0]!.Resource,
      `arn:aws:ecs:us-east-1:111111111111:task-definition/${OWNER_TASK_DEFINITION_FAMILY}:*`,
    );
    const pass = starterStatements.filter(
      (statement) =>
        [].concat(statement.Action).includes("iam:PassRole") &&
        JSON.stringify(statement.Resource).includes("owner-task"),
    );
    assert.equal(pass.length, 1);
    assert.deepEqual(pass[0]!.Resource, [
      "arn:aws:iam::111111111111:role/owner-task",
      "arn:aws:iam::111111111111:role/owner-execution",
    ]);
  });

  it("sets the owner environment on the starter", () => {
    const variables = functionVariables(template, "ComputerStartJobs consumer");
    assert.equal(variables.CHATTICUS_OWNER_TASK_DEFINITION, OWNER_CONTEXT.computerOwnerTaskDefinition);
    assert.equal(variables.CHATTICUS_OWNER_CONTAINER_NAME, "computer");
    assert.equal(variables.CHATTICUS_OWNER_COMMAND, "node /opt/chatticus/host/owner.mjs");
    assert.deepEqual(variables.CHATTICUS_OWNER_SCOPED_ROLE_ARN, { "Fn::GetAtt": [scopedId, "Arn"] });
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
    assert.equal(variables.CHATTICUS_ECS_TASK_DEFINITION, HOST_CONTEXT.computerEcsTaskDefinition);
  });

  it("wires nothing for the owner until the Computers stack outputs exist, and never outside development", () => {
    const hostOnly = synthControlPlane("development", HOST_CONTEXT);
    const variables = functionVariables(hostOnly, "ComputerStartJobs consumer");
    assert.equal(variables.CHATTICUS_HOST_STARTER, "ecs");
    assert.equal(variables.CHATTICUS_OWNER_TASK_DEFINITION, undefined);
    assert.ok(!JSON.stringify(hostOnly.toJSON()).includes("ComputerOwnerScopedRole"));
    const staging = synthControlPlane("staging", OWNER_CONTEXT);
    assert.ok(!JSON.stringify(staging.toJSON()).includes("ComputerOwnerScopedRole"));
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
    const read = snapshotStatements.find((statement) => [].concat(statement.Action).includes("s3:GetObject"))!;
    assert.deepEqual([].concat(read.Action), ["s3:GetObject"]);
    assert.deepEqual([].concat(read.Resource), ["arn:aws:s3:::chatticus-snapshots-bucket/tenants/*/computers/*/*"]);
    const list = snapshotStatements.find((statement) => [].concat(statement.Action).includes("s3:ListBucket"))!;
    assert.deepEqual([].concat(list.Action), ["s3:ListBucket"]);
    assert.deepEqual([].concat(list.Resource), ["arn:aws:s3:::chatticus-snapshots-bucket"]);
    assert.deepEqual(list.Condition, { StringLike: { "s3:prefix": ["tenants/*/computers/*/"] } });
  });

  it("never lets the FrontDoor write the snapshot bucket", () => {
    for (const statement of snapshotStatements) {
      for (const action of [].concat(statement.Action)) {
        assert.ok(!/Put|Delete|Abort|Multipart/.test(String(action)), `unexpected action ${action}`);
      }
    }
  });

  it("tells the FrontDoor which bucket to read", () => {
    assert.equal(functionVariables(template, "TypeScript front door").CHATTICUS_SNAPSHOT_BUCKET, "chatticus-snapshots-bucket");
  });

  it("grants the snapshot bucket to no other role than the FrontDoor and the owner role", () => {
    const attached = Object.values(resourcesOfType(template, "AWS::IAM::Policy"))
      .filter((policy) => JSON.stringify(policy.Properties.PolicyDocument).includes("arn:aws:s3:::chatticus-snapshots-bucket"))
      .flatMap((policy) => policy.Properties.Roles.map((role: any) => String(role.Ref)));
    for (const role of attached) {
      assert.match(role, /^(FrontDoorServiceRole|ComputerOwnerScopedRole)/);
    }
  });
});
