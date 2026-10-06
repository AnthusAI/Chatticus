import assert from "node:assert/strict";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, it } from "node:test";
import { PI_SESSION_TABLE_KEYS } from "../../conversation/src/storage/table-definition.ts";
import {
  CONVERSATIONS_TABLE_LOCAL_SECONDARY_INDEXES,
  ControlPlaneStack,
} from "../lib/control-plane-stack";
import {
  CHATTICUS_CLOUD_ENVIRONMENTS,
  ChatticusCloudEnvironment,
  THIN_TURN_STACK_IDS,
} from "../lib/environments";
import { ThinTurnStack } from "../lib/thin-turn-stack";

const ECS_CONTEXT: Record<string, string> = {
  computerHostStart: "ecs",
  computerEcsCluster: "computers-cluster",
  computerEcsTaskDefinition: "arn:aws:ecs:us-east-1:111111111111:task-definition/computer:7",
  computerEcsSubnets: "subnet-aaa,subnet-bbb",
  computerEcsSecurityGroups: "sg-111",
  computerEcsExecutionRoleArn: "arn:aws:iam::111111111111:role/computer-execution",
  computerEcsTaskRoleArn: "arn:aws:iam::111111111111:role/computer-task",
  computerEcrRepositoryUri: "111111111111.dkr.ecr.us-east-1.amazonaws.com/computer",
};

function synthControlPlane(
  environmentName: ChatticusCloudEnvironment,
  context: Record<string, string> = { computerHostStart: "noop" },
): Template {
  const app = new cdk.App({ context });
  const support = new cdk.Stack(app, "Support", {
    env: { account: "111111111111", region: "us-east-1" },
  });
  const messagingTable = new dynamodb.Table(support, "Messaging", {
    partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
  });
  const stack = new ControlPlaneStack(app, "ControlPlane", {
    env: { account: "111111111111", region: "us-east-1" },
    chatticusEnvironment: environmentName,
    messagingTable,
  });
  return Template.fromStack(stack);
}

function functionByDescription(template: Template, fragment: string): Record<string, any> {
  const matches = Object.values(template.findResources("AWS::Lambda::Function")).filter(
    (resource) => String(resource.Properties.Description ?? "").includes(fragment),
  );
  assert.equal(matches.length, 1, `exactly one function described by ${fragment}`);
  return matches[0].Properties;
}

