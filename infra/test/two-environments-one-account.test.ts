import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as cdk from "aws-cdk-lib";
import { AccountGitHubDeployStack } from "../lib/account-github-deploy-stack";
import { buildDedicatedAccountStacks } from "../lib/dedicated-account-stacks";
import {
  ACCOUNT_DEPLOY_CREATES_OIDC_PROVIDER,
  ACCOUNT_DEPLOY_ROLE_NAMES,
  ACCOUNT_DEPLOY_STACK_IDS,
  CHATTICUS_CLOUD_ENVIRONMENTS,
  COMPUTER_IMAGE_TAGS,
  ENVIRONMENT_HOSTNAMES,
  KANBUS_BOARD_ENVIRONMENTS,
  COMPUTERS_STACK_IDS,
  CONTROL_PLANE_STACK_IDS,
  SNAPSHOT_STACK_IDS,
  peerEnvironmentsInSameAccount,
  stackIdsOfEnvironment,
  type ChatticusCloudEnvironment,
} from "../lib/environments";
import { applyStandardTags, stackTagsFor } from "../lib/tagging";
import { stubWebsiteDeploySource } from "../lib/web-bundle-stub";
import { normalizedTemplateText } from "./template-normalization";

const PRODUCTION_ACCOUNT_ENV = { account: "555555555555", region: "us-east-1" };
const BUDGETS_CONFIG = { monthlyLimitUsd: 125, notificationEmails: ["owner@example.com"] };
const SHARED_ACCOUNT_ENVIRONMENTS = CHATTICUS_CLOUD_ENVIRONMENTS;

interface TemplateResource {
  Type: string;
  Properties?: Record<string, unknown>;
}

type SynthesizedTemplates = Record<string, { Resources?: Record<string, TemplateResource> }>;

function synthesizeEnvironmentInSharedAccount(environment: ChatticusCloudEnvironment): SynthesizedTemplates {
  const app = new cdk.App();
  buildDedicatedAccountStacks(app, {
    env: PRODUCTION_ACCOUNT_ENV,
    environmentName: environment,
    budgetsConfig: BUDGETS_CONFIG,
    websiteDeploySource: stubWebsiteDeploySource,
  });
  new AccountGitHubDeployStack(app, ACCOUNT_DEPLOY_STACK_IDS[environment], {
    env: PRODUCTION_ACCOUNT_ENV,
    githubEnvironment: environment,
  });
  for (const stack of app.node.children.filter(cdk.Stack.isStack)) {
    applyStandardTags(stack, "Test Installation", environment);
  }
  const assembly = app.synth();
  return Object.fromEntries(
    assembly.stacks.map((stack) => [stack.stackName, stack.template as SynthesizedTemplates[string]]),
  );
}

const synthesized: Record<ChatticusCloudEnvironment, SynthesizedTemplates> = {
  development: synthesizeEnvironmentInSharedAccount("development"),
  staging: synthesizeEnvironmentInSharedAccount("staging"),
  production: synthesizeEnvironmentInSharedAccount("production"),
};

const ACCOUNT_LEVEL_STACK_NAMES = ["ChatticusBudgets"];
const LIVE_PRODUCTION_STACK_NAMES = [
  "ChatticusAccountDeploy",
  "ChatticusAuditTrail",
  "ChatticusAuthProduction",
  "ChatticusBudgets",
  "ChatticusComputers",
  "ChatticusControlPlaneProduction",
  "ChatticusEnvironmentCertificates",
  "ChatticusEnvironmentZones",
  "ChatticusSnapshots",
  "ChatticusThinTurnProduction",
  "ChatticusWebProduction",
];
const NEW_DEVELOPMENT_STACK_NAMES = [
  "ChatticusAccountDeployDevelopment",
  "ChatticusAuthDevelopment",
  "ChatticusBudgets",
  "ChatticusComputersDevelopment",
  "ChatticusControlPlaneDevelopment",
  "ChatticusEnvironmentCertificatesDevelopment",
  "ChatticusEnvironmentZonesDevelopment",
  "ChatticusSnapshotsDevelopment",
  "ChatticusThinTurnDevelopment",
  "ChatticusWebDevelopment",
];
const NEW_STAGING_STACK_NAMES = [
  "ChatticusAccountDeployStaging",
  "ChatticusAuthStaging",
  "ChatticusBudgets",
  "ChatticusComputersStaging",
  "ChatticusControlPlaneStaging",
  "ChatticusEnvironmentCertificatesStaging",
  "ChatticusEnvironmentZonesStaging",
  "ChatticusSnapshotsStaging",
  "ChatticusThinTurnStaging",
  "ChatticusWebStaging",
];

