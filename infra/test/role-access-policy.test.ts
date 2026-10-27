import assert from "node:assert/strict";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Template } from "aws-cdk-lib/assertions";
import { describe, it } from "node:test";
import { ownerTaskDefinitionFamily } from "../lib/computer-stack";
import { ControlPlaneStack } from "../lib/control-plane-stack";
import { MAIL_DOMAINS, mailConfigurationSetName } from "../lib/environments";
import { MailIngressStack } from "../lib/mail-ingress-stack";
import { MailStack } from "../lib/mail-stack";
import { policyAllows, type PolicyStatement } from "../../conversation/features-support/iam-policy-evaluator";
import {
  ACCESS_ROLES,
  ACCESS_STORES,
  exampleTagsOf,
  loadRoleAccessDenials,
  loadRoleAccessManifest,
  secretParameterArnsOf,
  type AccessRole,
  type StoreArns,
} from "../../conversation/src/gateway/role-access-manifest";
import { rowsTheRoleCannotServe } from "../../conversation/features-support/role-access-manifest";

const ENV = { account: "111111111111", region: "us-east-1" };
const SNAPSHOT_BUCKET_NAME = "chatticus-snapshots-bucket";

const OWNER_CONTEXT: Record<string, string> = {
  computerHostStart: "ecs",
  computerEcsCluster: "computers-cluster",
  computerEcsSubnets: "subnet-aaa,subnet-bbb",
  computerEcsSecurityGroups: "sg-111",
  computerEcrRepositoryUri: "111111111111.dkr.ecr.us-east-1.amazonaws.com/computer",
  computerOwnerTaskDefinition: `arn:aws:ecs:us-east-1:111111111111:task-definition/${ownerTaskDefinitionFamily("development")}:3`,
  computerOwnerTaskRoleArn: "arn:aws:iam::111111111111:role/owner-task",
  computerOwnerExecutionRoleArn: "arn:aws:iam::111111111111:role/owner-execution",
  computerSnapshotBucketName: SNAPSHOT_BUCKET_NAME,
};

const ROLE_LOGICAL_ID_PATTERNS: Record<AccessRole, RegExp> = {
  frontDoor: /^FrontDoorServiceRole/,
  ownerTurn: /^ComputerOwnerScopedRole/,
  supervisor: /^ComputerSupervisorRole/,
  turnExecutor: /^TurnExecutorServiceRole/,
  mailIngress: /^LambdasMailIngressServiceRole/,
  mailDelivery: /^LambdasMailDeliveryServiceRole/,
  mailStatus: /^LambdasMailStatusServiceRole/,
};

const PSEUDO_PARAMETERS: Record<string, string> = {
  "AWS::Partition": "aws",
  "AWS::Region": ENV.region,
  "AWS::AccountId": ENV.account,
};

type CloudFormationValue = string | number | boolean | null | CloudFormationValue[] | { [key: string]: CloudFormationValue };

/** Turns a CloudFormation value into text, naming each intrinsic by what it points at, so equal references compare equal. */
function textOf(value: CloudFormationValue): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
  const [name, argument] = Object.entries(value)[0] as [string, CloudFormationValue];
  switch (name) {
    case "Fn::Join": {
      const [separator, parts] = argument as [string, CloudFormationValue[]];
      return parts.map(textOf).join(separator);
    }
    case "Fn::GetAtt":
      return `{GetAtt:${(argument as string[]).join(".")}}`;
    case "Fn::ImportValue":
      return `{Import:${textOf(argument)}}`;
    case "Ref":
      return PSEUDO_PARAMETERS[argument as string] ?? `{Ref:${argument as string}}`;
    default:
      return JSON.stringify(value);
  }
}