describe("ControlPlaneStack", () => {
  const development = synthControlPlane("development");

  it("keeps the local secondary indexes identical to the Pi table definition", () => {
    const expected = PI_SESSION_TABLE_KEYS.localSecondaryIndexes.map((index) => ({
      indexName: index.indexName,
      attributeName: index.attributeName,
    }));
    assert.deepEqual(
      CONVERSATIONS_TABLE_LOCAL_SECONDARY_INDEXES.map((index) => ({ ...index })),
      expected,
    );
  });

  it("creates the Conversations table pay per request with three local secondary indexes", () => {
    development.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      LocalSecondaryIndexes: PI_SESSION_TABLE_KEYS.localSecondaryIndexes.map((index) =>
        Match.objectLike({
          IndexName: index.indexName,
          Projection: { ProjectionType: "ALL" },
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: index.attributeName, KeyType: "RANGE" },
          ],
        }),
      ),
    });
  });

  it("retains data outside development and destroys it in development", () => {
    const tableDeletion = (template: Template): string =>
      Object.values(template.findResources("AWS::DynamoDB::Table"))[0].DeletionPolicy;
    assert.equal(tableDeletion(development), "Delete");
    for (const environmentName of CHATTICUS_CLOUD_ENVIRONMENTS.filter((name) => name !== "development")) {
      const template = synthControlPlane(environmentName);
      assert.equal(tableDeletion(template), "Retain");
      const bucket = Object.values(template.findResources("AWS::S3::Bucket"))[0];
      assert.equal(bucket.DeletionPolicy, "Retain");
    }
  });

  it("blocks public access, enforces SSL and never expires session objects", () => {
    development.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    development.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Deny",
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          }),
        ]),
      },
    });
    const bucket = Object.values(development.findResources("AWS::S3::Bucket"))[0];
    assert.equal(bucket.Properties.LifecycleConfiguration, undefined);
    assert.equal(bucket.Properties.VersioningConfiguration, undefined);
  });

  it("creates three queues, each with a dead-letter queue", () => {
    const queues = Object.values(development.findResources("AWS::SQS::Queue"));
    assert.equal(queues.length, 6);
    const withDeadLetter = queues.filter((queue) => queue.Properties.RedrivePolicy !== undefined);
    assert.equal(withDeadLetter.length, 3);
    const visibilityTimeouts = withDeadLetter
      .map((queue) => queue.Properties.VisibilityTimeout)
      .sort((left, right) => left - right);
    assert.deepEqual(visibilityTimeouts, [360, 360, 1800]);
  });

  it("sizes each Lambda as designed on Node 22 arm64", () => {
    const expected: [string, number, number][] = [
      ["TypeScript front door", 512, 900],
      ["TurnRuns consumer", 1024, 300],
      ["TurnProbes consumer", 256, 60],
      ["ComputerStartJobs consumer", 256, 60],
    ];
    for (const [fragment, memorySize, timeout] of expected) {
      const properties = functionByDescription(development, fragment);
      assert.equal(properties.Runtime, "nodejs22.x");
      assert.deepEqual(properties.Architectures, ["arm64"]);
      assert.equal(properties.MemorySize, memorySize);
      assert.equal(properties.Timeout, timeout);
    }
  });

  it("gives the FrontDoor its own streaming Function URL and routes nothing to CloudFront", () => {
    development.resourceCountIs("AWS::Lambda::Url", 1);
    development.hasResourceProperties("AWS::Lambda::Url", {
      InvokeMode: "RESPONSE_STREAM",
      AuthType: "NONE",
    });
    development.resourceCountIs("AWS::CloudFront::Distribution", 0);
  });

  it("tells the executor, probe and starter where the queues, tables and environment are", () => {
    for (const fragment of ["TurnRuns consumer", "TurnProbes consumer", "ComputerStartJobs consumer"]) {
      const variables = functionByDescription(development, fragment).Environment.Variables;
      for (const name of [
        "CHATTICUS_COMPUTER_STARTS_QUEUE_URL",
        "CHATTICUS_TURN_RUNS_QUEUE_URL",
        "CHATTICUS_TURN_PROBES_QUEUE_URL",
        "CHATTICUS_MESSAGING_TABLE",
        "CHATTICUS_CONVERSATIONS_TABLE",
        "CHATTICUS_PI_SESSIONS_BUCKET",
      ]) {
        assert.ok(variables[name] !== undefined, `${fragment} sets ${name}`);
      }
      assert.equal(variables.CHATTICUS_ENVIRONMENT, "development");
    }
  });

  it("keeps the no-op starter when no ECS configuration is present", () => {
    const variables = functionByDescription(development, "ComputerStartJobs consumer").Environment.Variables;
    assert.equal(variables.CHATTICUS_HOST_STARTER, undefined);
    assert.equal(variables.CHATTICUS_ECS_CLUSTER, undefined);
    const statements = JSON.stringify(development.toJSON().Resources);
    assert.ok(!statements.includes("ecs:RunTask"));
  });

  it("wires the starter to ECS host start with RunTask, PassRole and the ECS environment", () => {
    const ecs = synthControlPlane("development", ECS_CONTEXT);
    const variables = functionByDescription(ecs, "ComputerStartJobs consumer").Environment.Variables;
    assert.equal(variables.CHATTICUS_HOST_STARTER, "ecs");
    assert.equal(variables.CHATTICUS_ECS_CLUSTER, "computers-cluster");
    assert.equal(variables.CHATTICUS_ECS_SUBNETS, "subnet-aaa,subnet-bbb");
    assert.equal(variables.CHATTICUS_ECS_SECURITY_GROUPS, "sg-111");
    assert.equal(variables.CHATTICUS_ECS_CONTAINER_NAME, "computer");
    ecs.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "ecs:RunTask",
            Resource: "arn:aws:ecs:us-east-1:111111111111:task-definition/computer:*",
            Condition: {
              ArnEquals: { "ecs:cluster": "arn:aws:ecs:us-east-1:111111111111:cluster/computers-cluster" },
            },
          }),
          Match.objectLike({
            Action: "iam:PassRole",
            Resource: [
              "arn:aws:iam::111111111111:role/computer-execution",
              "arn:aws:iam::111111111111:role/computer-task",
            ],
          }),
        ]),
      },
    });
    for (const fragment of ["TurnRuns consumer", "TurnProbes consumer"]) {
      const other = functionByDescription(ecs, fragment).Environment.Variables;
      assert.equal(other.CHATTICUS_HOST_STARTER, undefined);
    }
  });

  it("grants the imported host task role no table or queue access", () => {
    const ecs = synthControlPlane("development", ECS_CONTEXT);
    const grantedToHostRole = Object.values(ecs.findResources("AWS::IAM::Policy")).filter(
      (policy) => JSON.stringify(policy.Properties.Roles ?? []).includes("computer-task"),
    );
    assert.equal(grantedToHostRole.length, 0);
  });

  it("never wires ECS host start outside development", () => {
    const staging = synthControlPlane("staging", ECS_CONTEXT);
    const variables = functionByDescription(staging, "ComputerStartJobs consumer").Environment.Variables;
    assert.equal(variables.CHATTICUS_HOST_STARTER, undefined);
  });

  it("lets only the FrontDoor and the executor read the OpenAI key parameter", () => {
    const parameterName = "/chatticus/development/thin-turn/openai-api-key";
    for (const fragment of ["TypeScript front door", "TurnRuns consumer"]) {
      const variables = functionByDescription(development, fragment).Environment.Variables;
      assert.equal(variables.OPENAI_API_KEY_PARAMETER, parameterName);
    }
    for (const fragment of ["TurnProbes consumer", "ComputerStartJobs consumer"]) {
      const variables = functionByDescription(development, fragment).Environment.Variables;
      assert.equal(variables.OPENAI_API_KEY_PARAMETER, undefined);
    }
    const policies = Object.values(development.findResources("AWS::IAM::Policy"));
    const readers = policies.filter((policy) =>
      JSON.stringify(policy.Properties.PolicyDocument).includes(`parameter${parameterName}`),
    );
    assert.equal(readers.length, 2);
  });

  it("consumes each queue with batch size 1 and reports start failures per item", () => {
    const mappings = Object.values(development.findResources("AWS::Lambda::EventSourceMapping"));
    assert.equal(mappings.length, 3);
    for (const mapping of mappings) {
      assert.equal(mapping.Properties.BatchSize, 1);
    }
    assert.equal(
      mappings.filter((mapping) => mapping.Properties.FunctionResponseTypes !== undefined).length,
      1,
    );
  });

  it("tells the FrontDoor the signup mode, the Cognito parameters, the keys and the integration test switch", () => {
    const variables = functionByDescription(development, "TypeScript front door").Environment.Variables;
    for (const name of [
      "CHATTICUS_ENVIRONMENT",
      "CHATTICUS_MESSAGING_TABLE",
      "CHATTICUS_CONVERSATIONS_TABLE",
      "CHATTICUS_PI_SESSIONS_BUCKET",
      "CHATTICUS_TURN_RUNS_QUEUE_URL",
      "CHATTICUS_TURN_PROBES_QUEUE_URL",
      "CHATTICUS_COMPUTER_STARTS_QUEUE_URL",
      "CHATTICUS_SIGNUP_MODE",
      "CHATTICUS_COGNITO_USER_POOL_ID_PARAMETER",
      "CHATTICUS_COGNITO_APP_CLIENT_ID_PARAMETER",
      "CHATTICUS_INVOKE_KEY_SECRET_ARN",
      "CHATTICUS_OPERATOR_KEY_SECRET_ARN",
      "OPENAI_API_KEY_PARAMETER",
    ]) {
      assert.ok(variables[name] !== undefined, `the FrontDoor sets ${name}`);
    }
    assert.equal(variables.CHATTICUS_SIGNUP_MODE, "open");
    assert.equal(variables.CHATTICUS_COGNITO_USER_POOL_ID_PARAMETER, "/chatticus/development/web/cognito-user-pool-id");
    assert.equal(variables.CHATTICUS_COGNITO_APP_CLIENT_ID_PARAMETER, "/chatticus/development/web/cognito-app-client-id");
    assert.equal(variables.CHATTICUS_INTEGRATION_TEST_ENABLED, "true");
    assert.equal(variables.CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID, "111111111111");
    assert.equal(
      functionByDescription(synthControlPlane("production"), "TypeScript front door").Environment.Variables
        .CHATTICUS_INTEGRATION_TEST_ENABLED,
      undefined,
    );
  });

  it("does not hand the invoke or operator key to any other function", () => {
    for (const fragment of ["TurnRuns consumer", "TurnProbes consumer"]) {
      const variables = functionByDescription(development, fragment).Environment.Variables;
      assert.equal(variables.CHATTICUS_INVOKE_KEY_SECRET_ARN, undefined);
      assert.equal(variables.CHATTICUS_OPERATOR_KEY_SECRET_ARN, undefined);
    }
    const starter = functionByDescription(development, "ComputerStartJobs consumer").Environment.Variables;
    assert.equal(starter.CHATTICUS_OPERATOR_KEY_SECRET_ARN, undefined);
    assert.equal(starter.CHATTICUS_INVOKE_KEY, undefined);
  });

  describe("ComputerStarter host credentials", () => {
    const secretGrants = (template: Template) =>
      Object.values(template.findResources("AWS::IAM::Policy")).flatMap((policy) =>
        (policy.Properties.PolicyDocument.Statement as Record<string, any>[])
          .filter((statement) => [].concat(statement.Action).includes("secretsmanager:GetSecretValue"))
          .map((statement) => ({ roles: JSON.stringify(policy.Properties.Roles), resource: statement.Resource })),
      );

    it("gives the starter the FrontDoor Function URL and the invoke key secret ARN, never a key value", () => {
      const starter = functionByDescription(development, "ComputerStartJobs consumer").Environment.Variables;
      const frontDoor = functionByDescription(development, "TypeScript front door").Environment.Variables;
      assert.match(JSON.stringify(starter.CHATTICUS_FRONT_DOOR_URL), /"Fn::GetAtt":\["FrontDoorFunctionUrl[0-9A-F]+","FunctionUrl"\]/);
      assert.deepEqual(starter.CHATTICUS_INVOKE_KEY_SECRET_ARN, frontDoor.CHATTICUS_INVOKE_KEY_SECRET_ARN);
      assert.match(JSON.stringify(starter.CHATTICUS_INVOKE_KEY_SECRET_ARN), /"Ref":"SsmParameterValue/);
      assert.equal(starter.CHATTICUS_INVOKE_KEY, undefined);
    });

    it("lets the starter read exactly the invoke key secret and no other", () => {
      const grants = secretGrants(development).filter((grant) => /ComputerStarterServiceRole/.test(grant.roles));
      assert.equal(grants.length, 1);
      const resources = [].concat(grants[0]!.resource);
      assert.equal(resources.length, 1);
      const invokeArn = functionByDescription(development, "ComputerStartJobs consumer").Environment.Variables
        .CHATTICUS_INVOKE_KEY_SECRET_ARN;
      assert.deepEqual(resources[0], invokeArn);
    });
  });

  describe("shared key secrets", () => {
    const parameterNames = {
      invoke: "/chatticus/development/thin-turn/invoke-key-secret-arn",
      operator: "/chatticus/development/thin-turn/operator-key-secret-arn",
    };

    it("resolves the two secret ARNs from the SSM parameters the thin-turn stack publishes", () => {
      const parameters = Object.values(development.toJSON().Parameters ?? {}) as Record<string, any>[];
      for (const name of Object.values(parameterNames)) {
        assert.ok(
          parameters.some((parameter) => parameter.Default === name && String(parameter.Type).startsWith("AWS::SSM::Parameter::Value")),
          `a deploy-time SSM parameter reads ${name}`,
        );
      }
    });

    it("puts only the secret ARNs, never a secret value, in the FrontDoor environment", () => {
      const variables = functionByDescription(development, "TypeScript front door").Environment.Variables;
      assert.equal(variables.CHATTICUS_INVOKE_KEY, undefined);
      assert.equal(variables.CHATTICUS_OPERATOR_KEY, undefined);
      for (const name of ["CHATTICUS_INVOKE_KEY_SECRET_ARN", "CHATTICUS_OPERATOR_KEY_SECRET_ARN"]) {
        assert.match(JSON.stringify(variables[name]), /"Ref":"SsmParameterValue/);
      }
      assert.doesNotMatch(JSON.stringify(development.toJSON()), /resolve:secretsmanager/);
    });

    it("lets only the FrontDoor read both secrets and the ComputerStarter read the invoke secret alone", () => {
      const grants = Object.values(development.findResources("AWS::IAM::Policy")).flatMap((policy) =>
        (policy.Properties.PolicyDocument.Statement as Record<string, any>[])
          .filter((statement) => [].concat(statement.Action).includes("secretsmanager:GetSecretValue"))
          .map((statement) => ({ roles: JSON.stringify(policy.Properties.Roles), resource: statement.Resource })),
      );
      assert.equal(grants.length, 2);
      const frontDoorGrant = grants.find((grant) => /FrontDoorServiceRole/.test(grant.roles));
      const starterGrant = grants.find((grant) => /ComputerStarterServiceRole/.test(grant.roles));
      assert.equal((frontDoorGrant!.resource as unknown[]).length, 2);
      assert.equal([].concat(starterGrant!.resource).length, 1);
    });

    it("leaves the thin-turn stack with no export that the control plane imports for the secrets", () => {
      const app = new cdk.App({ context: { computerHostStart: "noop" } });
      const env = { account: "111111111111", region: "us-east-1" };
      const thinTurn = new ThinTurnStack(app, THIN_TURN_STACK_IDS.development, {
        env,
        chatticusEnvironment: "development",
      });
      const controlPlane = new ControlPlaneStack(app, "ControlPlane", {
        env,
        chatticusEnvironment: "development",
        messagingTable: thinTurn.messagingTable,
      });
      const exportedNames = Object.values(
        (Template.fromStack(thinTurn).toJSON().Outputs ?? {}) as Record<string, any>,
      )
        .map((output) => output.Export?.Name as string | undefined)
        .filter((name): name is string => name !== undefined);
      const importedNames = [
        ...JSON.stringify(Template.fromStack(controlPlane).toJSON()).matchAll(/"Fn::ImportValue":"([^"]+)"/g),
      ].map((match) => match[1]!);
      const secretExports = exportedNames.filter((name) => /secret-arn|InvokeKey|OperatorKey/i.test(name));
      assert.ok(secretExports.length >= 2, "the thin-turn stack still exports its secret ARNs for the web stack");
      for (const imported of importedNames) {
        assert.ok(!secretExports.includes(imported), `the control plane does not import ${imported}`);
        assert.doesNotMatch(imported, /InvokeKey|OperatorKey|secret/i);
      }
      assert.ok(
        importedNames.every((imported) => exportedNames.includes(imported)),
        "every import resolves to a thin-turn export",
      );
      assert.ok(importedNames.every((imported) => /Messaging/.test(imported)), "only the Messaging table remains imported");
    });
  });

  describe("FrontDoor permissions", () => {
    const frontDoorStatements = (template: Template): Record<string, any>[] =>
      Object.values(template.findResources("AWS::IAM::Policy"))
        .filter((policy) => JSON.stringify(policy.Properties.Roles).includes("FrontDoorServiceRole"))
        .flatMap((policy) => policy.Properties.PolicyDocument.Statement);

    it("sends to all three queues", () => {
      const document = JSON.stringify(
        frontDoorStatements(development).filter((statement) =>
          [].concat(statement.Action).includes("sqs:SendMessage"),
        ),
      );
      for (const queue of ["TurnRuns", "TurnProbes", "ComputerStartJobs"]) {
        assert.match(document, new RegExp(`"${queue}[0-9A-F]{8}","Arn"`), `FrontDoor may send to ${queue}`);
      }
    });

    it("reads and writes the Messaging table and reads the Conversations table", () => {
      const statements = frontDoorStatements(development);
      const writes = statements.filter((statement) => [].concat(statement.Action).includes("dynamodb:PutItem"));
      assert.ok(JSON.stringify(writes).includes("Messaging"), "FrontDoor writes the Messaging table");
      const conversations = statements.filter((statement) => JSON.stringify(statement.Resource).includes("Conversations"));
      assert.ok(conversations.length > 0, "FrontDoor reads the Conversations table");
      assert.ok(
        conversations.every((statement) => ![].concat(statement.Action).includes("dynamodb:PutItem")),
        "FrontDoor does not write the Conversations table",
      );
    });

    it("reads the Cognito parameters and, outside production, the integration test parameters", () => {
      const resources = (template: Template): string =>
        JSON.stringify(
          frontDoorStatements(template).filter((statement) => [].concat(statement.Action).includes("ssm:GetParameter")),
        );
      const developmentResources = resources(development);
      assert.ok(developmentResources.includes("parameter/chatticus/development/web/cognito-user-pool-id"));
      assert.ok(developmentResources.includes("parameter/chatticus/development/web/cognito-app-client-id"));
      assert.ok(developmentResources.includes("parameter/chatticus/development/integration-test/*"));
      const productionResources = resources(synthControlPlane("production"));
      assert.ok(productionResources.includes("parameter/chatticus/production/web/cognito-user-pool-id"));
      assert.ok(!productionResources.includes("integration-test"));
    });

    it("may assume the organization computer role to inspect a customer role and nothing else of the computer", () => {
      const statements = frontDoorStatements(development);
      const assume = statements.filter((statement) => [].concat(statement.Action).includes("sts:AssumeRole"));
      assert.equal(assume.length, 1);
      assert.equal(assume[0].Resource, "arn:aws:iam::*:role/ChatticusOrganizationComputerRole");
      const document = JSON.stringify(statements);
      assert.ok(!document.includes("ecs:RunTask"));
      assert.ok(!document.includes("iam:PassRole"));
    });
  });

  describe("integration test allowed role parameter", () => {
    const roleArn = "arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/us-east-2/AWSReservedSSO_Admin_0123abcd";
    const withRole = { computerHostStart: "noop", integrationTestAllowedRoleArn: roleArn };
    const parameterCount = (template: Template): number =>
      Object.values(template.findResources("AWS::SSM::Parameter")).filter((resource) =>
        String(resource.Properties.Name).endsWith("/integration-test/allowed-role-arn"),
      ).length;

    it("is created in development when the context value is set", () => {
      const template = synthControlPlane("development", withRole);
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/chatticus/development/integration-test/allowed-role-arn",
        Value: roleArn,
      });
      assert.equal(
        Object.values(template.findResources("AWS::SSM::Parameter")).filter((resource) =>
          /integration-test\/(tenant-id|user-id)$/.test(String(resource.Properties.Name)),
        ).length,
        0,
      );
    });

    it("is not created without the context value or with an empty one", () => {
      assert.equal(parameterCount(development), 0);
      assert.equal(parameterCount(synthControlPlane("development", { ...withRole, integrationTestAllowedRoleArn: "" })), 0);
    });

    it("is never created in staging or production", () => {
      for (const environmentName of ["staging", "production"] as const) {
        assert.equal(parameterCount(synthControlPlane(environmentName, withRole)), 0, environmentName);
      }
    });
  });

  it("creates no IAM users or EventBridge schedules", () => {
    development.resourceCountIs("AWS::IAM::User", 0);
    development.resourceCountIs("AWS::Scheduler::Schedule", 0);
    development.resourceCountIs("AWS::Scheduler::ScheduleGroup", 0);
  });
});