function stackNamesOf(environment: ChatticusCloudEnvironment): string[] {
  return Object.keys(synthesized[environment]).sort();
}

function resourcesOf(templates: SynthesizedTemplates, types: readonly string[]): Array<{ stack: string; id: string; resource: TemplateResource }> {
  return Object.entries(templates).flatMap(([stack, template]) =>
    Object.entries(template.Resources ?? {})
      .filter(([, resource]) => types.includes(resource.Type))
      .map(([id, resource]) => ({ stack, id, resource })),
  );
}

describe("development, staging and production in one AWS account", () => {
  it("builds every per-environment stack under that environment's own id", () => {
    for (const environment of SHARED_ACCOUNT_ENVIRONMENTS) {
      const expected = [
        ...stackIdsOfEnvironment(environment),
        ...ACCOUNT_LEVEL_STACK_NAMES,
        ...(environment === "production" ? ["ChatticusAuditTrail"] : []),
      ].sort();
      const actual = stackNamesOf(environment);
      for (const id of actual) {
        assert.ok(expected.includes(id), `${environment} built unexpected stack ${id}`);
      }
      for (const id of [
        SNAPSHOT_STACK_IDS[environment],
        COMPUTERS_STACK_IDS[environment],
        ACCOUNT_DEPLOY_STACK_IDS[environment],
      ]) {
        assert.ok(actual.includes(id), `${environment} is missing ${id}`);
      }
    }
  });

  it("gives every pair of environments disjoint stack names, sharing only the account-level budget stack", () => {
    for (const environment of SHARED_ACCOUNT_ENVIRONMENTS) {
      for (const peer of peerEnvironmentsInSameAccount(environment)) {
        const peerNames = stackNamesOf(peer);
        const shared = stackNamesOf(environment).filter((name) => peerNames.includes(name)).sort();
        assert.deepEqual(shared, [...ACCOUNT_LEVEL_STACK_NAMES].sort(), `${environment} and ${peer}`);
      }
    }
  });

  it("builds for production exactly the stacks the production account already holds, under their live names", () => {
    assert.deepEqual(stackNamesOf("production"), LIVE_PRODUCTION_STACK_NAMES);
  });

  it("builds for staging the suffixed copies", () => {
    assert.deepEqual(stackNamesOf("staging"), NEW_STAGING_STACK_NAMES);
  });

  it("builds for development the suffixed copies, which do not exist in this account yet", () => {
    assert.deepEqual(stackNamesOf("development"), NEW_DEVELOPMENT_STACK_NAMES);
  });

  it("names every stack of the three environments from the one set of id maps, with no development-only special case", () => {
    assert.deepEqual(
      stackIdsOfEnvironment("development").sort(),
      NEW_DEVELOPMENT_STACK_NAMES.filter((name) => name !== "ChatticusBudgets"),
    );
    for (const environment of ["development", "staging"] as const) {
      for (const stackId of stackIdsOfEnvironment(environment)) {
        assert.ok(stackId.endsWith(environment === "development" ? "Development" : "Staging"), stackId);
      }
    }
  });

  it("synthesizes the budget stack with the production tag on its resources, from the production build only", () => {
    const topics = resourcesOf({ budgets: synthesized.production.ChatticusBudgets }, ["AWS::SNS::Topic"]);
    assert.equal(topics.length, 1);
    const tags = (topics[0].resource.Properties as { Tags?: Array<{ Key: string; Value: string }> }).Tags ?? [];
    assert.equal(tags.find((tag) => tag.Key === "chatticus:environment")?.Value, "production");
  });

  it("takes the hostnames of the zones, the Cognito domain, the CloudFront alias and the CSP from the one hostname map", () => {
    for (const environment of SHARED_ACCOUNT_ENVIRONMENTS) {
      const { siteDomain, authDomain } = ENVIRONMENT_HOSTNAMES[environment];
      const templates = synthesized[environment];
      const zoneNames = resourcesOf(templates, ["AWS::Route53::HostedZone"]).map((entry) => entry.resource.Properties?.Name).sort();
      assert.deepEqual(zoneNames, [`${authDomain}.`, `${siteDomain}.`].sort(), environment);
      const cognitoDomains = resourcesOf(templates, ["AWS::Cognito::UserPoolDomain"]).map((entry) => entry.resource.Properties?.Domain);
      assert.deepEqual(cognitoDomains, [authDomain], environment);
      const distributions = resourcesOf(templates, ["AWS::CloudFront::Distribution"]).map(
        (entry) => (entry.resource.Properties as { DistributionConfig: { Aliases: string[] } }).DistributionConfig.Aliases,
      );
      assert.deepEqual(distributions, [[siteDomain]], environment);
      const policies = JSON.stringify(resourcesOf(templates, ["AWS::CloudFront::ResponseHeadersPolicy"]));
      assert.ok(policies.includes(`https://${authDomain}`), `${environment} CSP names ${authDomain}`);
      for (const other of SHARED_ACCOUNT_ENVIRONMENTS.filter((name) => name !== environment)) {
        assert.equal(policies.includes(ENVIRONMENT_HOSTNAMES[other].authDomain + " "), false);
      }
    }
    assert.equal(ENVIRONMENT_HOSTNAMES.development.authDomain, "auth-develop.chattic.us");
  });

  it("keeps resources with fixed names apart: no two environments claim the same account-wide name", () => {
    const fixedNamesOf = (templates: SynthesizedTemplates): Map<string, string> => {
      const names = new Map<string, string>();
      for (const { stack, id, resource } of resourcesOf(templates, [
        "AWS::IAM::Role",
        "AWS::IAM::ManagedPolicy",
        "AWS::Lambda::Function",
        "AWS::Cognito::UserPool",
        "AWS::Cognito::UserPoolDomain",
        "AWS::ECS::TaskDefinition",
        "AWS::CloudWatch::Alarm",
        "AWS::Scheduler::ScheduleGroup",
        "AWS::SSM::Parameter",
        "AWS::Route53::HostedZone",
        "AWS::SecretsManager::Secret",
        "AWS::S3::Bucket",
        "AWS::DynamoDB::Table",
        "AWS::SQS::Queue",
        "AWS::SNS::Topic",
        "AWS::ECR::Repository",
        "AWS::Logs::LogGroup",
      ])) {
        if (ACCOUNT_LEVEL_STACK_NAMES.includes(stack)) continue;
        for (const key of ["RoleName", "ManagedPolicyName", "FunctionName", "UserPoolName", "Domain", "Family", "AlarmName", "Name", "TopicName", "TableName", "QueueName", "BucketName", "RepositoryName", "LogGroupName"]) {
          const value = resource.Properties?.[key];
          if (typeof value === "string") names.set(`${resource.Type}/${key}/${value}`, `${stack}/${id}`);
        }
      }
      return names;
    };
    for (const environment of SHARED_ACCOUNT_ENVIRONMENTS) {
      const own = fixedNamesOf(synthesized[environment]);
      assert.ok(own.size > 0, "the scan found fixed names to compare");
      for (const peer of peerEnvironmentsInSameAccount(environment)) {
        const peerNames = fixedNamesOf(synthesized[peer]);
        const collisions = [...own.keys()].filter((name) => peerNames.has(name));
        assert.deepEqual(collisions, [], `${environment} and ${peer}`);
      }
    }
  });

  it("gives each environment that has the Kanbus board service its own API, bucket and table, and lets only its own two roles invoke it", () => {
    const apiNamesOf = (environment: ChatticusCloudEnvironment): string[] =>
      resourcesOf(synthesized[environment], ["AWS::ApiGatewayV2::Api"]).map(({ resource }) => String(resource.Properties?.Name));
    const invokeGrantsOf = (environment: ChatticusCloudEnvironment): Array<{ stack: string; roles: string[] }> =>
      resourcesOf(synthesized[environment], ["AWS::IAM::Policy"])
        .filter(({ resource }) => JSON.stringify(resource.Properties).includes("execute-api:Invoke"))
        .map(({ stack, resource }) => ({
          stack,
          roles: ((resource.Properties?.Roles ?? []) as Array<{ Ref: string }>).map((role) => role.Ref),
        }));
    for (const environment of SHARED_ACCOUNT_ENVIRONMENTS) {
      const hasService = KANBUS_BOARD_ENVIRONMENTS.includes(environment);
      assert.deepEqual(apiNamesOf(environment), hasService ? [`kanbus-${environment}-service`] : [], environment);
      const grants = invokeGrantsOf(environment);
      assert.equal(grants.length, hasService ? 2 : 0, `${environment} invoke grants`);
      for (const { stack, roles } of grants) {
        assert.equal(stack, CONTROL_PLANE_STACK_IDS[environment]);
        assert.equal(roles.length, 1);
        assert.match(roles[0], /^(FrontDoor|TurnExecutor)ServiceRole/);
      }
      const buckets = resourcesOf(synthesized[environment], ["AWS::S3::Bucket"]).filter(({ id }) => id.startsWith("Kanbus"));
      const tables = resourcesOf(synthesized[environment], ["AWS::DynamoDB::Table"]).filter(({ id }) => id.startsWith("Kanbus"));
      assert.equal(buckets.length, hasService ? 1 : 0, `${environment} Kanbus bucket`);
      assert.equal(tables.length, hasService ? 1 : 0, `${environment} Kanbus table`);
      for (const { resource } of [...buckets, ...tables]) {
        assert.equal(resource.Properties?.BucketName, undefined);
        assert.equal(resource.Properties?.TableName, undefined);
      }
      for (const peer of peerEnvironmentsInSameAccount(environment)) {
        const peerText = JSON.stringify(synthesized[peer][CONTROL_PLANE_STACK_IDS[peer]]);
        assert.ok(!peerText.includes(`kanbus-${environment}-`), `${peer} names nothing of ${environment}'s Kanbus service`);
      }
    }
  });

  it("runs each environment's owner task on its own image tag in its own repository and task definition family", () => {
    const taskDefinitionOf = (environment: ChatticusCloudEnvironment) => {
      const [{ resource }] = resourcesOf(synthesized[environment], ["AWS::ECS::TaskDefinition"]);
      return resource.Properties as { Family: string; ContainerDefinitions: Array<{ Image: unknown }> };
    };
    const development = taskDefinitionOf("development");
    const staging = taskDefinitionOf("staging");
    const production = taskDefinitionOf("production");
    assert.equal(production.Family, "ChatticusComputerOwner");
    assert.equal(staging.Family, "ChatticusComputerOwnerStaging");
    assert.equal(development.Family, "ChatticusComputerOwnerDevelopment");
    for (const environment of SHARED_ACCOUNT_ENVIRONMENTS) {
      const image = JSON.stringify(taskDefinitionOf(environment).ContainerDefinitions[0].Image);
      assert.match(image, new RegExp(`:${COMPUTER_IMAGE_TAGS[environment]}"`), environment);
      for (const other of SHARED_ACCOUNT_ENVIRONMENTS.filter((name) => name !== environment)) {
        assert.doesNotMatch(image, new RegExp(`:${COMPUTER_IMAGE_TAGS[other]}"`), `${environment} runs ${other}'s tag`);
      }
    }
    for (const environment of SHARED_ACCOUNT_ENVIRONMENTS) {
      const repositories = resourcesOf(synthesized[environment], ["AWS::ECR::Repository"]);
      assert.equal(repositories.length, 1);
      assert.equal(repositories[0].stack, COMPUTERS_STACK_IDS[environment]);
    }
  });

  it("gives the three environments three distinct image tags, with development keeping dev", () => {
    assert.deepEqual(COMPUTER_IMAGE_TAGS, { development: "dev", staging: "staging", production: "production" });
  });

  it("creates the GitHub OIDC provider in production's deploy stack only, and imports it in development's and staging's", () => {
    assert.deepEqual(ACCOUNT_DEPLOY_CREATES_OIDC_PROVIDER, { development: false, staging: false, production: true });
    const providers = SHARED_ACCOUNT_ENVIRONMENTS.flatMap((environment) =>
      resourcesOf(synthesized[environment], ["AWS::IAM::OIDCProvider"]).map((entry) => `${environment}:${entry.stack}`),
    );
    assert.deepEqual(providers, ["production:ChatticusAccountDeploy"]);
    const [{ resource }] = resourcesOf(synthesized.production, ["AWS::IAM::OIDCProvider"]);
    assert.equal(resource.Properties?.Url, "https://token.actions.githubusercontent.com");
    assert.deepEqual(resource.Properties?.ClientIdList, ["sts.amazonaws.com"]);
  });

  it("gives each environment its own deploy role name", () => {
    for (const environment of SHARED_ACCOUNT_ENVIRONMENTS) {
      const roleNames = resourcesOf({ [ACCOUNT_DEPLOY_STACK_IDS[environment]]: synthesized[environment][ACCOUNT_DEPLOY_STACK_IDS[environment]] }, ["AWS::IAM::Role"]).map(
        (entry) => entry.resource.Properties?.RoleName,
      ).filter((roleName) => !String(roleName).includes("integration-test"));
      assert.deepEqual(roleNames, [ACCOUNT_DEPLOY_ROLE_NAMES[environment]]);
    }
    assert.equal(new Set(Object.values(ACCOUNT_DEPLOY_ROLE_NAMES)).size, 3);
  });
});