const listOf = (value: CloudFormationValue | undefined): CloudFormationValue[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

function statementOf(raw: Record<string, CloudFormationValue>): PolicyStatement {
  const condition = raw["Condition"] as Record<string, Record<string, CloudFormationValue>> | undefined;
  return {
    Effect: raw["Effect"] as "Allow" | "Deny",
    Action: listOf(raw["Action"]).map(textOf),
    Resource: listOf(raw["Resource"]).map(textOf),
    ...(condition === undefined
      ? {}
      : {
          Condition: Object.fromEntries(
            Object.entries(condition).map(([operator, keys]) => [
              operator,
              Object.fromEntries(Object.entries(keys).map(([key, values]) => [key, listOf(values).map(textOf)])),
            ]),
          ),
        }),
  };
}

function synthesize(): { statements: Record<AccessRole, PolicyStatement[]>; arns: StoreArns } {
  const app = new cdk.App({ context: OWNER_CONTEXT });
  const support = new cdk.Stack(app, "Support", { env: ENV });
  const messagingTable = new dynamodb.Table(support, "Messaging", {
    partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
  });
  const stack = new ControlPlaneStack(app, "ControlPlane", { env: ENV, chatticusEnvironment: "development", messagingTable });
  const mailIngress = new MailIngressStack(app, "MailIngress", { env: ENV });
  const mail = new MailStack(app, "Mail", {
    env: ENV,
    chatticusEnvironment: "development",
    mailDomain: MAIL_DOMAINS.development,
    receiptRuleSet: mailIngress.ruleSet,
    application: {
      messagingTable,
      conversationsTable: stack.conversationsTable,
      piSessionsBucket: stack.piSessionsBucket,
      turnRunsQueue: stack.turnRunsQueue,
      turnProbesQueue: stack.turnProbesQueue,
      alarmTopic: stack.alarmTopic,
      webAppBaseUrl: "https://develop.chattic.us",
    },
  });
  const policies = [...Object.values(Template.fromStack(stack).findResources("AWS::IAM::Policy")), ...Object.values(Template.fromStack(mail).findResources("AWS::IAM::Policy"))] as Array<{
    Properties: { Roles?: Array<{ Ref?: string }>; PolicyDocument: { Statement: Array<Record<string, CloudFormationValue>> } };
  }>;
  const statements = Object.fromEntries(
    ACCESS_ROLES.map((role) => [
      role,
      policies
        .filter((policy) => (policy.Properties.Roles ?? []).some((attached) => ROLE_LOGICAL_ID_PATTERNS[role].test(attached.Ref ?? "")))
        .flatMap((policy) => policy.Properties.PolicyDocument.Statement.map(statementOf)),
    ]),
  ) as Record<AccessRole, PolicyStatement[]>;
  const messagingImport = statements.frontDoor
    .flatMap((statement) => statement.Resource)
    .find((resource) => /^\{Import:Support:.*Messaging/.test(resource));
  assert.ok(messagingImport, "The FrontDoor policy names the Messaging table by an import from the support stack.");
  const arns: StoreArns = {
    messagingTable: messagingImport,
    conversationsTable: textOf(stack.resolve(stack.conversationsTable.tableArn)),
    piSessionsBucket: textOf(stack.resolve(stack.piSessionsBucket.bucketArn)),
    snapshotBucket: `arn:aws:s3:::${SNAPSHOT_BUCKET_NAME}`,
    channelEventBus: textOf(stack.resolve(stack.formatArn({ service: "events", resource: "event-bus", resourceName: "default" }))),
    rawMailBucket: textOf(mail.resolve(mail.rawMailBucket.bucketArn)),
    mailIdentity: textOf(mail.resolve(mail.formatArn({ service: "ses", resource: "identity", resourceName: MAIL_DOMAINS.development }))),
    mailConfigurationSet: textOf(mail.resolve(mail.formatArn({ service: "ses", resource: "configuration-set", resourceName: mailConfigurationSetName("development") }))),
  };
  return { statements, arns };
}

describe("the role access manifest against the policies the ControlPlane stack synthesizes", () => {
  const { statements, arns } = synthesize();
  const rows = loadRoleAccessManifest();

  for (const role of ACCESS_ROLES) {
    it(`${role}: the synthesized policy holds statements`, () => {
      assert.ok(statements[role].length > 0, `no policy statement was found for ${role}`);
    });

    it(`${role}: the manifest lists the request shapes the role makes, and the synthesized policy serves every one`, () => {
      const roleRows = rows.filter((row) => row.role === role);
      assert.ok(roleRows.length > 0, `the manifest has no row for ${role}`);
      assert.deepEqual(rowsTheRoleCannotServe(roleRows, statements[role], arns), []);
    });
  }

  it("names every store the policies are judged against by a distinct ARN", () => {
    assert.equal(new Set(ACCESS_STORES.map((store) => arns[store])).size, ACCESS_STORES.length);
  });

  it("lists no row for a store the role's policy cannot name", () => {
    for (const row of rows) assert.ok(ACCESS_STORES.includes(row.store), `${row.role} ${row.action} names the unknown store ${row.store}`);
  });
});

describe("the secret parameters against the policies the ControlPlane stack synthesizes", () => {
  const { statements } = synthesize();
  const denials = loadRoleAccessDenials();
  const parameterArns = secretParameterArnsOf(ENV.region, ENV.account, "development");

  it("lists a denial for every action and secret parameter of the owner, supervisor, turn executor and mail roles", () => {
    assert.equal(denials.length, 3 * 3 * 3 + 3 * 3 * 2);
  });

  for (const denial of denials) {
    it(`${denial.role} is denied ${denial.action} on ${denial.parameter}`, () => {
      const allowed = policyAllows(statements[denial.role], exampleTagsOf(denial.role), {
        action: denial.action,
        resourceArn: parameterArns[denial.parameter],
        contextKeys: {},
      });
      assert.equal(allowed, false);
    });
  }

  it("grants ssm:GetParameterHistory on neither secret parameter to any role, because history keeps old versions readable", () => {
    for (const role of ACCESS_ROLES) {
      for (const statement of statements[role]) {
        const actions = JSON.stringify(statement.Action ?? []);
        if (!actions.includes("GetParameterHistory") && !actions.includes("ssm:*")) continue;
        const resources = JSON.stringify(statement.Resource);
        assert.equal(/operator-key|model-gateway\/signing-key|channels\/correlator-secret/.test(resources), false, `${role} may read the history of a secret parameter`);
      }
    }
  });
});
