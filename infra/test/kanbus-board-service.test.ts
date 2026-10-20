import assert from "node:assert/strict";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Template } from "aws-cdk-lib/assertions";
import { describe, it } from "node:test";
import { ControlPlaneStack } from "../lib/control-plane-stack";
import {
  CHATTICUS_CLOUD_ENVIRONMENTS,
  KANBUS_BOARD_ENVIRONMENTS,
  type ChatticusCloudEnvironment,
} from "../lib/environments";

const ENV = { account: "111111111111", region: "us-east-1" };

function synthControlPlane(environmentName: ChatticusCloudEnvironment): Template {
  const app = new cdk.App({ context: { computerHostStart: "noop" } });
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

const templates: Record<ChatticusCloudEnvironment, Template> = {
  development: synthControlPlane("development"),
  staging: synthControlPlane("staging"),
  production: synthControlPlane("production"),
};

function functionsWithEnvironmentVariable(template: Template, variable: string): Array<{ logicalId: string; properties: any }> {
  return Object.entries(template.findResources("AWS::Lambda::Function"))
    .filter(([, resource]) => (resource.Properties.Environment?.Variables ?? {})[variable] !== undefined)
    .map(([logicalId, resource]) => ({ logicalId, properties: resource.Properties }));
}

function kanbusFunction(template: Template, variable: string): Record<string, any> {
  const matches = functionsWithEnvironmentVariable(template, variable).filter(({ properties }) => properties.Runtime === "provided.al2023");
  assert.equal(matches.length, 1, `exactly one provided.al2023 function carries ${variable}`);
  return matches[0].properties;
}

describe("the Kanbus board service in the control plane stack", () => {
  it("lists development as the only environment that gets the service", () => {
    assert.deepEqual([...KANBUS_BOARD_ENVIRONMENTS], ["development"]);
  });

  it("creates the service API, its two functions, the bucket, the table and the hourly sweep rule in development only", () => {
    for (const environment of CHATTICUS_CLOUD_ENVIRONMENTS) {
      const template = templates[environment];
      const expected = KANBUS_BOARD_ENVIRONMENTS.includes(environment);
      const apis = Object.keys(template.findResources("AWS::ApiGatewayV2::Api"));
      const providedFunctions = Object.values(template.findResources("AWS::Lambda::Function")).filter(
        (resource) => resource.Properties.Runtime === "provided.al2023",
      );
      assert.equal(apis.length, expected ? 1 : 0, `${environment} API count`);
      assert.equal(providedFunctions.length, expected ? 2 : 0, `${environment} Kanbus function count`);
      assert.equal(
        Object.keys(template.findResources("AWS::Events::Rule")).filter((id) => id.includes("SweepScheduleRule")).length,
        expected ? 1 : 0,
        `${environment} sweep rule count`,
      );
    }
  });

  it("names the service API for its environment and runs the sweep every hour", () => {
    templates.development.hasResourceProperties("AWS::ApiGatewayV2::Api", { Name: "kanbus-development-service" });
    templates.development.hasResourceProperties("AWS::Events::Rule", { ScheduleExpression: "rate(1 hour)" });
  });

  it("gives the API function and the sweeper an archive retention of 30 days", () => {
    const retentionHolders = functionsWithEnvironmentVariable(templates.development, "KANBUS_ARCHIVE_RETENTION_DAYS");
    assert.equal(retentionHolders.length, 2);
    for (const { properties } of retentionHolders) {
      assert.equal(properties.Environment.Variables.KANBUS_ARCHIVE_RETENTION_DAYS, "30");
    }
  });

  it("names exactly the Front Door and the turn executor as service principals, with the stated capabilities", () => {
    const principalsText = JSON.stringify(
      kanbusFunction(templates.development, "KANBUS_SERVICE_PRINCIPALS").Environment.Variables.KANBUS_SERVICE_PRINCIPALS,
    );
    const entries = principalsText.split("role_arn").slice(1);
    assert.equal(entries.length, 2, "exactly two service principals");
    const frontDoor = entries.find((entry) => entry.includes("FrontDoorServiceRole"));
    const turnExecutor = entries.find((entry) => entry.includes("TurnExecutorServiceRole"));
    assert.ok(frontDoor !== undefined && turnExecutor !== undefined, "one entry per role");
    for (const entry of [frontDoor, turnExecutor]) {
      assert.match(entry, /tenants[^a-z]+\*/);
      assert.match(entry, /delegate_actor[^a-z]+true/);
    }
    assert.match(frontDoor, /provision[^a-z]+true/);
    assert.match(turnExecutor, /provision[^a-z]+false/);
  });

  it("grants execute-api:Invoke on the service API to exactly the Front Door and turn executor roles and to no other role", () => {
    const template = templates.development;
    const invokePolicies = Object.values(template.findResources("AWS::IAM::Policy")).filter((resource) =>
      resource.Properties.PolicyDocument.Statement.some((statement: any) =>
        [statement.Action].flat().includes("execute-api:Invoke"),
      ),
    );
    const grantedRoles = invokePolicies.flatMap((policy) => policy.Properties.Roles.map((role: any) => role.Ref as string)).sort();
    assert.equal(grantedRoles.length, 2);
    assert.match(grantedRoles[0], /^FrontDoorServiceRole/);
    assert.match(grantedRoles[1], /^TurnExecutorServiceRole/);
    for (const policy of invokePolicies) {
      assert.equal(policy.Properties.PolicyDocument.Statement.length, 1);
      assert.deepEqual([policy.Properties.PolicyDocument.Statement[0].Action].flat(), ["execute-api:Invoke"]);
    }
  });

  it("creates the roles without an IAM path", () => {
    for (const environment of CHATTICUS_CLOUD_ENVIRONMENTS) {
      for (const [, role] of Object.entries(templates[environment].findResources("AWS::IAM::Role"))) {
        const path = (role as any).Properties.Path;
        assert.ok(path === undefined || path === "/", `${environment} role path ${path}`);
      }
    }
  });

  it("scopes each environment's API invoke grant to its own API, so no role can invoke another environment's API", () => {
    const apiReferences = (template: Template): string[] =>
      Object.values(template.findResources("AWS::IAM::Policy"))
        .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement)
        .filter((statement: any) => [statement.Action].flat().includes("execute-api:Invoke"))
        .map((statement: any) => JSON.stringify(statement.Resource));
    for (const reference of apiReferences(templates.development)) {
      assert.match(reference, /Ref/);
      assert.doesNotMatch(reference, /\*:\*|arn:aws:execute-api:\*/);
    }
    assert.deepEqual(apiReferences(templates.staging), []);
    assert.deepEqual(apiReferences(templates.production), []);
  });

  it("hands the service URL to the Front Door and the turn executor in development, and to nothing elsewhere", () => {
    const holders = functionsWithEnvironmentVariable(templates.development, "CHATTICUS_KANBUS_API_URL");
    assert.equal(holders.length, 2);
    const handlerNames = holders.map(({ properties }) => String(properties.Description)).sort();
    assert.ok(handlerNames.some((description) => description.includes("Front Door") || description.toLowerCase().includes("front")));
    assert.ok(handlerNames.some((description) => description.includes("TurnRuns consumer")));
    for (const { properties } of holders) {
      assert.match(JSON.stringify(properties.Environment.Variables.CHATTICUS_KANBUS_API_URL), /"Fn::GetAtt":\["Kanbus[A-Za-z0-9]*ServiceApi[A-Za-z0-9]*","ApiEndpoint"\]/);
    }
    assert.equal(functionsWithEnvironmentVariable(templates.staging, "CHATTICUS_KANBUS_API_URL").length, 0);
    assert.equal(functionsWithEnvironmentVariable(templates.production, "CHATTICUS_KANBUS_API_URL").length, 0);
  });

  it("adds no cross-stack export or import", () => {
    for (const environment of CHATTICUS_CLOUD_ENVIRONMENTS) {
      const template = templates[environment].toJSON();
      const importedNames = JSON.stringify(template).match(/"Fn::ImportValue":[^}]*/g) ?? [];
      assert.deepEqual(importedNames.filter((name) => /kanbus/i.test(name)), [], `${environment} imports`);
      for (const [logicalId, output] of Object.entries(template.Outputs ?? {})) {
        if (/kanbus/i.test(logicalId)) assert.equal((output as any).Export, undefined, `${environment} export of ${logicalId}`);
      }
    }
  });

  it("leaves the staging and production templates free of every Kanbus resource", () => {
    for (const environment of ["staging", "production"] as const) {
      const text = JSON.stringify(templates[environment].toJSON());
      assert.doesNotMatch(text, /Kanbus|kanbus/, environment);
    }
  });
});