describe("the OIDC deploy roles name only their own environment and deny the others (a bound on the roles themselves, not isolation: the shared bootstrap roles remain, see docs/PROMOTE_TO_MAIN.md)", () => {
  const IAM_TYPES = ["AWS::IAM::Role", "AWS::IAM::Policy", "AWS::IAM::ManagedPolicy"] as const;

  function iamTextOf(environment: ChatticusCloudEnvironment): Array<{ stack: string; id: string; text: string }> {
    const stacks: SynthesizedTemplates = Object.fromEntries(
      Object.entries(synthesized[environment]).filter(
        ([name]) => !ACCOUNT_LEVEL_STACK_NAMES.includes(name) && name !== ACCOUNT_DEPLOY_STACK_IDS[environment],
      ),
    );
    return resourcesOf(stacks, IAM_TYPES).map(({ stack, id, resource }) => ({ stack, id, text: JSON.stringify(resource) }));
  }

  function namesStack(text: string, stackId: string): boolean {
    return new RegExp(`${stackId}(?![A-Za-z])`).test(text);
  }

  it("lets no role or policy of one environment name another environment's resource", () => {
    for (const environment of SHARED_ACCOUNT_ENVIRONMENTS) {
      const own = iamTextOf(environment);
      assert.ok(own.length > 0, "the scan found roles and policies");
      for (const peer of peerEnvironmentsInSameAccount(environment)) {
        for (const entry of own) {
          assert.doesNotMatch(entry.text, new RegExp(peer, "i"), `${environment} ${entry.stack}/${entry.id} names ${peer}`);
          for (const peerStackId of stackIdsOfEnvironment(peer)) {
            assert.equal(namesStack(entry.text, peerStackId), false, `${entry.stack}/${entry.id} names ${peerStackId}`);
          }
        }
      }
    }
  });

  it("lets each OIDC deploy role allow nothing that names another environment, and deny the other two explicitly (not an isolation boundary)", () => {
    for (const environment of SHARED_ACCOUNT_ENVIRONMENTS) {
      const peers = peerEnvironmentsInSameAccount(environment);
      assert.equal(peers.length, 2);
      const policies = resourcesOf(
        { deploy: synthesized[environment][ACCOUNT_DEPLOY_STACK_IDS[environment]] },
        ["AWS::IAM::Policy"],
      ).filter((entry) => !entry.id.includes("IntegrationTest"));
      const statements = policies.flatMap(
        (entry) => (entry.resource.Properties as { PolicyDocument: { Statement: Array<{ Sid?: string; Effect: string }> } }).PolicyDocument.Statement,
      );
      const allowed = statements.filter((statement) => statement.Effect === "Allow");
      const denied = statements.filter((statement) => statement.Effect === "Deny");
      assert.deepEqual(allowed.map((statement) => statement.Sid).sort(), [
        "AssumeCdkBootstrapRoles",
        "ComputerImagePush",
        "EcrLoginToken",
        "ReadEnvironmentParameters",
        "ReadEnvironmentStacks",
        "ReadInvokeKeySecretVersions",
      ]);
      const allowedText = JSON.stringify(allowed);
      for (const peer of peers) {
        for (const peerStackId of stackIdsOfEnvironment(peer)) {
          assert.equal(allowedText.includes(`:stack/${peerStackId}/`), false, `${environment} role allows ${peerStackId}`);
        }
        assert.equal(allowedText.includes(`/chatticus/${peer}/`), false);
      }
      assert.deepEqual(denied.map((statement) => statement.Sid).sort(), [
        "DenyIdentityAndAccountAdministration",
        "DenyPeerEnvironmentParameters",
        "DenyPeerEnvironmentStacks",
        "DenyPeerEnvironmentTaggedResources",
      ]);
      const deniedText = JSON.stringify(denied);
      for (const peer of peers) {
        for (const peerStackId of stackIdsOfEnvironment(peer)) {
          assert.ok(deniedText.includes(`${peerStackId}/*`), `${environment} role denies ${peerStackId}`);
        }
        assert.ok(deniedText.includes(`/chatticus/${peer}/`), `${environment} role denies ${peer} parameters`);
      }
      for (const ownStackId of stackIdsOfEnvironment(environment)) {
        assert.equal(deniedText.includes(`:stack/${ownStackId}/`), false, `${environment} role must not deny its own ${ownStackId}`);
      }
      assert.equal(deniedText.includes(`/chatticus/${environment}/`), false);
      assert.ok(deniedText.includes(`"aws:ResourceTag/chatticus:environment":${JSON.stringify(peers)}`));
    }
  });

  it("tags every stack of an environment with that environment", () => {
    for (const environment of SHARED_ACCOUNT_ENVIRONMENTS) {
      for (const id of stackIdsOfEnvironment(environment)) {
        assert.equal(stackTagsFor(id, environment).environment, environment, id);
      }
    }
  });
});

describe("development's stacks are pinned to the committed templates of the shared-account design", () => {
  const FIXTURE_DIRECTORY = join(__dirname, "fixtures", "development-templates");
  const DEVELOPMENT_ENV = { region: "us-east-1" };
  const cdkJsonContext = JSON.parse(readFileSync(join(__dirname, "..", "cdk.json"), "utf8")).context as Record<string, unknown>;

  const developmentApp = new cdk.App({ context: cdkJsonContext });
  buildDedicatedAccountStacks(developmentApp, {
    env: DEVELOPMENT_ENV,
    environmentName: "development",
    websiteDeploySource: stubWebsiteDeploySource,
  });
  new AccountGitHubDeployStack(developmentApp, ACCOUNT_DEPLOY_STACK_IDS.development, {
    env: DEVELOPMENT_ENV,
    githubEnvironment: "development",
    description: "GitHub Actions development deploy role, importing the account's OIDC provider.",
  });
  for (const stack of developmentApp.node.children.filter(cdk.Stack.isStack)) {
    applyStandardTags(stack, "Test", "development");
  }
  const developmentAssembly = developmentApp.synth();

  for (const stackId of [
    "ChatticusSnapshotsDevelopment",
    "ChatticusComputersDevelopment",
    "ChatticusEnvironmentZonesDevelopment",
    "ChatticusEnvironmentCertificatesDevelopment",
    "ChatticusAccountDeployDevelopment",
  ]) {
    it(`synthesizes ${stackId} to the committed development template`, () => {
      assert.equal(
        normalizedTemplateText(developmentAssembly.getStackByName(stackId).template),
        readFileSync(join(FIXTURE_DIRECTORY, `${stackId}.template.json`), "utf8"),
      );
    });
  }

  it("uses the suffixed development stack ids and has the other two environments as peers", () => {
    assert.deepEqual(
      [SNAPSHOT_STACK_IDS.development, COMPUTERS_STACK_IDS.development, ACCOUNT_DEPLOY_STACK_IDS.development],
      ["ChatticusSnapshotsDevelopment", "ChatticusComputersDevelopment", "ChatticusAccountDeployDevelopment"],
    );
    assert.deepEqual(peerEnvironmentsInSameAccount("development"), ["staging", "production"]);
  });

  it("keeps the develop.chattic.us and auth-develop.chattic.us names, in zones its own stack creates", () => {
    const zones = developmentAssembly.getStackByName("ChatticusEnvironmentZonesDevelopment").template as SynthesizedTemplates[string];
    const names = resourcesOf({ zones }, ["AWS::Route53::HostedZone"]).map((entry) => entry.resource.Properties?.Name).sort();
    assert.deepEqual(names, ["auth-develop.chattic.us.", "develop.chattic.us."]);
  });

  it("imports the account's OIDC provider and owns only the suffixed deploy role and the development integration test role", () => {
    const template = developmentAssembly.getStackByName("ChatticusAccountDeployDevelopment").template as SynthesizedTemplates[string];
    assert.equal(resourcesOf({ template }, ["AWS::IAM::OIDCProvider"]).length, 0);
    assert.deepEqual(
      resourcesOf({ template }, ["AWS::IAM::Role"]).map((entry) => entry.resource.Properties?.RoleName).sort(),
      ["chatticus-github-actions-deploy-development", "chatticus-github-actions-integration-test-development"],
    );
  });
});

describe("production keeps the stacks, logical ids and resource names it was deployed with", () => {
  const FIXTURE_DIRECTORY = join(__dirname, "fixtures", "production-templates");
  const PRODUCTION_ENV = { region: "us-east-1" };
  const cdkJsonContext = JSON.parse(readFileSync(join(__dirname, "..", "cdk.json"), "utf8")).context as Record<string, unknown>;

  const productionApp = new cdk.App({ context: cdkJsonContext });
  buildDedicatedAccountStacks(productionApp, {
    env: PRODUCTION_ENV,
    environmentName: "production",
    websiteDeploySource: stubWebsiteDeploySource,
  });
  new AccountGitHubDeployStack(productionApp, ACCOUNT_DEPLOY_STACK_IDS.production, {
    env: PRODUCTION_ENV,
    githubEnvironment: "production",
    description: "GitHub Actions OIDC provider and production deploy role for this environment account.",
  });
  for (const stack of productionApp.node.children.filter(cdk.Stack.isStack)) {
    applyStandardTags(stack, "Test", stack.node.id === ACCOUNT_DEPLOY_STACK_IDS.production ? undefined : "production");
  }
  const productionAssembly = productionApp.synth();

  for (const stackId of [
    "ChatticusSnapshots",
    "ChatticusComputers",
    "ChatticusEnvironmentZones",
    "ChatticusEnvironmentCertificates",
    "ChatticusAccountDeploy",
  ]) {
    it(`synthesizes ${stackId} to the committed production template`, () => {
      assert.equal(
        normalizedTemplateText(productionAssembly.getStackByName(stackId).template),
        readFileSync(join(FIXTURE_DIRECTORY, `${stackId}.template.json`), "utf8"),
      );
    });
  }

  it("keeps the production zones' and certificates' hostnames, the delegation the live name servers depend on", () => {
    const zones = productionAssembly.getStackByName("ChatticusEnvironmentZones").template as SynthesizedTemplates[string];
    const names = resourcesOf({ zones }, ["AWS::Route53::HostedZone"]).map((entry) => entry.resource.Properties?.Name).sort();
    assert.deepEqual(names, ["auth.chattic.us.", "hey.chattic.us."]);
  });

  it("owns the GitHub OIDC provider and the unsuffixed deploy role it already has", () => {
    const template = productionAssembly.getStackByName("ChatticusAccountDeploy").template as SynthesizedTemplates[string];
    assert.equal(resourcesOf({ template }, ["AWS::IAM::OIDCProvider"]).length, 1);
    assert.deepEqual(
      resourcesOf({ template }, ["AWS::IAM::Role"]).map((entry) => entry.resource.Properties?.RoleName),
      ["chatticus-github-actions-deploy"],
    );
  });
});
